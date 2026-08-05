# Known upstream issue: `cua-computer-server` VNC backend

**Affects:** `cua-computer-server` 0.3.42 (and likely nearby versions)
**Status:** worked around in this repo (see `bridge/entrypoint.sh`); not yet reported upstream.

## Symptom

When running `python -m computer_server --backend vnc --vnc-host ... --vnc-port ... --vnc-password ...`,
the server starts and reports success, but every `screenshot` (and by extension
every action the cua Agent takes based on a screenshot) silently operates on a
**blank, unrelated local display** instead of the intended VNC target. There is
no error — `/cmd screenshot` returns `"success": true` with a real-looking but
wrong image.

Symptoms observed:
- An agent describes the desktop as "completely black" even though the actual
  desktop (verified via `docker exec ... ps aux` and a direct noVNC connection)
  has a fully running XFCE session, open windows, etc.
- The image returned by `/cmd screenshot` is small (~2–3 KB) and identical
  across unrelated containers/desktops.

## Root cause

Two separate bugs compound:

1. **CLI flags alone don't select the VNC backend.**
   `computer_server/handlers/factory.py` reads the backend choice from
   `os.environ.get("CUA_BACKEND", "native")` — not from any value passed
   directly by the CLI parser. `computer_server/cli.py` does set
   `os.environ["CUA_BACKEND"] = "vnc"` when `--backend vnc` is passed, but
   because `computer_server/__init__.py` unconditionally does
   `from .server import Server`, and that import chain reaches
   `HandlerFactory.create_handlers()` (called once, at import time, in
   `main.py`) **before** `cli.py`'s `main()` function body ever runs, the
   handler is already bound to the native (local-OS) handler by the time the
   env var is set. The result: `--backend vnc` is silently ignored and the
   **native handler** (pynput/PIL against whatever `DISPLAY` the process has)
   is used instead — with no error, because the native handler happily
   captures *something*, just not the right thing.

   **Fix:** set `CUA_BACKEND`, `CUA_VNC_HOST`, `CUA_VNC_PORT`, and
   `CUA_VNC_PASSWORD` as real process **environment variables** before
   `python -m computer_server` is even invoked (e.g. in a wrapper shell
   script, or `docker-compose.yml` `environment:`), not just as CLI flags.
   See `bridge/entrypoint.sh` in this repo.

2. **Undeclared runtime dependencies.**
   Once the VNC backend is actually selected, `computer_server/handlers/vnc.py`
   does a *lazy* `from twisted.internet import defer, reactor` and
   `from vncdotool.client import VNCDoToolFactory` inside the methods that use
   them. Neither `twisted` nor `vncdotool` is listed in
   `cua-computer-server`'s declared dependencies (`pip show cua-computer-server`
   → `Requires: aiohttp, cua-auto, cua-core, fastapi, fastmcp, grpcio, pillow,
   playwright, protobuf, pydantic, pynput, pyperclip, python-xlib, pywinctl,
   uvicorn, websockets` — no `twisted`, no `vncdotool`). Without them
   installed, `screenshot()` catches the `ModuleNotFoundError` internally and
   returns `{"success": false, "error": "... No module named 'twisted'"}`
   for that call, but — combined with bug (1) — most integrations never see
   this because they're silently on the native handler already and this
   branch never executes.

   **Fix:** install `twisted` and `vncdotool` explicitly alongside
   `cua-computer-server`. See `bridge/Dockerfile`.

## Also worth knowing

`computer_server/handlers/factory.py` unconditionally imports the OS-specific
native handler at **module import time** regardless of which backend you
asked for:

```python
elif OS_TYPE == "linux":
    from .linux import LinuxAccessibilityHandler, LinuxAutomationHandler
```

`handlers/linux.py` imports `pynput`, which fails at import time if `DISPLAY`
is unset or points to a display with no running X server
(`ImportError: this platform is not supported: ('failed to acquire X
connection: Bad display name ""', ...)`). This means **even a pure VNC-backend
deployment needs a throwaway X server** (e.g. `Xvfb`) just to satisfy this
import, whether or not it's ever used. `bridge/entrypoint.sh` starts a
headless `Xvfb :99` for exactly this reason.

## Reproducing

```bash
# From inside a container/host with cua-computer-server installed but
# WITHOUT twisted/vncdotool, and WITHOUT the env vars pre-set:
python -m computer_server --host 127.0.0.1 --port 8000 \
  --backend vnc --vnc-host 127.0.0.1 --vnc-port 5901 --vnc-password secret

curl -X POST http://127.0.0.1:8000/cmd \
  -H 'Content-Type: application/json' \
  -d '{"command":"screenshot","params":{}}'
# → "success": true, with a small, wrong image (native handler was used)

# Now install twisted+vncdotool and retry the SAME command
# (still no env vars, backend still not really selected):
curl -X POST http://127.0.0.1:8000/cmd ...
# → "success": true, still wrong — because the handler was already bound

# Now restart the server with CUA_BACKEND/CUA_VNC_HOST/etc. exported as
# real env vars before the process starts, WITHOUT twisted/vncdotool:
curl -X POST http://127.0.0.1:8000/cmd ...
# → "success": false, "VNC screenshot error: No module named 'twisted'"
# (backend correctly selected this time — the real bug surfaces)

# With env vars set AND twisted+vncdotool installed:
curl -X POST http://127.0.0.1:8000/cmd ...
# → "success": true, correct full screenshot of the real VNC target
```

## Upstream

Filed as [trycua/cua#2869](https://github.com/trycua/cua/issues/2869). If
you hit this too, a 👍 or a comment with your own repro helps get it
prioritized.
