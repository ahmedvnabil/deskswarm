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

If `DASHBOARD_TOKEN` is set in the environment, every mutating endpoint
(creating/renaming/deleting a computer, running a command, dispatching or
cancelling a task) requires:

```
Authorization: Bearer <DASHBOARD_TOKEN>
```

`GET` endpoints are unauthenticated by default (read-only status/history).
Put this dashboard behind a reverse proxy / VPN / firewall if you're exposing
it beyond a trusted network — it has no built-in rate limiting or TLS.

## `GET /health`

Liveness check.

```json
{ "status": "ok" }
```

## Computers

A *computer* is one agent-controlled machine: a desktop container plus its
bridge container. They are created and destroyed at runtime — the fleet is
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

Renames a computer. **Body**: `{ "name": "new-name" }`.

Only the display name changes — the containers keep their original slug, so
in-flight tasks are unaffected. Existing task history is relabelled to match.

**Errors**: `404` unknown id, `400` missing name, `409` name already taken.

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

**Body**: `{ "command": "apt-get install -y xdotool" }`

```json
{ "ok": true, "data": { "ok": true, "exit_code": 0, "output": "..." }, "error": null }
```

Each call is a separate `docker exec`, so shell state (including `cd`) does
not carry over between commands.

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

## Schedules

Repeat a task automatically. The dashboard ticks every 20s and claims due
schedules with a conditional `UPDATE`, so running several gunicorn workers
never double-dispatches one schedule.

### `GET /api/v1/schedules`

```json
{ "ok": true, "data": [
  { "id": 1, "desktop": "all", "description": "Daily fleet health check.",
    "kind": "daily", "every_minutes": null, "at_time": "09:00",
    "enabled": 1, "next_run_at": "2026-08-06T09:00:00+00:00",
    "last_run_at": null, "run_count": 0, "created_at": "..." }], "error": null }
```

### `POST /api/v1/schedules`

**Body** — every N minutes:

```json
{ "desktop": "all", "description": "Check the queue", "kind": "interval", "every_minutes": 30 }
```

or daily at a fixed UTC time:

```json
{ "desktop": "agent-1", "description": "Morning report", "kind": "daily", "at_time": "09:00" }
```

`desktop` accepts a machine name or `"all"`. `201 Created`.

**Errors**: `400` missing description, bad `kind`, `every_minutes < 1`,
`at_time` not `HH:MM`, or unknown machine.

### `PATCH /api/v1/schedules/<id>`

Pause or resume. **Body**: `{ "enabled": "0" }` / `{ "enabled": "1" }`.
Resuming recomputes the next run from now.

### `DELETE /api/v1/schedules/<id>`

Removes the schedule. Tasks it already created are kept.

## `GET /api/v1/tasks`

Most recent 100 tasks, newest first.

**Response**

```json
{
  "ok": true,
  "data": [
    {
      "id": 3,
      "desktop": "desktop-1",
      "description": "Take a screenshot and describe what you see.",
      "status": "COMPLETED",
      "current_action": null,
      "result_text": "...",
      "actions": "[\"screenshot\"]",
      "cost_usd": 0.0087,
      "duration_seconds": 12.4,
      "error": null,
      "pid": null,
      "started_at": "2026-08-05T01:27:03+00:00",
      "created_at": "2026-08-05T01:27:02+00:00",
      "updated_at": "2026-08-05T01:28:19+00:00"
    }
  ],
  "error": null
}
```

`status` is one of `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`.
While `RUNNING`, `current_action` reflects the agent's most recent step
(`screenshot`, `left_click`, `type_text`, `responding`, ...) — updated live by
`dashboard/run_task.py` after every turn, so you don't have to wait for
completion to see what it's doing.

## `GET /api/v1/tasks/<id>`

Full detail for a single task (same shape as one row above, untruncated).

**Errors**: `404` if the task doesn't exist.

## `GET /api/v1/tasks/export.csv`

Full task history as a CSV download (`id, desktop, description, status,
result_text, cost_usd, duration_seconds, error, created_at, updated_at`).

## `POST /api/v1/tasks`

Dispatch a natural-language task to one desktop, or the whole fleet in parallel.

**Body**

```json
{ "desktop": "desktop-1", "description": "Open a browser and search for today's news." }
```

`desktop` is either a computer's name (see `GET /api/v1/computers`) or
`"all"` to run the same task on every computer concurrently.

**Response** — `201 Created`

```json
{ "ok": true, "data": { "task_ids": [4] }, "error": null }
```

Tasks run asynchronously in a background thread; poll `GET /api/v1/tasks` (or
`GET /partials/tasks` for the HTML fragment used by the dashboard) for status.

**Errors**

| status | condition |
|---|---|
| 400 | missing `description`, unknown `desktop` name, or the fleet is empty |
| 401 | missing/invalid `Authorization` header when `DASHBOARD_TOKEN` is set |

## `POST /api/v1/tasks/<id>/cancel`

Cancel a `PENDING` or `RUNNING` task. Sends `SIGTERM` to the runner
subprocess if one is attached and marks the task `CANCELLED`.

**Response**

```json
{ "ok": true, "data": { "id": 4, "status": "CANCELLED" }, "error": null }
```

**Errors**: `404` if the task doesn't exist, `400` if it's already finished.

## `POST /api/v1/tasks/<id>/retry`

Re-run a task with the same desktop and description as an existing one
(typically a `FAILED` task) — creates a **new** task row rather than
mutating the old one, so history is preserved.

**Response** — `201 Created`

```json
{ "ok": true, "data": { "task_id": 9 }, "error": null }
```

**Errors**: `404` if the original task doesn't exist, `400` if its desktop
was removed from the fleet since.

## `GET /api/v1/analytics`

Aggregate stats across all tasks.

**Response**

```json
{
  "ok": true,
  "data": {
    "total": 12,
    "by_status": { "PENDING": 0, "RUNNING": 1, "COMPLETED": 9, "FAILED": 2 },
    "success_rate": 81.8,
    "total_cost_usd": 0.0932,
    "avg_duration_seconds": 14.2,
    "per_desktop": [
      { "name": "desktop-1", "total": 5, "completed": 4, "failed": 1, "cost_usd": 0.041 }
    ],
    "daily": [
      { "day": "2026-08-04", "count": 5, "cost": 0.041 },
      { "day": "2026-08-05", "count": 7, "cost": 0.052 }
    ]
  },
  "error": null
}
```

`daily` covers up to the last 14 days with at least one finished task,
oldest first — this is what powers the dashboard's chart.

## HTML partials (used internally by the dashboard, not a stable API)

- `GET /partials/fleet` — fleet cards with their per-machine controls
- `GET /partials/tasks?desktop=&status=&page=` — task history table;
  `status` accepts `ACTIVE` (pending+running), `COMPLETED`, `FAILED`,
  `CANCELLED`. Page size is `DESKSWARM_PAGE_SIZE` (default 25); out-of-range
  pages clamp to the last one
- `GET /partials/schedules` — schedule table
- `GET /partials/analytics` — stat tiles + chart + per-machine breakdown
- `GET /partials/computers/<id>/inventory` — rendered software inventory

The dashboard also accepts deep links: `/?open=terminal&computer=<id>` and
`/?open=software&computer=<id>` open straight into that machine's modal.

These are HTMX-polled fragments, not intended for external consumers — use
the `/api/v1/*` JSON endpoints instead if you're integrating deskswarm with
something else (n8n, a cron job, another agent, etc).
