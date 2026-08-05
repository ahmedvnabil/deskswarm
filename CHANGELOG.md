# Changelog

## Unreleased

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
