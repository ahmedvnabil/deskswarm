# Contributing

## Running it locally

```bash
cp .env.example .env          # set DESKSWARM_MODEL / DESKSWARM_API_KEY
docker compose up -d --build
pytest tests -q
```

The fleet starts empty. Add a machine from the UI — the first one builds the
bridge image (about a minute), later ones take about a second.

## Layout

| Path | What it is |
|---|---|
| `dashboard/app.py` | HTTP layer: routes, tasks, schedules, analytics |
| `dashboard/fleet.py` | The only module that talks to Docker |
| `dashboard/run_task.py` | One task, one subprocess, using the cua SDKs |
| `dashboard/reclaim.py` | Startup sweep for tasks orphaned by a restart |
| `bridge/` | cua-computer-server in VNC-backend mode |

## Things worth knowing before you change something

**Layout and image sources belong in the template, not in JS run after the
swap.** The wall lost its grid columns and its screenshots twice because both
were applied by JavaScript on `htmx:afterSwap`, which sometimes lost the race
with htmx's initial load. Both bugs only showed up on a real deployment.

**The provisioning shell runs as root; the desktop session runs as `cua`.**
Launching a GUI app over `/exec` leaves root-owned files in `/home/cua` and
that app then refuses to start for the desktop user. Finish provisioning with
`chown -R cua:cua /home/cua`. A headless CLI check will pass while the GUI
path is broken, so test the GUI path.

**The scheduler runs in every gunicorn worker.** Claiming a due schedule is a
conditional `UPDATE` on `next_run_at` so only one worker can dispatch it. Keep
it that way, or schedules fire twice.

**Anything that mutates state must survive the CSRF guard.** See
[`SECURITY.md`](SECURITY.md). Send JSON, from the same origin.

## Pull requests

Keep them small, explain what you actually verified, and add a test when you
fix a bug. `pytest tests -q` must pass; CI runs it plus a container build.
