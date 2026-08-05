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

If `DASHBOARD_TOKEN` is set in the environment, `POST /api/v1/tasks` requires:

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

## `GET /api/v1/fleet`

Current status of every desktop in the fleet.

**Response**

```json
{
  "ok": true,
  "data": [
    { "name": "desktop-1", "bridge_host": "bridge-1", "bridge_port": 8000,
      "novnc_url": "http://localhost:6901/vnc.html", "bridge_ok": true }
  ],
  "error": null
}
```

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

`desktop` is either a fleet member name (see `GET /api/v1/fleet`) or `"all"`
to run the same task on every desktop concurrently.

**Response** — `201 Created`

```json
{ "ok": true, "data": { "task_ids": [4] }, "error": null }
```

Tasks run asynchronously in a background thread; poll `GET /api/v1/tasks` (or
`GET /partials/tasks` for the HTML fragment used by the dashboard) for status.

**Errors**

| status | condition |
|---|---|
| 400 | missing `description`, or unknown `desktop` name |
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

- `GET /partials/fleet` — fleet status cards
- `GET /partials/tasks` — task history table
- `GET /partials/analytics` — stat tiles + chart + per-desktop breakdown
- `GET /partials/live` — live-view desktop grid

These are HTMX-polled fragments, not intended for external consumers — use
the `/api/v1/*` JSON endpoints instead if you're integrating deskswarm with
something else (n8n, a cron job, another agent, etc).
