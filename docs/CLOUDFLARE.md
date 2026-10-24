# Cloudflare deployment

Open **Settings → ربط Cloudflare والنشر** (`/settings/cloudflare`).

## Architecture

This release deploys an **edge gateway**, not a standalone replacement for the
Bun dashboard backend:

```
Browser → Cloudflare Worker → Durable Object (device routes) → HTTPS Linux DeskSwarm
                                                               → Docker / SSH hosts
```

HTML, authentication, SQLite records, Agent execution, model connections, files,
backups and Docker/SSH management remain on the existing Linux service. The Worker
streams the UI/API and WebSocket traffic. A stable SQLite-backed `DeviceSession`
Durable Object handles each computer's API and screen routes and stores only a
last-request timestamp. It does not store session cookies, credentials or tasks.
The existing Linux lease remains the authoritative one-Agent-per-device lock,
including when users access Linux directly. DO request handlers are not presented
as a replacement for that lock.

No desktop is moved or recreated by Cloudflare deployment. No Containers, R2, D1,
custom domain, Tunnel provisioning, or CLI credentials are provisioned in this
release. Existing host-local Codex gateways must remain reachable by Linux.

## Prepare the Linux origin

1. Run the current DeskSwarm dashboard on the Linux execution service with its
   existing persistent data volume and Docker/SSH configuration.
2. Give that service a public **HTTPS** origin, for example a Cloudflare Tunnel
   hostname. It must reach the dashboard, not Docker's API or a desktop port.
   `/health` must return `{"status":"ok"}` without redirects. TLS must be valid.
3. The origin must remain available while the Cloudflare app is used. A Tunnel
   protected by an interactive Cloudflare Access challenge requires additional
   service-token support, which this release does not configure. The origin's
   normal DeskSwarm login remains required. Do not expose the Docker socket.
4. Enable a workers.dev subdomain in the Cloudflare account. This release deploys
   to `https://<worker>.<account-subdomain>.workers.dev`.

Remote SSH desktop screens continue through the existing pinned SSH transport.
Once a Cloudflare connection is saved, host-local Docker desktop links also use
`/remote-screen/<id>/...`: the trusted vendored noVNC client and authenticated
WebSocket proxy. On Linux the dashboard must share the configured Docker network
with local desktops, as in the normal Compose setup. No public desktop screen
ports are needed by the edge. Direct Linux dashboard access continues to work.

## Connect and deploy

1. Create a scoped API Token for the target account (not a Global API Key).
   It needs account workers.dev/subdomain read access, Worker metadata/settings
   and versions read access, script upload/deploy, workers.dev activation and
   Durable Object namespace creation. For a new Worker use Workers product Admin;
   existing deployments need the corresponding edit permissions. Accounts using
   legacy permissions commonly expose **Workers Scripts Edit** and account
   metadata read permissions. Check the current Cloudflare permission UI/docs.
   DO availability and quota depend on the account's plan.
2. Enter Account ID, a new Worker name, the Linux HTTPS origin and the token.
3. **Test connection** reads the account subdomain and Worker settings and probes
   the Linux origin. The test explicitly does **not** promise that write access
   or DO entitlement is available; Cloudflare validates those during deployment.
4. **Save tested connection** consumes a single-use ticket valid for five minutes
   and tied to exactly those settings. Editing any field requires another test.
5. **Deploy Worker + Durable Objects** creates a background job. The UI polls its
   stages and retains the last 30 job records across reloads. A unique SQLite
   index prevents simultaneous deployment jobs or changes to credentials while
   a job is running. Another attempt can be started after a failure.

The token and edge health secret are encrypted with the existing AES-256-GCM
master key beside the database (`.agent-secret-key`, mode 0600). Back up that key
alongside the DB. API responses and audit entries never contain these secrets.
To rotate the token, enter the new token, test and save again.

Deployment uses Cloudflare's multipart module-upload API, which creates a live
version/deployment. It creates the SQLite Durable Object migration only on the
first deployment. Existing Workers are updated only when their settings carry the
`DESKSWARM_APP=deskswarm-edge-v1` marker; unrelated apps are refused. The edge health
secret is a `secret_text` binding. The Cloudflare API token never enters the Worker.

Success requires Cloudflare to report the uploaded version serving 100% of traffic,
then a private edge health check must exercise a Durable Object and reach Linux.
First-time propagation can delay that check. A failed readiness check can mean code
was already deployed: inspect Cloudflare before retrying. An app restart marks
running jobs **interrupted**, never silently replays an upload or rollback.

## Previous versions and recovery

**Refresh versions → choose version → Roll back** sends a new Cloudflare deployment
with the selected version receiving 100% of traffic. It does not upload code or
apply reverse DO migrations. Only versions returned for the configured Worker can
be selected, and the Worker must still have the DeskSwarm ownership marker.

Rollback restores Worker code and its versioned bindings. Choose a version with
an available Linux origin and compatible edge health secret. It **does not** restore
Linux SQLite records, Agent runs, desktop files or DO storage. Cloudflare can reject
rollbacks across incompatible resource/migration changes. This release keeps one
stable DO class and does not delete its namespace.

If the edge is unavailable, use the Linux dashboard's original HTTPS address.
Its login, data and Agent leases are unchanged. Failed or interrupted deployments
can also be inspected/reverted from Cloudflare's Deployments page. Restoring an
older Linux image is a separate operation; keep a normal data backup.

## Validation (2026-10-24)

- 270 application tests, TypeScript and the production Docker build.
- Provider contract tests exercise test/save tickets, encryption, redaction,
  authorization/CSRF, module/migration upload, 100% version verification, rollback,
  unrelated Worker protection, operation exclusivity and restart interruption.
  Cloudflare management API calls in these tests are fixtures, not live account calls.
- `bun run test:cloudflare-edge` uses **Node 22 + Miniflare/workerd** and real
  SQLite-backed Durable Objects against a real local HTTP/WebSocket origin.
  It verifies Arabic bytes, authentication cookie forwarding, forwarded-host
  replacement, safe redirects, protected health checks and WebSocket round trips.
  Run it with Node, not Bun's Node emulation (Miniflare transport differs under Bun).
- A separate local workerd gateway was connected to the actual running Linux
  dashboard in Colima. The logged-in dashboard and Pilot's noVNC screen loaded
  through it. Mouse input changed the test app counter from 5 to 6; keyboard
  events appended `edgeok` in the app. Evidence: `images/cloudflare-linux-test.png`.
  This exercised local Cloudflare runtime + the real device, not an Internet edge.
- No Cloudflare account token/Account ID or public Linux origin was supplied for
  this work. **No live Cloudflare deployment or live account rollback was performed.**
  Enter those locally in Settings to run the live deployment and readiness checks.

## API

All routes require the normal dashboard session or dashboard bearer token, and
mutations retain existing cross-site protections. Responses use the usual envelope.

- `GET /api/v1/cloudflare/status`: public connection fields and recent jobs.
- `POST /api/v1/cloudflare/test`: `{account, worker, origin, token}` → test ticket.
- `POST /api/v1/cloudflare/connection`: same fields plus `test_token` → save.
- `POST /api/v1/cloudflare/deploy`: `{}` → HTTP 202 with job id.
- `GET /api/v1/cloudflare/versions`: available account Worker version identifiers.
- `POST /api/v1/cloudflare/rollback`: `{version}` → HTTP 202 with job id.

References: [authorization](https://developers.cloudflare.com/workers/authorization/),
[module upload](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/),
[deployments](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/),
[rollback limits](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
