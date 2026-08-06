# dashboard-ts

The dashboard, in Bun. It is what `docker-compose.yml` builds — the Flask
original it replaced has been removed, because the two shared one database and
this one no longer has the tables that one expects.

    bun install
    bun test
    bun run dev

## Layout

* `src/` — one module per concern, one router per slice of the URL space.
  Nothing imports upwards.
* `src/mcp/` — `keys.ts` (a key: one machine, revocable), `tools.ts` (the
  advertised tool list and the handlers behind it, deliberately one table),
  `activity.ts` (what the outside clients are doing right now).
* `src/routes/mcp.ts` — the endpoint itself: MCP Streamable HTTP, stateless,
  written against the protocol rather than an SDK. The surface actually in use
  is `initialize`, `tools/list` and `tools/call`, and vendoring a framework to
  express three methods buys less than it costs.
* `src/providers/` — the only modules that talk to Docker. A machine backend
  implements `MachineProvider`; `docker.ts` is the one that ships. Which
  backend owns a machine is a column on its row, not a global — a fleet is
  meant to be able to mix them. `DESKSWARM_PROVIDER` names the backend new
  machines go to.
* `src/bridge.ts` — one command to a machine's cua bridge, and its
  `data:`-prefixed reply parsed. Shared by the wall and by the MCP tools,
  which want different things from a failure.
* `templates/` — nunjucks, carried over from the Flask original's Jinja2.
* Docker goes through `dockerode`, SQLite through `bun:sqlite`.

One process replaces gunicorn's several, which removes a real bug: two workers
used to run the same `ALTER TABLE` at import and the loser died with
"duplicate column name".

## Signing in

Everything except `/health`, `/s/<token>` and `/mcp/<slug>` needs a person or
a token behind it. People sign in at `/login`; scripts keep sending
`DASHBOARD_TOKEN`.

`/mcp/<slug>` is not an exception to that so much as a second door with its
own lock: it does its own bearer check against `mcp_keys`, and a key reaches
exactly one machine and never the dashboard API. It stays inside the
cross-site check — MCP's transport spec asks servers to validate `Origin`, and
a real client sends none at all.

Passwords go through `Bun.password` (argon2id — no dependency, no parameters to
get wrong), sessions are random 32-byte tokens stored by hash, and a failed
sign-in is rate limited per address. Changing a password ends that user's
sessions, because a password change is usually a response to it having leaked.

The first boot creates a user if there are none and prints the password once.
`DESKSWARM_ADMIN_USER` and `DESKSWARM_ADMIN_PASSWORD` set it instead.
`src/cli.ts` manages users from the host.
