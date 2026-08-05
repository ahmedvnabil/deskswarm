# deskswarm API

Base URL: `http://<dashboard-host>:7000`

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
      "result_text": "...",
      "actions": "[\"screenshot\"]",
      "cost_usd": 0.0087,
      "error": null,
      "created_at": "2026-08-05T01:27:02+00:00",
      "updated_at": "2026-08-05T01:28:19+00:00"
    }
  ],
  "error": null
}
```

`status` is one of `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`.

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

## HTML partials (used internally by the dashboard, not a stable API)

- `GET /partials/fleet` — fleet status cards
- `GET /partials/tasks` — task history table

These are HTMX-polled fragments, not intended for external consumers — use
the `/api/v1/*` JSON endpoints instead if you're integrating deskswarm with
something else (n8n, a cron job, another agent, etc).
