# dashboard-ts

The dashboard, in Bun. It replaces `../dashboard` (Flask) and is what
`docker-compose.yml` builds; the Flask one is still there and still works —
point the compose `build:` back at it to switch.

    bun install
    bun test
    bun run dev

## What changed and what didn't

The database, the API, the HTML and every container it manages are the same.
The port was verified by running both dashboards against the same production
database and diffing them: all nine JSON endpoints came back byte-identical,
and the rendered pages matched apart from the spelling of one HTML entity
(`&quot;` vs `&#34;`) and the wording of Docker's own error strings.

* `src/` mirrors the Python modules one-to-one — `machines`, `tasks`,
  `guards`, `backups`, `shares`, `audit`, `scheduler`, one router per slice of
  the URL space.
* `src/providers/` is what used to be `fleet.py`. A machine backend implements
  `MachineProvider`; `docker.ts` is the one that ships. Which backend owns a
  machine is a column on its row, not a global — a fleet is meant to be able
  to mix them. `DESKSWARM_PROVIDER` names the backend new machines go to.
* `templates/` is the Jinja2 markup, ported to nunjucks by
  `scripts/port-templates.py`. 31 lines changed out of 1,681.
* `run_task.py` is still Python: the cua agent loop it drives has no published
  TypeScript equivalent, and it was already a subprocess per task.
* Docker goes through `dockerode`, SQLite through `bun:sqlite`.

One process replaces gunicorn's several, which removes a real bug: two workers
used to run the same `ALTER TABLE` at import and the loser died with
"duplicate column name".

## Signing in

Everything except `/health` and `/s/<token>` needs a person or a token behind
it. People sign in at `/login`; scripts keep sending `DASHBOARD_TOKEN`.

Passwords go through `Bun.password` (argon2id — no dependency, no parameters to
get wrong), sessions are random 32-byte tokens stored by hash, and a failed
sign-in is rate limited per address. Changing a password ends that user's
sessions, because a password change is usually a response to it having leaked.

The first boot creates a user if there are none and prints the password once.
`DESKSWARM_ADMIN_USER` and `DESKSWARM_ADMIN_PASSWORD` set it instead.
`src/cli.ts` manages users from the host.
