# DeskSwarm

Self-hosted Linux desktops for people and AI agents. Create independent XFCE
machines from one dashboard, watch their screens, share a machine, or give an
MCP client its own revocable access key.

**Each machine is one desktop container with Cua Driver inside it.** The
client brings the model; DeskSwarm provides the computer. DeskSwarm does not
call a model API or require a model API key.

## Run

Docker and Docker Compose are required:

```sh
git clone https://github.com/ahmedvnabil/deskswarm.git
cd deskswarm
docker compose up -d --build
```

Open [localhost:7861](http://localhost:7861). The first launch prints the
initial admin credentials in the dashboard container log. Add a machine from
the dashboard. The first machine builds the pinned native desktop image;
subsequent machines reuse it. This download/build can take several minutes.

Cua Driver 0.38.0 and the XFCE base image are pinned. The installer supports
Linux ARM64 and AMD64 and verifies the archive's published SHA-256 digest.
The native runtime was validated on ARM64; AMD64 is built in CI.

On macOS, `./mac/build-app.sh` builds the existing Dock application launcher.
It requires a working Docker runtime. Keep its checkout outside macOS-protected
Desktop/Documents/Downloads folders; see the launcher's diagnostic output.
`make doctor` checks common deployment problems.

## What you can do

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

## Connect an agent

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
          Docker machine provider
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
