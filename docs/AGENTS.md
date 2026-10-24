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

## After moving the dashboard to Linux

Model settings move with the database and encryption key; a host CLI login does
not. `host.docker.internal` points at the new Docker host, not the computer that
previously ran the dashboard. Check `codex login status` or `claude auth status`
on the replacement host before treating a CLI connection as usable. An installed
CLI alone is not an authenticated provider.

For independent operation, sign in on the trusted Linux host using the provider's
supported flow, then run the restricted model gateway there, or configure a normal
API provider in Model connections. Never silently copy a personal CLI auth file
into a desktop or dashboard container. See [official Codex authentication](https://learn.chatgpt.com/docs/auth)
for device-code login on a headless host. The built-in API connections currently
accept Responses or Chat Completions; Claude Code can use the private adapter described below. An Anthropic Messages
endpoint still needs an adapter rather than being entered as a Chat endpoint.

A temporary operator-assisted test can reuse an already signed-in local Codex
CLI through a pinned SSH reverse Unix socket. A token-protected gateway remains
on local loopback; a relay on the dashboard's private Docker network forwards
requests over the SSH socket. No relay ports should be published. The relay only
transports model requests: desktop actions still execute on the selected Linux
computer. Keep the random gateway token encrypted in Model connections. This
path depends on the operator's computer and SSH session; label it clearly and do
not describe it as an independent server login. If the connection is retired,
stop the relay and SSH session and update or remove that model connection.

## Live validation through Cloudflare and NetBird — 2026-10-24

A real signed-in Codex CLI was connected through the private SSH path after the
control plane moved to a permanent Linux CT. One remote desktop was used for all
runs through the deployed Worker URL:

- The model inspected the actual hostname, OS and disk, wrote a UTF-8 Markdown
  report, read it back, and saved it for download. The downloaded archive contained
  the real report and matching Arabic text, plus activity and summary files.
- A second managed run on the owned desktop was rejected with HTTP 409.
- The Stop and Take control buttons were exercised in the browser. Stopped and
  taken-over runs released their leases after cleanup; both retained downloadable
  partial reports. Manual reservation rejected another managed run until released.
- In-flight shell cancellation was checked using separate start/completion files.
  After the stop or takeover, the start file existed and the completion file did
  not. The desktop was left with no active run or manual reservation.

This validation found that `setsid` can fork when Docker exec starts it as a
process-group leader. Without `--wait`, the action could appear complete while
its shell continued, so a later stop missed it. The runner now waits for the
session, retains ownership while it runs, and terminates the recorded run-specific
process group on cancellation. A real Linux regression test forces that fork
path and verifies both attachment and termination; mock-only tests cannot detect
this behavior. All 307 tests and the TypeScript check passed after the fix.

## Independent Codex on the Linux control-plane host

The same restricted CLI provider can run on the trusted Linux host rather than
on an operator's computer. Use a dedicated service account and its own persistent
home/CODEX_HOME. Start `codex login --device-auth` as that account and complete the
OpenAI device approval in the browser. Keep its auth cache mode 0600 and its home
mode 0700; the dashboard and desktop containers do not need that auth cache.

Run `scripts/local-codex-provider.ts` with Bun under the same service account.
Give it a random gateway token, `DESKSWARM_CODEX_BIN`, and a bind address reachable
only on the dashboard's private Docker bridge. Keep the token in a root-readable
service environment file and encrypted Model connections storage. Configure the
model connection to the private gateway's `/v1` URL using Chat Completions and
model `default`. A systemd service can restart the provider after failure and
start at boot. Its environment must explicitly set the service user's HOME,
CODEX_HOME and PATH; file access must permit Codex to refresh its own auth cache.
No public gateway listener or reverse SSH tunnel is needed.

On the deployed CT, the provider runs as `deskswarm-codex` under
`deskswarm-codex-provider.service`, with startup enabled. It uses the existing
restricted CLI invocation: ephemeral read-only sessions, no host shell tools,
and desktop actions returned to DeskSwarm for execution on the selected desktop.
The service has a private temporary directory, no-new-privileges, a read-only
system filesystem, a writable dedicated home and bounded memory/process count.
Inspect service state and `codex login status` as the service account when
troubleshooting; do not print its auth file or environment token.

Independent live validation: the prior Mac relay container was stopped and the
Mac reverse SSH tunnel terminated **before** starting a new real Codex Agent run
through Cloudflare. Process inspection showed the CLI running under the dedicated
CT service user. The model inspected the desktop, wrote a UTF-8 Markdown report,
read it back and saved it; the completed run's downloaded archive contained the
verified Arabic report. No operator-host gateway participated in that run.


## Independent Claude Code alongside Codex

Run `scripts/local-claude-provider.ts` with Bun on the trusted Linux control-plane
host. Create a separate service user with a persistent HOME and CLAUDE_CONFIG_DIR,
then run `claude auth login --claudeai` as that user and complete the official
browser approval. On a remote host, keep stdin interactive while pasting the
one-time callback code; do not copy a laptop auth cache. Verify `claude auth status`
as the service user. See [Claude authentication](https://code.claude.com/docs/en/authentication).

Set DESKSWARM_CLAUDE_GATEWAY_TOKEN to a random secret of at least 32 characters,
DESKSWARM_CLAUDE_GATEWAY_HOST to the private Docker bridge address,
DESKSWARM_CLAUDE_GATEWAY_PORT (default 8790), and optionally DESKSWARM_CLAUDE_BIN.
Use a boot-enabled service with the same hardening and dedicated writable home
as the Codex service. Keep auth outside dashboard/desktop containers. The gateway
requires a token for health checks and inference, serializes requests, and uses
restricted CLI sessions with host tools, MCP servers, hooks and persistence disabled.
It supplies inline desktop screenshots and converts structured output to Chat
Completions function calls; DeskSwarm executes those calls on the selected desktop.

Add a second Model connection using the private `/v1` URL, Chat Completions,
model `default`, vision enabled, and the gateway token. The Agents model selector
can then switch between Claude and Codex without replacing either connection.
Removing this model connection and stopping its service leaves Codex available.

### Deployment architecture

This is one application with two deployment layers. The Cloudflare Worker and
Durable Object provide the public gateway; the full dashboard, authoritative
SQLite database, files and agent runner live on CT 401. The origin and Worker
URLs reach the same application and data. Claude and Codex are separate private
model services on that CT, each with its own login and service account. Neither
requires a running laptop or reverse SSH relay.


Live Claude validation on 2026-10-24: independent login succeeded under
`deskswarm-claude`; the boot-enabled private service on port 8790 ran alongside
Codex on 8789 with the former Mac relay stopped. Through the public Worker URL,
Claude run #15 inspected desktop ct-team-01, created a UTF-8 Markdown report,
corrected an initially incorrect artifact path, saved the actual file, and
completed. The downloaded archive was checked for the expected Arabic text.
Both model choices were verified in the Agents screen. Initial provider failures
remain visible in run history; no desktop actions were silently replayed.
All 313 application tests and the TypeScript check passed.


## Provider status and sign-in from Agents

The Agents screen includes a compact table for explicitly managed Claude and
Codex connections. Enable the appropriate managed service in Model connections;
ordinary API connections never receive CLI login requests. On upgrade, deploy
`scripts/cli-management.ts` and `scripts/provider-errors.ts` beside each private
`provider.ts`, restart the private services, and set the connection's managed CLI
type. Gateway tokens stay encrypted in the dashboard and are never returned.

The status distinguishes service reachability, locally cached sign-in, and an
actual inference check. Test connection sends a small text-only request, with no
desktop screenshot or user files; normal provider usage limits/billing apply.
The latest result, tested model, time and a credential-free repair explanation
are shown. Retry runs the same explicit test. Restarting a gateway resets its
in-memory test to untested, so a prior green status cannot outlive the service.

Re-sign-in starts the official CLI browser/device flow on the server. Codex
shows its official device URL and short code. Claude shows its official approval
URL and accepts the one-time callback code or full official callback URL in a
password field, bound to the pending request's state. Codes are sent only to the
private service, never stored in the database or audit detail. The UI clears the
code field after submission. Approval remains a human action on the official
provider page. The pending flow expires after 15 minutes and can be cancelled.
Stop active runs before re-signing in; the gateway blocks inference during login.

Some Codex versions delete their existing auth cache when a new login starts.
Both providers therefore authenticate into a private temporary HOME/config
folder, then atomically promote only the newly authenticated credentials on
success. Cancellation, failure and expiry leave the active cache untouched.
Linux login processes run in their own group so cancelling also terminates CLI
launcher children before the temporary cache is discarded. No logout is issued.

For rollback, switch the managed CLI setting back to ordinary API and restore
the previous private provider files; model inference and existing credentials
remain usable. The added `managed_cli` database column is additive and older
application versions ignore it. Keep both shared management files when deploying
the current providers. The server retains its pre-update dashboard container and
private provider file copies for rollback.


Live management validation on CT 401 (2026-10-24): both private services passed
real inference checks through the public Worker. The initial Codex re-login test
revealed destructive cache clearing in the installed CLI; the final staging
implementation was verified by completing a real device-code login, then starting
and cancelling new flows for both providers. SHA-256 comparisons on the server
confirmed each active credential file stayed unchanged on start/cancel. No
credential content left the server. Service-unavailable responses use HTTP 424
so the public proxy preserves the actionable JSON explanation instead of replacing
it with its generic 502 HTML page. The UI also handles non-JSON proxy failures.
All 320 tests and the TypeScript check passed.
