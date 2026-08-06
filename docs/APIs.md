# deskswarm API

Base URL: `http://<dashboard-host>:7861`

All JSON responses use the envelope:

```json
{ "ok": true, "data": { ... }, "error": null }
```

or, on failure:

```json
{ "ok": false, "data": null, "error": "message" }
```

## Authentication

Two separate credentials, for two different callers.

**The dashboard token** is yours. Everything under `/api/v1` and every page
needs a signed-in session or, for scripts, `DASHBOARD_TOKEN`:

```
Authorization: Bearer <DASHBOARD_TOKEN>
```

**An MCP key** belongs to an outside client and reaches exactly one machine's
`/mcp/<slug>` endpoint — never the dashboard API, never another machine. Keys
are issued and revoked through the API below. The two are not
interchangeable in either direction.

Put this dashboard behind a reverse proxy / VPN / firewall if you're exposing
it beyond a trusted network — it has no built-in rate limiting or TLS.

## `GET /health`

Liveness check.

```json
{ "status": "ok" }
```

## Computers

A *computer* is one machine: a desktop container plus its bridge container. They are created and destroyed at runtime — the fleet is
stored in the database, not in `docker-compose.yml`.

### `GET /api/v1/computers`

```json
{
  "ok": true,
  "data": [
    {
      "id": 1,
      "name": "research-01",
      "slug": "research-01",
      "novnc_port": 6901,
      "novnc_url": "http://localhost:6901/vnc.html",
      "bridge_host": "deskswarm-dyn-bridge-research-01",
      "bridge_port": 8000,
      "bridge_ok": true,
      "desktop_state": "running",
      "bridge_state": "running",
      "sleeping": false,
      "reserved": false,
      "no_suspend": false,
      "last_active_at": "2026-08-05T18:02:11+00:00",
      "created_at": "2026-08-05T04:20:51+00:00"
    }
  ],
  "error": null
}
```

### `POST /api/v1/computers`

Boots a new machine. The noVNC port is assigned automatically from the first
free port at or above `DESKSWARM_NOVNC_PORT_BASE`.

**Body**: `{ "name": "research-01", "snapshot": "<optional snapshot name>" }`
— `201 Created`.

The very first call also builds the bridge image, which takes a minute;
subsequent calls return in about a second.

`name` may contain one `{N..M}` range to create a batch:
`{"name": "agent-{1..10}"}`. Zero-padding is preserved (`node-{01..10}`).
A batch returns `{"created": [...], "errors": [{"name", "error"}]}` — names
that clash are reported without blocking the rest. A single name returns the
computer object directly, as before. `DESKSWARM_MAX_BULK_CREATE` caps the
range size.

`snapshot` starts the machine from a saved snapshot image instead of a clean
desktop, so it comes up with that software already installed.

**Errors**: `400` missing name, `409` name already taken, `500` Docker refused
to start the containers.

### `PATCH /api/v1/computers/<id>`

Renames a computer — **body**: `{ "name": "new-name" }` — or flips one of its
flags: `{ "reserved": "1" }` / `{ "no_suspend": "1" }` (and `"0"` to clear).

`no_suspend` exempts the machine from automatic idle suspend; manual
sleep/wake still work.

A reserved machine is one you drive by hand: no MCP key can be issued for it,
so no outside client can take the keyboard while you are using it. Keys
already issued keep working — reserving is not a revoke, and silently breaking
a client someone wired up last week would be worse than the surprise it saves.

Only the display name changes — the containers keep their original slug, so
the machine's MCP endpoint and every key issued against it keep working.

**Errors**: `404` unknown id, `400` missing name, `409` name already taken.

### `POST /api/v1/computers/<id>/sleep`

Stops both containers. The machine gives back all of its memory and CPU and
keeps its home volume, name, port and snapshot.

```json
{ "ok": true, "data": { "id": 3, "sleeping": true }, "error": null }
```

Sleeping ends the desktop's X session, so **open windows and unsaved work are
lost** — saved files are not.

Refused with `409` if an MCP client has called the machine within
`DESKSWARM_LIVE_WINDOW` seconds. Repeat with `?force=1` to sleep it anyway:
the client may equally be a script that wandered off, and there has to be a
way to stop the machine.

### `POST /api/v1/computers/<id>/wake`

Starts a sleeping machine and waits for its bridge to answer, up to
`DESKSWARM_WAKE_TIMEOUT` seconds.

```json
{ "ok": true, "data": { "id": 3, "sleeping": false, "ready": true }, "error": null }
```

`ready: false` means it started but the desktop was still coming up — the
screen will work a moment later. That is not an error.

Waking is automatic when you click a sleeping machine on the wall, and on the
first MCP call that needs it, so this is only needed for scripting.

### Sleeping automatically

Set `DESKSWARM_IDLE_SUSPEND_MINUTES` to suspend machines nobody is using. A
machine counts as in use while a browser has its screen open (an established
connection to its noVNC port) or an MCP client has called it within
`DESKSWARM_LIVE_WINDOW` seconds. Machines with `no_suspend` set are always
skipped.

It is `0` — off — by default, because a surprise suspend costs someone their
open windows.

### `DELETE /api/v1/computers/<id>`

Destroys both of the machine's containers and removes it from the fleet.
Task history for that machine is kept.

```json
{ "ok": true, "data": { "id": 3, "removed": true }, "error": null }
```

### `POST /api/v1/computers/<id>/exec`

Runs a shell command inside the desktop container as **root** — this is what
the dashboard's terminal uses, and how you provision a machine with extra
software.

Because this runs as root while the desktop session runs as `cua`, any GUI
app you launch here (rather than install) can leave root-owned files under
`/home/cua` that then break that app for the desktop user. After provisioning,
finish with `chown -R cua:cua /home/cua`.

**Body**: `{ "command": "apt-get install -y xdotool" }`

```json
{ "ok": true, "data": { "ok": true, "exit_code": 0, "output": "..." }, "error": null }
```

Each call is a separate `docker exec`, so shell state (including `cd`) does
not carry over between commands.

### `GET /api/v1/computers/<id>/clipboard`

Reads the machine's X clipboard.

```json
{ "ok": true, "data": { "text": "whatever was copied over there" }, "error": null }
```

### `POST /api/v1/computers/<id>/clipboard`

Writes it. **Body**: `{ "text": "…", "paste": "1" }`

With `paste`, the text is also pressed into the focused window with Ctrl+V.
That is the dependable way to get **Arabic or any non-Latin text** onto a
machine: typing goes through xdotool's keysym lookup, which has no mapping for
most of those characters and silently drops them — the clipboard carries
bytes, so nothing is lost.

```json
{ "ok": true, "data": { "id": 3, "bytes": 25, "pasted": true }, "error": null }
```

Both directions need `xclip` (and `xdotool` for `paste`) on the machine. If
they're missing the dashboard installs them, which takes a few seconds the
first time — snapshot the machine afterwards to make it permanent, since a
container rebuild drops anything apt installed.

**Errors**: `400` no `text`, `413` over `DESKSWARM_MAX_CLIPBOARD_KB`,
`503` no clipboard tooling and it couldn't be installed (offline machine).

### `GET /api/v1/computers/<id>/inventory`

What's installed on the machine.

```json
{
  "ok": true,
  "data": {
    "os": "Debian GNU/Linux 12 (bookworm)",
    "kernel": "6.1.0-23-amd64",
    "runtimes": [{ "name": "python3", "version": "Python 3.13.14" }],
    "apps": ["firefox", "thunar", "xfce4-terminal", "curl", "ffmpeg"],
    "package_count": 494,
    "python_packages": ["pip==26.1.2"],
    "disk": "overlay 106G 50G 57G 47% /",
    "memory": "11Gi total, 1.2Gi used, 10Gi available"
  },
  "error": null
}
```

### `GET /api/v1/computers/<id>/screenshot`

A PNG of the machine's current screen, pulled through its bridge. This is what
the wall's tiles use.

Results are cached server-side for `DESKSWARM_SHOT_TTL` seconds (default 6) and
sent with a matching `max-age`, so a wall of N machines costs one capture per
machine per window no matter how often the page re-renders.

**Errors**: `404` unknown machine, `503` the screen could not be captured
(bridge down or mid-restart).

## Backups

A backup is one machine's whole home directory, gzipped, on the dashboard's
data volume. It is not a snapshot: a **snapshot** captures installed software
(the image), a **backup** captures your files (the volume).

### `GET /api/v1/computers/<id>/backups`

```json
{ "ok": true, "data": [
  { "name": "20260805T181233Z.tar.gz", "machine": "work-1",
    "bytes": 41288342, "created_at": "2026-08-05T18:12:33+00:00" }], "error": null }
```

### `POST /api/v1/computers/<id>/backups`

Writes a new one — `201 Created`. Works on a sleeping machine without waking
it. Oldest are pruned past `DESKSWARM_BACKUP_KEEP`.

**Errors**: `404` unknown machine, `507` disk below `DESKSWARM_MIN_FREE_DISK_GB`.

### `GET /api/v1/computers/<id>/backups/<name>`

Downloads it. Streamed, so a large one doesn't sit in memory.

### `DELETE /api/v1/computers/<id>/backups/<name>`

### `POST /api/v1/computers/<id>/restore`

**Body**: `{ "backup": "20260805T181233Z.tar.gz", "from": "<other machine>" }`

`from` restores another machine's backup onto this one — how you clone a
machine's data, or move it to a new host.

Restoring **replaces** the home directory: anything not in the backup is
removed, so "restore" doesn't quietly mean "merge". The machine is stopped for
the duration and started again afterwards if it was running — open windows are
lost, files are not.

```json
{ "ok": true, "data": { "machine": "work-1", "entries": 4213, "restarted": true }, "error": null }
```

### `POST /api/v1/computers/<id>/restore/upload`

Same, from a `multipart/form-data` file you supply — this is how a machine is
rebuilt on a different host. The archive is treated as untrusted: members
whose paths climb out of the home directory, and symlinks pointing outside it,
are dropped rather than unpacked, and everything restored is owned by the
desktop user.

**Errors**: `400` missing or unreadable file.

### Daily backups

Set `DESKSWARM_BACKUP_DAILY_AT=HH:MM` (UTC) to back up every machine once a
day. With several gunicorn workers only one fires it.

## Shares

A share is a link to exactly one machine, with an expiry and a revoke —
instead of handing someone the dashboard, which is every machine plus a root
shell on each.

### `POST /api/v1/computers/<id>/shares`

**Body**: `{ "label": "sara", "mode": "watch", "hours": 24 }` — `201 Created`.

```json
{ "ok": true, "data": {
  "id": 2, "label": "sara", "mode": "watch", "status": "live",
  "url": "http://dashboard:7861/s/UEhQ…", "expires_at": "2026-08-06T18:00:00+00:00",
  "uses": 0 }, "error": null }
```

| mode | what the guest gets | what revoking does |
|---|---|---|
| `watch` | the screen, served through the link, refreshed every few seconds | stops it completely and at once |
| `control` | the machine's own noVNC embedded — keyboard and mouse | closes the page, but their browser was already given the machine's screen password |

For `control`, the honest remedy is
`POST /api/v1/computers/<id>/rotate-password`, which gives the machine a new
screen password, restarts it, and revokes every control share on it. Any saved
noVNC URL stops working.

**Errors**: `400` unknown mode, or `hours` outside 1…`DESKSWARM_SHARE_MAX_HOURS`.

### `GET /api/v1/shares` · `DELETE /api/v1/shares/<id>`

List (with `status`: `live` / `expired` / `revoked`, use count and last use)
and revoke. Revoking a `control` share returns a `note` saying what it can't
retract.

### `GET /s/<token>` · `GET /s/<token>/screen.png`

The guest's page and, for `watch`, its screen. No authentication beyond the
token; nothing else in the fleet is reachable from it. A revoked, expired or
invented token gets the same `404` — which of the three it is would tell a
stranger whether to keep guessing.

## Audit

### `GET /api/v1/audit`

Every state-changing request, newest first, `DESKSWARM_PAGE_SIZE` per page.
Filter with `?target=<machine>` / `?actor=share:` / `?page=`.

```json
{ "ok": true, "data": [
  { "id": 91, "at": "2026-08-05T18:14:02+00:00", "actor": "share:sara",
    "source_ip": "10.0.0.9", "action": "GET /s/<token> (watch)",
    "target": "reception", "detail": "opened the share page",
    "status": 200, "ok": 1 }], "meta": { "pages": 4 }, "error": null }
```

Reads aren't recorded — polling would drown everything else — except a guest
opening a share, which is the read that matters. Contents aren't either: the
shell command is kept because that is the point of the log, but clipboard text
and file bodies are only ever counted.

Entries older than `DESKSWARM_AUDIT_RETENTION_DAYS` are dropped daily.

### `GET /api/v1/audit/export.csv`

## `GET /api/v1/fleet`

Alias of `GET /api/v1/computers`, kept for convenience.

## Snapshots

A snapshot freezes a provisioned machine into a Docker image so new machines
can start from it.

### `GET /api/v1/snapshots`

```json
{ "ok": true, "data": [
  { "id": 1, "name": "with-xdotool", "image": "deskswarm-dyn-snapshot:with-xdotool",
    "source": "agent-1", "created_at": "..." }], "error": null }
```

### `POST /api/v1/computers/<id>/snapshot`

Commits that machine's desktop container. **Body**: `{ "name": "design-box" }`
— `201 Created`.

**Errors**: `404` unknown machine, `400` missing name, `409` snapshot name
taken, `500` the commit failed.

### `DELETE /api/v1/snapshots/<id>`

Removes the snapshot. The underlying image is deleted too **unless** machines
are still running from it, in which case the response reports
`"image_kept": true`.

## MCP

Each machine has its own MCP endpoint. This is how work actually gets done on
a machine: you point an MCP client (Claude Code, Claude Desktop, anything
speaking the protocol) at one machine's URL with one key, and it gets that
machine's screen, keyboard, root shell and home directory.

```
POST /mcp/<slug>
Authorization: Bearer <mcp-key>
Content-Type: application/json
```

Transport is MCP **Streamable HTTP**, stateless: no session id, no
server-initiated stream. Protocol versions `2025-06-18`, `2025-03-26` and
`2024-11-05` are accepted; an unrecognised one is answered with the newest.

Implemented methods are `initialize`, `tools/list`, `tools/call`, `ping`,
`resources/list` and `prompts/list` (both empty). `GET` on the endpoint
returns `405` — nothing here pushes — and `DELETE` returns `204`.

A failed *tool call* comes back as a normal result with `isError: true`, not a
JSON-RPC error. That distinction is deliberate and matches the spec: a
JSON-RPC error means the client is broken, `isError` means the call went wrong
and the model should read the message and try something else.

### Tools

| tool | what it does |
|---|---|
| `screenshot` | a PNG of the screen — every coordinate comes off this |
| `screen_size` | resolution in pixels |
| `click` / `double_click` | click at `x,y`; `button` is `left`/`right`/`middle` |
| `move_mouse` | move the pointer without clicking |
| `drag` | `from_x,from_y` → `to_x,to_y` |
| `scroll` | `direction` plus `clicks` |
| `type_text` | type into the focused window |
| `press_key` / `hotkey` | one key, or a combination |
| `launch_app` | start a program by name |
| `shell` | run a command as root, returns exit code and output |
| `list_files` / `read_file` / `write_file` | the machine's home directory |
| `get_clipboard` / `set_clipboard` | the machine's clipboard |
| `inventory` | OS, kernel, runtimes, installed apps, disk, memory |

Paths are relative to the machine's home directory and cannot climb out of it.

`type_text` sends non-Latin text (Arabic, Chinese, emoji) through the
clipboard automatically — the keyboard path goes through keysym lookup, which
silently drops those characters.

A sleeping machine is woken by the first call that needs it, unless
`DESKSWARM_MCP_AUTO_WAKE` is off.

### `GET /mcp/<slug>/info`

Needs no key. Confirms the slug names a real machine and lists the protocol
versions and tool names it offers — enough to configure a client, nothing that
holding a key would have bought.

## MCP keys

A key names one machine at issue and cannot be widened afterwards. Revoking is
complete: the key is the only way in over MCP, so the next call fails.

### `GET /api/v1/keys`

Every key, newest first. Each row carries its `token`, its `url`, and a
ready-to-paste `claude_code` command.

```json
{ "ok": true, "data": [
    { "id": 1, "computer_id": 3, "computer": "research-01", "slug": "research-01",
      "label": "claude code", "status": "live", "token": "dsk_...",
      "url": "https://swarm.example.com/mcp/research-01",
      "claude_code": "claude mcp add --transport http research-01 ...",
      "calls": 42, "last_tool": "screenshot",
      "last_used_at": "2026-08-06T14:50:35+00:00", "last_used_ip": "10.0.0.4",
      "expires_at": "2026-09-05T14:00:00+00:00", "revoked": 0,
      "created_at": "2026-08-06T14:00:00+00:00" }
  ], "error": null }
```

`status` is `live`, `revoked` or `expired`.

### `GET /api/v1/computers/<id>/keys`

The same, for one machine.

### `POST /api/v1/computers/<id>/keys`

```json
{ "label": "claude code", "days": 30 }
```

`days` defaults to `DESKSWARM_MCP_KEY_DEFAULT_DAYS` and is capped at
`DESKSWARM_MCP_KEY_MAX_DAYS`; `0` means no expiry. Returns `201` with the row
above.

`409` if the machine is **reserved** — un-reserve it first. Handing out a key
to a machine you have claimed for yourself would let a client take the
keyboard while you are using it.

### `DELETE /api/v1/keys/<id>`

Revokes it. `{ "id": 1, "revoked": true }`.

Deleting a machine deletes its keys with it, reported as `keys_deleted` on the
delete response.

## HTML partials (used internally by the dashboard, not a stable API)

- `GET /partials/fleet` — fleet cards with their per-machine controls
- `GET /partials/activity?machine=&page=` — every MCP call, newest first.
  Page size is `DESKSWARM_PAGE_SIZE` (default 25); out-of-range pages clamp to
  the last one
- `GET /partials/computers/<id>/access` — the machine's endpoint, its keys and
  what a key can do there
- `GET /partials/computers/<id>/inventory` — rendered software inventory

The dashboard also accepts deep links: `/?open=terminal&computer=<id>` and
`/?open=software&computer=<id>` open straight into that machine's modal.

These are HTMX-polled fragments, not intended for external consumers — use
the `/api/v1/*` JSON endpoints instead if you're integrating deskswarm with
something else (n8n, a cron job, another agent, etc).
