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

No desktop is moved or recreated by Cloudflare deployment. No Containers, R2, D1, Worker custom domains, or CLI credentials are provisioned
in this release. The Tunnel wizard below provisions an origin Tunnel and its DNS
record on an existing Cloudflare domain. Existing host-local Codex gateways must remain reachable by Linux.

## Prepare the Linux origin

1. Run the current DeskSwarm dashboard on the Linux execution service with its
   existing persistent data volume and Docker/SSH configuration.
2. Use the **automatic Tunnel wizard** below, or give that service a public
   **HTTPS** origin yourself. It must reach the dashboard, not Docker's API or a desktop port.
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

## Automatic Tunnel setup (no server commands)

Use **إعداد Cloudflare Tunnel تلقائيًا** on the same Cloudflare settings screen.
It can use the saved account token without entering it again. For a new account,
enter the token, Account ID and Worker name above; the existing-origin HTTPS field
can remain blank while you configure a Tunnel. Account discovery is optional:
restricted tokens may not list accounts, in which case type the ID directly.

1. Add account **Cloudflare Tunnel Edit**, **Zone Read** and zone **DNS Edit**
   permissions alongside Worker deployment/DO permissions. The domain must already
   be active in that Cloudflare account. Domain registration is not performed.
2. Choose Local Docker or a previously connected Linux/SSH server. Discover the
   running DeskSwarm dashboard service. Detection uses the application's Docker
   label, Compose service identity or existing DeskSwarm dashboard name. It chooses
   the service's existing private Docker network and validates `/health` from a
   disposable, constrained curl container on that same network.
3. Load domains, choose one and enter a new origin hostname such as
   `deskswarm-origin.example.com`. The wizard refuses an existing unrelated DNS
   record, including A/AAAA records. It never silently overwrites another service.
4. **فحص الإعدادات** performs read-only Cloudflare checks and the Docker probe.
   **إنشاء النفق وربط التطبيق** consumes the exact tested five-minute ticket and
   starts a persistent background job. It creates a remotely managed Tunnel,
   writes ingress for that dashboard plus a catch-all HTTP 404, adds a proxied
   CNAME, retrieves the connector token, and starts cloudflared on the chosen
   server over Docker's existing pinned SSH channel (or Local Docker).
5. The connector uses the official `cloudflare/cloudflared:2026.10.3` image pinned
   to manifest digest `sha256:faa8e0a1475f137c910be6025f43c8e4092fdd35461b31e19fd1390657a1ff39`.
   It publishes no ports, drops capabilities, has a read-only filesystem, bounded
   memory/process/log usage, and restarts unless stopped. Its token stays out of
   the UI/API/audit; as with other container secrets, trusted Docker administrators
   can inspect its runtime environment. No API token is passed to cloudflared.
6. The wizard waits for HTTPS origin health before changing the saved Worker
   origin. Leave **نشر Worker وDurable Objects بعد نجاح Tunnel** selected to finish
   both in one job; otherwise deploy the gateway later with the existing button.

A Linux host with only Docker and no running DeskSwarm dashboard is shown as
**غير مجهّز**. The wizard does not install a second dashboard, migrate its data,
replace its users, or install Docker/NetBird. Peers can remain in the network
inventory while the operator prepares them. A valid SSH host fingerprint/private
key and outbound Cloudflare connectivity (port 7844) are still prerequisites.

### Recovery and stopping

Resource intent is saved before external changes. A random stable Tunnel name,
Tunnel UUID and DNS record ID allow re-testing and retrying to reuse partially
created resources. On a timeout after a Tunnel/DNS creation, retry first checks
for the resource it owns; it does not blindly create a duplicate. Failed setup
keeps the previously configured origin intact. Running jobs block another
provision/deploy/stop and prevent removal of their associated SSH connection.

Use **ملء الإعدادات / إعادة المحاولة** to restore a saved Tunnel configuration,
then test and start again. Use **فحص الوصول** for a fresh HTTPS health check;
status records otherwise describe the last operation. A failed Worker deployment
can coexist with a ready Tunnel, allowing a deployment retry after permissions
are fixed.

**إيقاف النفق** stops only the application-owned connector. It keeps DNS, the
Tunnel and data for a reversible restart. A stopped or incomplete setup can be
re-tested and started again; unrelated containers are refused by ownership labels.
Stopping a Tunnel can make Worker versions that use its origin unavailable. The
original Linux dashboard remains accessible by its previous network address.
Cloudflare namespaces/DNS resources are not deleted automatically on errors.

The automatic path needs a real API Token/account and active domain. No user
Cloudflare credentials were supplied for development: management APIs were tested
with fixtures, not by creating a public Tunnel in a real account. Separately, the
real Linux Docker dashboard was discovered and probed; the pinned cloudflared
image was created/stopped with a deliberately invalid fixture token to validate
container lifecycle/security settings without establishing an Internet tunnel.

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

- 290 application tests, TypeScript and the production Docker build.
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

- `GET /api/v1/cloudflare/status`: public connection fields, recent jobs and Tunnels.
- `POST /api/v1/cloudflare/test`: `{account, worker, origin, token}` → test ticket.
- `POST /api/v1/cloudflare/connection`: same fields plus `test_token` → save.
- `POST /api/v1/cloudflare/deploy`: `{}` → HTTP 202 with job id.
- `GET /api/v1/cloudflare/versions`: available account Worker version identifiers.
- `POST /api/v1/cloudflare/rollback`: `{version}` → HTTP 202 with job id.

References: [authorization](https://developers.cloudflare.com/workers/authorization/),
[module upload](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/),
[deployments](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/),
[rollback limits](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

### Discovery and Tunnel API

- `POST /api/v1/cloudflare/accounts`: `{token}` (or reuse the saved token).
- `POST /api/v1/cloudflare/zones`: `{account,token}` (saved token may be omitted).
- `POST /api/v1/cloudflare/targets`: `{server_id}` (`0` = Local Docker).
- `POST /api/v1/cloudflare/tunnel/test`: `{account,token,worker,zone,hostname,server_id,backend,deploy}` → test ticket.
- `POST /api/v1/cloudflare/tunnel`: same fields plus `test_token` → HTTP 202 job id.
- `POST /api/v1/cloudflare/tunnels/:id/check`: `{}` → current HTTPS readiness.
- `POST /api/v1/cloudflare/tunnels/:id/stop`: `{}` → stop owned connector, retain resources.

Tunnel API reference: [Cloudflare's remotely managed Tunnel workflow](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/).

## Quick install buttons

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ahmedvnabil/deskswarm)
[![Open Tunnel setup](https://img.shields.io/badge/Cloudflare-Open_Tunnel_setup-F38020?logo=cloudflare&logoColor=white)](http://localhost:7861/settings/cloudflare)

### Recommended: managed setup from DeskSwarm

1. Start DeskSwarm on Linux (or connect its Linux Docker server through SSH).
2. Open the **Tunnel setup** button on the computer running the dashboard. For a
   remote dashboard, use its own Settings → Cloudflare panel instead of localhost.
3. Enter the scoped Cloudflare token locally, discover the service and zone,
   choose a new origin hostname, test and create the Tunnel.
4. Enable Worker + Durable Objects deployment in the tracked setup operation.
   Use the same panel for progress, connector restart and Worker rollback.

### Alternative: official Deploy to Cloudflare button

Use this when the Linux dashboard already has a healthy public HTTPS origin.
The repository root contains a Wrangler template pointing at the **same Worker
source** used by the managed installer; it provisions the `DEVICES` SQLite
Durable Object binding and `deskswarm-v1` migration.

1. Click **Deploy to Cloudflare** and authorize Cloudflare's repository workflow.
2. Replace `ORIGIN` with the dashboard origin, such as
   `https://origin.example.com`, without a path. Never enter the Worker URL.
3. Set `EDGE_SECRET` to a unique random value (for example, generated locally
   with `openssl rand -hex 32`). Keep it secret; it protects the edge health
   endpoint, while normal dashboard authentication remains on Linux.
4. Deploy, then open the Worker URL and sign in. Verify a desktop preview and
   input, not just the deployment status. `/_edge/health`
   requires `Authorization: Bearer <EDGE_SECRET>`.

The button does not install Linux, Docker, cloudflared or DNS, and it does not
save a Cloudflare API token into your Linux dashboard. For automatic Tunnel
installation and deployment history in DeskSwarm, use the managed setup path.
Manage a button-created Worker's versions in Cloudflare; do not alternate
Wrangler and DeskSwarm deployments on the same Worker without reviewing its
bindings and migration history. Separate Worker names are simplest.

For a local packaging check, run `npm ci && npm run check:edge` from the repository
root. For CLI deployment, configure `ORIGIN`, authenticate Wrangler, set
`EDGE_SECRET` with `npx wrangler secret put EDGE_SECRET`, then `npm run deploy`.
Local secrets belong in ignored `.dev.vars`; the example contains no real token.

Button behavior follows the official [Cloudflare deploy button documentation](https://developers.cloudflare.com/workers/platform/deploy-buttons/).
A successful local package/runtime test does not constitute a live Cloudflare
account deployment; that requires your own account, origin and credentials.

### Quick setup inside the workspace

The Cloudflare panel starts with three compact steps: choose/link Linux through
SSH or NetBird, enter the Cloudflare account, then create the Tunnel and deploy
Worker + Durable Objects. The internal buttons scroll to and focus the relevant
controls without leaving the device preview. Connecting a Docker host does not
install the DeskSwarm dashboard there: service discovery must find a running
dashboard, or choose the current local Docker host.

The server selector refreshes when returning from Connections, while preserving
the selected server, account draft and discovered service. If the selected server
was removed, the service selection and tested Tunnel ticket are cleared. The
external Deploy to Cloudflare button opens a separate tab and is explicitly
labelled as an alternative for an existing HTTPS origin.

Validation: all 305 application tests passed; the dashboard image built. In the
running dashboard, service discovery selected `deskswarm-dashboard:7000`, the
quick buttons focused the correct controls, and a Worker name draft survived
switching to Connections and back without changing the outer workspace URL.
No live Cloudflare resources were created for this UI validation because no
Cloudflare account credentials are configured.
