# DeskSwarm

Self-hosted Linux desktops for people and AI agents. Create independent XFCE
machines from one dashboard, watch their screens, share a machine, or give an
MCP client its own revocable access key.

**Each machine is one desktop container with Cua Driver inside it.** Use the
Agents page to choose a desktop and model, run a task and download its results,
or connect your own external MCP client. Managed Agents call the model endpoint
you configure; external clients continue to bring their own model.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/zadstack/deskswarm)
[![Set up Cloudflare Tunnel](https://img.shields.io/badge/Cloudflare-Tunnel_setup-F38020?logo=cloudflare&logoColor=white)](http://localhost:7861/settings/cloudflare)
[![Quick start](https://img.shields.io/badge/Linux-Quick_start-0f766e?logo=linux&logoColor=white)](#run)

**Start Linux first.** The Cloudflare button deploys the edge gateway and SQLite
Durable Objects, not the Docker desktops. Supply your existing Linux dashboard's
public HTTPS origin during deployment. The Tunnel setup button opens your local
running dashboard. [Choose your Cloudflare setup path](docs/CLOUDFLARE.md#quick-install-buttons).

## Run

Docker and Docker Compose are required:

```sh
git clone https://github.com/zadstack/deskswarm.git
cd deskswarm
docker compose up -d --build
```

Open [localhost:7861](http://localhost:7861). The first launch prints the
initial admin credentials in the dashboard container log. Add a machine from
the dashboard. The first machine builds the pinned native desktop image;
subsequent machines reuse it. This download/build can take several minutes.

Cua Driver 0.38.0 and the XFCE base image are pinned. The installer supports
Linux ARM64 and AMD64 and verifies the archive's published SHA-256 digest.
The native runtime was validated on ARM64 and on AMD64 inside a real Proxmox CT.

On macOS, `./mac/build-app.sh` builds the existing Dock application launcher.
It requires a working Docker runtime. Keep its checkout outside macOS-protected
Desktop/Documents/Downloads folders; see the launcher's diagnostic output.
`make doctor` checks common deployment problems.

## What you can do

- Use a compact light workspace: Agents, connections and settings open below
  the selected desktop preview, with the same sidebar and preserved form drafts.
- Search a compact server table, filter ready/needs-setup hosts, see connection
  failure reasons and retry a server from its row.
- Import NetBird peers from Cloud or a self-hosted instance; keep offline and
  unconfigured devices visible while connecting supported Linux Docker hosts.
- Provision Proxmox CTs, start/stop/restart them, inspect CPU/RAM/disk usage and
  batch-create 1–10 independent desktops inside a linked CT.
- Configure Cloudflare Tunnel, DNS and connector installation, then deploy the
  Worker gateway with deployment progress and Worker version rollback.

- Create, rename, remove and batch-create machines without editing Compose.
- Watch cached screen tiles; open an interactive noVNC session when needed.
- Run shell commands, inspect installed software, upload/download files and
  copy text through each machine's clipboard.
- Save snapshots for repeatable environments, back up home directories and
  restore them without merging unrelated files into a backup.
- Sleep idle machines and wake them on demand, including the first MCP call.
- Share a single machine with an expiring, revocable link.
- Issue a machine-scoped MCP key; watch the client's tool activity and revoke
  that key without affecting other machines.
- Inspect the audit trail for state changes and guest access.

The desktop container has per-machine CPU, memory and process limits. Resource
limits may be unavailable in nested Docker/LXC environments; configure the
host budget in `.env.example` for that case. Size capacity for the applications
actually running, especially browsers. Cached tiles avoid a live video stream
for every machine on the wall.

## Connect Linux servers

The Arabic dashboard groups desktops by server, with a persistent screen preview,
Agent controls and a searchable server table. Choose **ربط سيرفر** to test and save a Linux Docker host
over SSH. Private keys are encrypted and host key fingerprints are required.
Remote screens use an authenticated SSH tunnel; no public Docker API or VNC
port is needed. See [server setup and validation](docs/SERVERS.md).

See [NetBird and connection diagnostics](docs/CONNECTIONS.md) and
[Proxmox CT provisioning, management and validation](docs/PROXMOX.md).
CT lifecycle changes are blocked while a managed agent owns a linked desktop.
Other CTs remain visible; desktop creation requires a verified Docker mapping.

## Run a managed agent

Open **Agents** from the dashboard. Under **Model connections**, add your
provider base URL, exact model ID, API key and protocol (Responses or Chat
Completions). Enable screenshots only for a vision-capable model. Select a
desktop and connection, describe the task, then choose **Run agent**. The page
shows a refreshing desktop preview and activity log. **Watch desktop** opens
a viewer; **Stop agent** stops further work, and **Take control** also reserves
the desktop for you. Release manual control before starting another run.

**Download results** provides a `.tar.gz` containing the report, activity log
and files the agent explicitly saved. Failed and stopped runs retain partial
results. One managed agent owns each desktop; another managed run and external
MCP actions are refused until the current action drains.

See [Agents setup, limits and live validation](docs/AGENTS.md), including the
optional private gateways for signed-in Codex and Claude Code CLIs, including
independent services on the permanent Linux host.

## Connect an external agent

Issue a key from the machine's access panel and use the command shown there:

```sh
claude mcp add --transport http research-01 \
  https://swarm.example.com/mcp/research-01 \
  --header "Authorization: Bearer dsk_..."
```

A key grants screen, input, shell, home files and clipboard access to exactly
one machine. An expired or revoked key is refused on the next call. Shell and
file operations use the machine provider; screen/input use the native Driver
running as the graphical desktop user. There is no separate control container
or control HTTP service to configure.

For Arabic and other non-Latin text, DeskSwarm uses the UTF-8 clipboard followed
by Driver Ctrl+V. Terminals that do not bind Ctrl+V need a file/shell workflow.
Desktop input acts on the visible session; coordinate one controller at a time.
After an input timeout, inspect fresh state before retrying the action.

## Architecture

```text
Browser / machine-scoped MCP client
                  |
     Dashboard: Bun + Hono + HTMX + SQLite
                  |
     Local Docker / pinned SSH Docker provider
                  |
       One container per machine
       XFCE + TigerVNC/noVNC + Cua Driver
       + persistent home volume
```

Driver is supervised inside the same graphical session as the applications,
with the desktop user's display, Xauthority and D-Bus environment. The provider
executes the pinned CLI using an argument array, as user `cua`, with a bounded
deadline. The application has one control path for every machine.

The default image is `deskswarm-desktop:0.38.0`; its source is in `desktop/`.
Custom images and snapshots must contain `/usr/local/bin/cua-driver` and its
supervised graphical-session service. The dashboard mounts `desktop/` read-only
to build the default image on first use.

## Upgrade an existing installation

Read [the native Driver migration and validation guide](docs/CUA_DRIVER_MIGRATION.md)
before updating an existing fleet. Existing home volumes, backups, users and
MCP keys must be preserved. Old snapshots do not automatically gain a native
Driver. This release removes the previous control sidecar and its configuration;
there is no runtime switch back to it. Recovery to an older release is an
explicit Git/release rollback with a matching data backup.

## Development

```sh
cd dashboard-ts
bun install --frozen-lockfile
bunx tsc --noEmit
bun test
```

Run the tests from `dashboard-ts/`: its preload config provides isolated test
state. The suite stubs the machine provider, so Docker is not required for unit
tests. The live GTK acceptance fixture separately validates clicks, typing,
Arabic, drag selection and scroll adjustment through authenticated MCP.
See [CONTRIBUTING.md](CONTRIBUTING.md).

## Deployment and access

Read [SECURITY.md](SECURITY.md) before exposing the dashboard. It mounts the
Docker socket and is a privileged administration surface. Use TLS on a public
host and configure `DESKSWARM_SCREEN_BIND` / `DESKSWARM_SCREEN_PROXY` for viewer
access. Give agents only the files and credentials appropriate to their work.

The [JSON and MCP API reference](docs/APIs.md) covers machine management,
backups, sharing, access keys and audit events. State-changing dashboard requests
require a valid session or dashboard token and pass the cross-site guard.

Built on [Cua](https://github.com/trycua/cua). MIT; see [LICENSE](LICENSE).

### Cloudflare edge deployment

Connect a scoped Cloudflare API Token from Settings, test the account and Linux HTTPS origin, deploy Worker + SQLite Durable Objects, follow deployment stages, and roll back to a previous Worker version. Docker, Agents and persistent application data stay on Linux. See [Cloudflare setup, validation and recovery](docs/CLOUDFLARE.md).

### Connections and NetBird

[The connections center](docs/CONNECTIONS.md) imports NetBird Cloud/self-hosted peers,
keeps offline/unconfigured hosts visible, and starts pinned SSH/Docker setup with
saved username/port defaults. Cloudflare settings can discover a dashboard service,
create an origin Tunnel and DNS record, start its Linux connector, verify HTTPS,
and deploy Worker + Durable Objects as one tracked operation. Partially created
resources support retry; connectors can be stopped and restarted without deleting
DNS or desktop data. Account tokens are entered locally and stored encrypted.

### One workspace

Agents, Settings, Connections/NetBird and Cloudflare open as tabs below the device
preview, with one sidebar and shared compact light identity. Tabs preserve form drafts
while switching; bookmarked views use the same shell without redirects. See
[connections and workspace behavior](docs/CONNECTIONS.md#unified-workspace-below-the-device-preview).
