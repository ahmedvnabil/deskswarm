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

* `src/` mirrors the Python modules one-to-one — `fleet`, `machines`, `tasks`,
  `guards`, `backups`, `shares`, `audit`, `scheduler`, one router per slice of
  the URL space.
* `templates/` is the Jinja2 markup, ported to nunjucks by
  `scripts/port-templates.py`. 31 lines changed out of 1,681.
* `run_task.py` is still Python: the cua agent loop it drives has no published
  TypeScript equivalent, and it was already a subprocess per task.
* Docker goes through `dockerode`, SQLite through `bun:sqlite`.

One process replaces gunicorn's several, which removes a real bug: two workers
used to run the same `ALTER TABLE` at import and the loser died with
"duplicate column name".
