# Security

## Reporting

Open a [GitHub security advisory](https://github.com/ahmedvnabil/deskswarm/security/advisories/new),
or an issue if it is already public. There is no formal SLA — this is a
side project — but security reports get looked at first.

## The threat model, honestly

deskswarm gives an AI agent a real desktop and gives you a root shell on it
from a web page. Two things follow, and neither is a bug:

**The dashboard mounts the Docker socket.** It has to, in order to create and
destroy machines. That is equivalent to root on the host. Anyone who can reach
the dashboard can start containers on your machine. Treat the dashboard itself
as a privileged admin surface.

**`POST /api/v1/computers/<id>/exec` runs a command as root** inside a desktop
container. That part *is* sandboxed — it is the container, not the host — but
it is still arbitrary code execution somewhere you care about.

## What that means for how you run it

- **Set `DASHBOARD_TOKEN`.** Without it every mutating endpoint is open to
  anyone who can reach the port.
- **Keep it off the public internet.** There is no TLS and no rate limiting.
  Put it behind a reverse proxy, a VPN, or a firewall.
- **Do not put secrets in task descriptions.** They are stored in the task
  history in plain text and sent to your model provider.
- Machine VNC passwords are random per machine, but they appear in the
  `novnc_url` query string so the dashboard can connect for you. Anyone who
  can read the dashboard can read those.

## Fixed

### Cross-site request forgery reaching `/exec` (fixed in `main`, 2026-08)

Mutating endpoints accepted `application/x-www-form-urlencoded` bodies. A form
post is a CORS *simple request*, so no preflight blocks it: any page a user
visited could auto-submit a form at their dashboard and run a shell command as
root inside their machines. Confirmed exploitable against a real deployment
before the fix.

Now a state-changing request whose `Origin`/`Referer` is present and does not
match the dashboard's host is rejected, and body-reading endpoints accept JSON
only. Clients that send no `Origin` at all (curl, n8n, cron) still work — they
are not a CSRF vector, because nobody else controls them.

Regression tests: `tests/test_security.py`.
