# Changelog

## Unreleased

### Changed — deskswarm hands out computers instead of running agents

deskswarm no longer drives agent sessions itself. Each machine now exposes its
own **MCP endpoint** at `/mcp/<slug>`, reached with a key issued from that
machine's access panel, and you point whatever MCP client you already use at
it. The client brings the model; deskswarm brings the computer.

**Added**

- Per-machine MCP endpoints (Streamable HTTP, stateless): `initialize`,
  `tools/list`, `tools/call`, `ping`.
- Per-machine keys — `POST /api/v1/computers/<id>/keys`, `GET /api/v1/keys`,
  `DELETE /api/v1/keys/<id>`. A key names one machine at issue and cannot be
  widened; revoking is complete. Deleting a machine deletes its keys.
- A tool surface covering the whole machine: screen (`screenshot`, `click`,
  `double_click`, `move_mouse`, `drag`, `scroll`, `type_text`, `press_key`,
  `hotkey`, `launch_app`, `screen_size`), `shell` as root, the home directory
  (`list_files`, `read_file`, `write_file`), the clipboard, and `inventory`.
- `type_text` routes non-Latin text (Arabic, Chinese, emoji) through the
  clipboard automatically. The keyboard path drops those characters silently,
  so this is the difference between text appearing and an empty window.
- A sleeping machine wakes on the first MCP call that needs it — an outside
  client has no wake button. `DESKSWARM_MCP_AUTO_WAKE` turns it off.
- Live monitoring: the wall outlines a machine an outside client is working in
  and captions it with the last tool called; `/partials/activity` logs every
  call with client, machine, tool and result. Contents are counted, not kept.
- `GET /mcp/<slug>/info` — keyless discovery of a machine's protocol versions
  and tool names.

**Removed**

- Tasks, schedules, analytics, cost tracking, the failure breaker and the
  `run_task.py` worker. The `tasks` and `schedules` tables are dropped on
  first start — **back up `fleet.db` before upgrading if you want that
  history**.
- `DESKSWARM_MODEL`, `DESKSWARM_API_KEY`, `DESKSWARM_API_BASE`,
  `DESKSWARM_TASK_TIMEOUT`, `DESKSWARM_MAX_CONCURRENT_TASKS`,
  `DESKSWARM_DAILY_COST_LIMIT`, `DESKSWARM_FAILURE_BREAKER`,
  `DESKSWARM_BREAKER_COOLDOWN_MIN`. deskswarm makes no outbound model calls,
  so there is no key to give it.
- The cua agent SDK venv from the dashboard image — about 300 MB, and Python
  with it. The bridge still uses `cua-computer-server`, unchanged.
- The legacy Flask dashboard (`dashboard/`) and its pytest suite: it shared one
  database with this one and expects tables that no longer exist. CI now builds
  and tests `dashboard-ts`.

**Changed — the wall**

- Tiles now carry the facts rather than only a picture: the state as a word
  (`in use` / `idle` / `asleep` / `down`), what an outside client is doing and
  who is doing it, how many live keys reach the machine, and its image and
  port. A desktop shrunk to a thumbnail is unreadable, so the screen is now
  the smaller half of the tile and answers only "is anything on screen".
- **A machine with no key is called out.** It is running, reachable and
  useless — nothing can talk to it — and it looked exactly like a working one.
- A summary line above the wall: how many machines are in each state, how many
  live keys exist, and how many machines have none.
- A legend explaining every state, dismissible and brought back with `?`.
- Actions are on the tile instead of behind a hover, since half of them are how
  you recover a machine that is down. The rarer ones moved into a `···` menu.
- The empty state now walks through add → issue a key → point a client at it.

**Fixed** (all found driving the thing, not by the tests)

- Choosing wall size S or L silently reverted to M at the next 5s refresh, and
  the wall filter forgot itself on the same beat. The re-apply ran on
  `htmx:afterSwap`, and htmx's settle step — which runs after it — restores
  attributes on the swapped content, throwing the change away. Moved to
  `htmx:afterSettle`. Same family as the bug that put the default columns in
  the template; this was the other half of it.

- Uploading a file into a machine hung for ever and took the dashboard with
  it. `docker-modem` writes a Buffer with an explicit `Content-Length` and
  ends the request itself, but pipes a stream and leaves the pipe to end it —
  and under Bun that end never arrives, so the socket was never released and
  every later Docker call queued behind it. Affected the dashboard's own file
  upload too, not just MCP.
- `launch_app` started programs inside the *bridge* container against the
  throwaway Xvfb it keeps for pynput's sake, so the desktop never changed and
  the bridge reported success anyway. It now launches in the machine's own
  session, as the desktop user.
- `launch_app` reported success for a program that is not installed. It now
  checks first and says so.

**Changed**

- A **reserved** machine now refuses to issue keys, rather than being skipped
  by fleet-wide dispatch. Keys already issued keep working.
- Sleep returns `409` if an MCP client has called the machine recently;
  `?force=1` overrides.
- The idle sweeper counts a recent MCP call as "in use", as it used to count a
  running task.

### Security
- Reject cross-site state-changing requests. Mutating endpoints previously
  accepted form-encoded bodies, which let any web page a user visited run a
  root shell command inside their machines via `/exec`. See
  [`SECURITY.md`](SECURITY.md).

### Fixed
- The bridge could not survive a stop and start: Xvfb leaves `/tmp/.X99-lock`
  behind when killed, a stopped container keeps its filesystem, and the next
  start died with "Server is already active for display 99" and crash-looped.
  Every machine that slept and woke hit this.
- Tasks orphaned by a dashboard restart stayed `RUNNING` for ever, leaving the
  machine shown as busy and the task unresolved. They are now failed at
  container start, before workers fork.
- Concurrent machine creation could pick the same noVNC port; port allocation
  is now serialised.
- The wall lost its grid columns whenever the JS that applied them lost the
  race with htmx's initial load, making every tile full-width.
- Wall tiles rendered no image on first paint, and a failed capture painted
  its `alt` text over the machine's name.

### Added
- A persistent home for every machine — a named volume on `/home/cua`, seeded
  from the image so a new machine still gets its skeleton and ownership. A
  restart no longer throws away what you were doing; only deleting the machine
  removes it.
- Files in and out: upload to any machine (owned by the desktop user, not
  root), browse its home, and download a file or a whole directory.
- Copy and paste between the browser and a machine, with an option to press
  the text into the focused window. This is what makes Arabic and other
  non-Latin input work at all — keysym-based typing silently drops most of
  those characters.
- Sleep and wake, manual or after N idle minutes (off by default). A sleeping
  machine costs no memory or CPU and keeps its files; its X session does not
  survive, so this is opt-in. Clicking a sleeping machine — or dispatching a
  task to it — wakes it first.
- Per-machine memory, CPU and PID caps, so one machine cannot starve the rest.
  Hosts without the cgroup controllers delegated are detected on the first
  machine started and run uncapped rather than refusing to start anything.
- Backups: a gzipped archive of a machine's home, on demand or nightly, with
  restore. Restore replaces rather than merges, stops the machine while it
  works, and treats an uploaded archive as untrusted — members that escape the
  home directory are dropped, not unpacked.
- Share links: one machine, an expiry, a revoke. `watch` serves the screen
  through the link and is fully revocable; `control` embeds noVNC and hands
  over the machine's screen password, which rotating the password retracts.
- An audit log covering every state-changing request and every share view,
  written by a single `after_request` hook so no endpoint can be missed.
- Guards for the failures that accumulate quietly: a daily cost cap, memory
  admission control, disk thresholds with a safe space reclaim, and a breaker
  that pauses dispatch after repeated failures.
- Reserve a machine for yourself; fleet-wide dispatch and schedules skip it.
- Per-machine restart, so a machine whose containers died can be recovered in
  place instead of deleted and recreated.
- Click a row in the task log for the full report — every step the agent took,
  the untruncated result or error, duration and cost.
- Test suite and CI. `tests/test_security.py` fails against the pre-fix code.
- A ceiling on concurrent tasks (`DESKSWARM_MAX_CONCURRENT_TASKS`, default 8)
  so a fleet-wide dispatch drains instead of starting everything at once.

### Changed
- `dashboard/app.py` is 61 lines instead of 1,957. The routes moved into nine
  blueprints under `dashboard/routes/`, and the logic they called into a
  layer of modules beside them — settings, schema, security, machines, tasks,
  screens, scheduler. Nothing imports upwards and there are no cycles; the
  `url_map` is byte-identical either side of the split.
- The bridge image is built in two stages: 1.42 GB -> 762 MB. The toolchain
  needed to compile evdev was shipping in the runtime image (~680 MB of apt
  packages including LLVM, gcc and g++) along with playwright's browser driver
  payload, which the VNC backend never calls.
- The per-machine memory estimate is 400 MB, not 300. A machine is two
  containers and the earlier figure counted only the desktop, under-committing
  the budget by about a third.
- Fleet views are built in parallel; each machine costs two Docker inspects
  and a bridge probe, which was serial and did not scale.
- Bridge health probes use `requests` instead of spawning a `curl` per machine
  per refresh.
- The scheduler thread no longer starts under test
  (`DESKSWARM_DISABLE_SCHEDULER`); it wrote to a database whose directory the
  fixture was tearing down, which failed in whichever test happened to be
  running at the time.
- Stopped machines are no longer probed or screenshotted. Each one previously
  burned a full HTTP timeout per tile per refresh, which on a wall of sleeping
  machines took longer than the refresh interval itself.
