# Servers over SSH

The dashboard groups desktops by Docker host. Local keeps using the existing
Docker socket; additional Linux hosts use pinned SSH connections. Choose
**ربط سيرفر**, test the connection, then save it. New desktops can be created on
the selected host, and managed Agents, files, snapshots and native Cua Driver
operations route to that desktop's recorded provider.

## Requirements and setup

- A Linux server with Docker Engine **and the Docker CLI** installed, including
  `docker system dial-stdio` support. The SSH account must be able to run Docker
  without an interactive sudo/password prompt. Docker access is administrative
  access to that host; use a dedicated key and a trusted dashboard account.
- A private SSH key, with an optional passphrase. Password-only login and SSH
  agent forwarding are not used. Enter the SSH host/port/user in the dialog.
- The server's SSH **host key fingerprint**, verified through its trusted
  console or administrator. For an Ed25519 host key, read it on the server with
  `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256`.
  Copy the `SHA256:...` value. It must match the host key negotiated by SSH;
  an incorrect identity is refused, never accepted automatically.
- Network access from the dashboard to that SSH port. No remote Docker TCP API
  is required. Server hostnames are resolved by the dashboard/container.

A successful test reads real Linux Docker information and issues a five-minute
save ticket. Changing any field (including the key, passphrase or name) requires
another test. A ticket is single-use and binds the exact tested configuration.
The private key and passphrase are encrypted using the same AES-256-GCM master
key as model connections, stored beside the database in `.agent-secret-key`.
Neither credential is returned in responses or audit details. Use HTTPS when
accessing a dashboard outside localhost.

## Screens and isolation

Remote desktops publish noVNC only on **127.0.0.1 on their Docker host**.
The authenticated dashboard carries screen WebSockets through an SSH forward
to that exact desktop's recorded loopback port. No public VNC ports or Docker
API listener are needed. The viewer uses the dashboard origin, including HTTPS.

The browser's noVNC HTML, scripts and styles come from the application's pinned
noVNC 1.7.0 copy, **never from the remote container**. This prevents a desktop
process or Agent from replacing client JavaScript on the dashboard origin.
Only the screen protocol is forwarded from the remote host.

Control shares receive an HttpOnly grant scoped to one `/remote-screen/<id>/`
path. The share is checked again on assets and new WebSocket connections;
revoked or expired grants cannot create a new connection or reach fleet APIs.
An already-open control connection can retain access, as with existing control
shares; rotate the screen password/restart the desktop for a hard cutoff.
Watch shares retain their revocable screenshot path.

## Current limits

- One dashboard process per data volume. All signed-in users retain the existing
  shared administration permissions. There is no new multi-tenant boundary.
- The first desktop on a host builds the native image using `desktop/` streamed
  to that host's Docker builder. Existing snapshots stay on their source host.
  The image and home volumes remain on that host; file/backup downloads return
  to the dashboard. Removing a connection is refused while it owns desktops,
  snapshots or an in-flight provider operation.
- Docker's default `bridge` network and per-container resource limits are used
  remotely. Local memory/disk admission readings apply only to local creation;
  remote hosts use per-container limits where the kernel supports them,
  with the existing unsupported-kernel fallback and Docker admission errors.
  Live remote host free-memory/free-disk admission is not implemented.
- Desktop names remain unique across the fleet. Existing local desktop rows,
  volumes and MCP keys do not move or get recreated by this upgrade.
- To change an SSH identity or rotate its stored key, first remove its managed
  desktops/snapshots, remove the connection and add/test a new connection.
  In-place server key editing and host migration are not part of this release.

## JSON API

All endpoints require a session or dashboard token and the existing cross-site
guard for mutations. Responses use `{ok,data,error}`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/v1/servers` | Local host plus saved SSH hosts; never returns secrets |
| POST | `/api/v1/servers/test` | Test `name`, `host`, `port`, `username`, `fingerprint`, `private_key`, optional `passphrase`; returns `test_token` and Docker info |
| POST | `/api/v1/servers` | Same exact config plus `test_token`; save encrypted connection |
| POST | `/api/v1/servers/:id/test` | Recheck saved connection and update reachability |
| DELETE | `/api/v1/servers/:id` | Remove an unused connection; 409 while in use |
| POST | `/api/v1/computers` | Existing creation body plus `server_id`; `0` means Local |

Machine providers are `docker` for Local and `server:<id>` for SSH. Existing
machine-scoped MCP endpoints and Agents use this provider automatically.
Advanced fleet tools remain available under `/manage` through Settings.

## Validation, 2026-10-24

Tested with an actual SSH daemon fixture in the local Linux ARM64/Colima VM,
using a generated test key and the VM's Docker daemon. This exercises real SSH,
Docker and VNC transports; it is not evidence of testing a separate Internet VPS.

- Wrong host fingerprint refused; correct key negotiated and Docker info read.
- Tested, saved and created a Linux desktop through both JSON APIs and the new
  browser form. Editing the form invalidated its save eligibility.
- Remote shell returned Arabic; native Driver screenshot returned a PNG.
- Browser VNC connected through SSH. A mouse click opened Terminal; individual
  keyboard events created a home file, then an independent file download
  verified its existence. Bulk computer-use paste into VNC is not a substitute
  for real key events; no application clipboard claim is made from that test.
- A real Codex-backed Agent, started through the new dashboard on an SSH-owned
  desktop, wrote, read and saved `ssh-agent-result.txt`. The downloaded result
  contained exactly `نجاح` (8 UTF-8 bytes), without a newline.
- Tests cover exact fingerprint pinning, encrypted/write-only keys, expired,
  changed and replayed tickets, failed tests, connection removal protection,
  concurrent Docker context separation, real SSH/HTTP framing, application-owned
  viewer assets, scoped guest control grants and static-path confinement.

The final full suite passed 259 tests, along with TypeScript checking,
JavaScript syntax checking and the dashboard Docker build. The SSH fixture,
its desktops/connections and temporary images were removed after validation;
the original Pilot remained intact. Local evidence stays in ignored `.local/`.

## Upgrade and rollback

Back up the data volume, including database, `.agent-secret-key` and Agent
results. Rebuild/restart the dashboard; existing local desktops continue in
place. Before downgrading, stop all runs and account for desktops/snapshots on
SSH hosts. The previous `d4a9287` build cannot operate `server:<id>` machines;
keep the new dashboard until those remote resources are removed or independently
managed. Restore a matching data backup for a full downgrade. Never delete
unrelated Docker resources or original home volumes as part of rollback.
