# Managed Agents — first release

DeskSwarm runs one bounded tool loop per desktop in the dashboard process.
It uses the same native Driver and machine-provider tools as external MCP.
There is no old control bridge or Python agent runtime.

## Configure and run

1. Open `/agents` and expand **Model connections**.
2. Enter a display name, exact provider model ID, base URL ending in `/v1`
   where appropriate, and choose Responses or Chat Completions. Use Responses
   for models that require it. Your endpoint must support function calling.
3. Enter the provider key; leave it empty for a local endpoint that needs none.
   On edit, an empty key retains the existing key. Disable screenshots for
   models without vision support.
4. Choose a desktop, model connection and task. Describe desired output files.
5. Follow activity and the desktop preview. Open the full viewer if needed.
6. Download the result bundle after execution stops. It includes `report.md`,
   `activity.json` and the files copied by the agent's `save_result` tool.

Desktop screenshots and tool/file content are sent to the selected provider.
Provider billing applies. Only use a trusted endpoint. All signed-in dashboard
users share fleet and model administration privileges, as with existing fleet
management; this release does not introduce per-user isolation.

Keys are encrypted with AES-256-GCM and never returned by the settings API.
The master key is `/app/data/.agent-secret-key` (beside the configured SQLite
DB), mode 0600. Back up this key **together with the database** and
`agent-results/`; machine home backups alone do not contain Agents state.
Changing a connection affects subsequent runs; an already started worker keeps
its selected configuration. Remove and recreate a connection to clear its key.

## Ownership, stop and takeover

A SQLite partial unique index permits one leased run per desktop. A leased run
blocks another run, dashboard machine mutations and MCP tool calls from existing
keys. Idle suspension skips leased desktops. Other desktops remain independent.

**Stop agent** aborts a model request and prevents the next action. A running
shell is given a dedicated process group and receives TERM. Other in-flight
operations must finish or time out before the lease is released. Driver session
cleanup also finishes before another run can start. **Take control** follows the
same drain procedure and marks the desktop reserved for manual use. Use
**Release manual control** when finished. Existing MCP keys are refused while
the machine is manually reserved, including keys issued before takeover.

The app viewer uses `view_only=true` while an agent owns the machine. This is a
viewer setting, not an OS lock: a person holding the raw VNC password, an
already-open interactive VNC session, a host Docker administrator or a process
inside the desktop can still interfere. Close other controlling sessions before
starting an agent. This release is intended for trusted, single-host operation.

Default limits: 30 model turns and 300 seconds; configurable per run up to 100
turns / 900 seconds. A model HTTP request times out after 60 seconds; shell
commands have a 60-second timeout plus a two-second termination grace. Other
provider operations retain their existing bounded deadlines. Run time limits
stop new actions; they do not release control while an action is still draining.
Detached processes started by a command are not a secure job sandbox.
Saved files are limited to 32 MB each, 64 MB / 32 files per run. Results and
history persist until the administrator manages the data volume; there is no
automatic results retention policy in this release.

Run **one dashboard process per data volume**. After a dashboard restart, leased
runs become `interrupted`; tasks are never replayed automatically. Ownership is
retained for at least 65 seconds for bounded shell actions to drain, then a human
must choose Stop or Take control. Inspect the actual desktop before continuing.

## Optional local Codex provider

For a local test without a separate API key, an already signed-in host Codex CLI
can serve as the model backend. This helper runs on the host, separately from the dashboard service.
It requires Bun and the current Codex CLI with `codex login status` succeeding.
It starts ephemeral read-only CLI sessions with host shell tools disabled and
returns tool choices to DeskSwarm; desktop actions execute inside the selected
Linux container. Host login credentials are not copied into Docker.

```sh
export DESKSWARM_CODEX_GATEWAY_TOKEN="$(openssl rand -hex 32)"
bun run dashboard-ts/scripts/local-codex-provider.ts
```

The helper binds `127.0.0.1:8789` by default, requires that token and accepts one
request at a time. Configure a Chat Completions connection with base URL
`http://127.0.0.1:8789/v1`, model `default`, and that token as its API key when
running the dashboard on the host. For Docker, use the host address reachable
from that runtime (for example `host.docker.internal`) and configure
`DESKSWARM_CODEX_GATEWAY_HOST` only on a trusted local network. Binding
`0.0.0.0` exposes the listener to that network; keep the random token private,
use host firewall controls, and stop the helper when it is no longer needed.
The Colima test reached the host helper through `host.docker.internal` while
keeping its listener on `127.0.0.1`. Try the loopback default before widening
the bind address. `DESKSWARM_CODEX_BIN` overrides the CLI executable; the gateway port is set by
`DESKSWARM_CODEX_GATEWAY_PORT`. The helper is optional, single-concurrency and
subject to the signed-in account's usage limits. CLI flags may change across
versions. Normal configured API providers do not require this helper.

## Validation — 2026-10-24

Tested on one actual Linux ARM64 desktop under Colima, native Cua Driver 0.38.0,
with the Bun dashboard in Docker and its persistent data volume:

- A real signed-in Codex model, through the optional host gateway, chose
  `write_file`, `read_file` and `save_result` over four turns. The dashboard
  completed the run and downloaded the archive. Its `agents-pilot.txt` contained
  exactly `مرحبًا من DeskSwarm — Agent يعمل على Linux` plus a final newline
  (60 UTF-8 bytes), verified from the downloaded tar member.
- A second real Codex task was started through the browser UI on the final
  dashboard image. The downloaded `ui-agent-check.txt` matched `اختبار` exactly
  (12 UTF-8 bytes, no newline). The UI also completed takeover and manual release.
  Live duplicate-run and dashboard shell requests returned 409 while owned.
- Separate deterministic HTTP model fixtures launched actual `sleep 30` shell
  actions followed by a file write. Stop and takeover each released control in
  under one second after cancellation. We waited beyond the original command
  duration: no late file appeared and no subsequent model request occurred.
  Takeover reserved the machine, and releasing manual control restored it.
- Unit/integration tests cover encrypted/write-only keys, exclusive ownership,
  existing MCP refusal, read-only viewer URLs, verified Arabic output bundles,
  step exhaustion, restart recovery, Responses tool/reasoning payloads and the
  race between in-flight shell completion and Driver cleanup, and waiting for
  an already-running external MCP operation before accepting a managed run.
  The full suite passed 248 tests; TypeScript checking and the dashboard Docker
  build also passed.
- Earlier native Driver acceptance separately verified mouse, keyboard, Arabic,
  drag selection and application scroll state. This release retains that path.

Live evidence and credentials are kept outside Git in the local `.local/`
validation folder. Tests use isolated temporary SQLite databases; run them from
`dashboard-ts/` so its preload config applies.

## Deployment and rollback

Rebuild/restart only the dashboard; existing desktops keep their native Driver
and home volumes. Before downgrading, stop active agents and back up the data
volume (database, master key and results). Returning to `4bcacce` restores the
external-MCP-only dashboard; new `agent_*` tables remain unused and can be kept
for a later upgrade. Do not delete machine volumes. This rollback does not
restore the removed legacy bridge.
