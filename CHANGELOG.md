# Changelog

## Unreleased

### Security
- Reject cross-site state-changing requests. Mutating endpoints previously
  accepted form-encoded bodies, which let any web page a user visited run a
  root shell command inside their machines via `/exec`. See
  [`SECURITY.md`](SECURITY.md).

### Fixed
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
- Fleet views are built in parallel; each machine costs two Docker inspects
  and a bridge probe, which was serial and did not scale.
- Bridge health probes use `requests` instead of spawning a `curl` per machine
  per refresh.
