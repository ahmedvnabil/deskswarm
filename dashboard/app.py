"""deskswarm — the dashboard.

This file has one job: build the Flask app, attach the request hooks, mount
the blueprints and start the background loop. Everything else lives beside it:

    settings.py    every environment-derived setting, in one place
    db.py          where the database is
    schema.py      tables, and the migrations that carry an old one forward
    security.py    the cross-site check, the audit hook, the token check
    fleet.py       the only module that talks to Docker
    machines.py    machine queries, views, creation, sleep/wake
    tasks.py       task rows, the worker, dispatch, analytics
    screens.py     cached stills of the machines' screens
    scheduler.py   due schedules, idle machines, nightly housekeeping
    guards.py      cost, memory, disk and failure limits
    backups.py     archiving a home directory, and putting it back
    shares.py      links that reach one machine
    audit.py       who did what
    routes/        one blueprint per slice of the URL space:
                     system, machines, files, snapshots, tasks,
                     schedules, backups, shares, audit

It was a single 1,900-line module until the split. The boundaries above are
the ones the code already had; this just made them visible.
"""

import os
import threading

from flask import Flask, g

import security
from db import connect  # noqa: F401  — re-exported; scripts and tests use it
from routes import BLUEPRINTS
from scheduler import scheduler_loop
from schema import init_db

app = Flask(__name__)

app.before_request(security.block_cross_site)
app.after_request(security.write_audit)

for blueprint in BLUEPRINTS:
    app.register_blueprint(blueprint)


@app.teardown_appcontext
def close_db(exception=None):
    conn = g.pop("db", None)      # not `db` — that is the module now
    if conn is not None:
        conn.close()


init_db()

# Each import of this module starts the loop; tests import it many times, and
# a background thread still writing to a database whose directory is being
# torn down fails in whichever test happens to be running. Off under test.
if not os.environ.get("DESKSWARM_DISABLE_SCHEDULER"):
    threading.Thread(target=scheduler_loop, daemon=True).start()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "7000")))
