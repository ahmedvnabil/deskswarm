# Proxmox CT provisioning

Open **الاتصالات وNetBird → Proxmox · إنشاء CT سريع** below the desktop preview.
Choose an existing pinned SSH server whose user is `root`, then **اختبار واكتشاف الإعدادات**.
DeskSwarm discovers that host's local Proxmox node, active rootfs storage, bridges,
cached Debian/Ubuntu templates, existing CTs, and the next available VMID.
No additional Proxmox API token or disabled TLS verification is needed.

Select the template, storage, bridge, CPU count, memory, disk, and hostname.
Save defaults for the next run, or create directly. The optional first-computer
checkbox creates a DeskSwarm desktop inside the newly provisioned CT.

## What creation does

1. Revalidates the live node, template, storage and available disk space. A duplicate
   CT hostname is rejected; `pct create` also refuses an already occupied VMID.
2. Creates a new unprivileged CT with `nesting=1,keyctl=1`, DHCP on the selected
   bridge, on-boot startup, and a `deskswarm` tag. Existing CTs are never modified.
3. Installs OpenSSH and Docker Engine from Docker's official Debian/Ubuntu apt
   repository, starts the services, and runs the disposable `hello-world` container.
4. Reads the assigned IPv4 address and SSH host key **through the pinned Proxmox SSH
   connection**. The public part of the existing SSH key is installed into the CT;
   its private part is never copied into the CT.
5. Tests pinned SSH and the Docker API from the dashboard, then registers the CT
   as a managed Docker server. Optionally builds the native Cua Driver desktop image
   and creates the first computer on that server.

The browser polls persisted job stages while provisioning is active and the panel
is visible. The table shows this managed server even if it is not a NetBird peer.
The CT is not automatically enrolled into NetBird. The dashboard must be able to
reach its DHCP address; a private LAN route is sufficient.

## Failure and recovery

Only one provisioning job per Proxmox server runs at a time. Removing the host
or newly registered server is blocked during an active job. Failed or interrupted
jobs retain their VMID, stage, timestamp and safe error message. **No CT, disk,
image, or desktop is automatically destroyed or overwritten.** Review the recorded
CT in Proxmox before starting another job. A dashboard restart marks unfinished
jobs interrupted; it never repeats an interrupted create request.

If the CT is ready but optional desktop creation fails, its registered Docker
server remains usable: select that server in the normal **جهاز جديد** dialog.
Current provisioning supports the local node of each saved SSH connection,
existing Debian 12/13 or Ubuntu 22.04/24.04/26.04 templates, DHCP IPv4, and root
SSH access. Multi-node API-token orchestration, template downloads, static network
configuration, CT deletion and automatic NetBird enrollment are not included.

## Validation

The implementation was exercised against Proxmox VE 9.2 on October 24, 2026:
a real Debian 13 unprivileged CT was created with 2 cores, 4096 MB RAM and a 24 GB
disk; Docker and `hello-world` worked; a native Cua Driver desktop was created
inside the CT; an actual Driver command returned AMD64 architecture and Arabic text.
Unit/integration tests additionally cover authentication/CSRF, shell-input validation,
failed provisioning, credential redaction, and concurrent job/deletion guards.

References: [Proxmox pct manual](https://pve.proxmox.com/pve-docs/pct.1.html),
[Docker Engine on Debian](https://docs.docker.com/engine/install/debian/).

## API

All routes require dashboard authentication; writes also use the same-origin guard.

- `GET /api/v1/connections/proxmox`: saved non-secret defaults and recent jobs.
- `POST /api/v1/connections/proxmox/discover`: `{server_id}`.
- `POST /api/v1/connections/proxmox/settings`: save tested provisioning defaults.
- `POST /api/v1/connections/proxmox/create`: create one asynchronous job, returning
  `{id,vmid}`. Fields: `server_id`, `hostname`, `template`, `storage`, `bridge`,
  `cores`, `memory` (MB), `disk` (GB), `start_desktop` (boolean).

## CT management and multiple desktops

The same panel now lists local CTs with state, CPU utilization and allocated
cores, used/total RAM and disk, and linked DeskSwarm desktops. Metrics come from
Proxmox's `/cluster/resources` samples; their freshness follows `pvestatd`.
Linked CT state is additionally checked with `status/current` to avoid treating a
recently stopped CT as running because of a delayed metrics sample. Missing
metrics display a dash. The view refreshes every 15 seconds while visible;
auto-refresh can be disabled, and manual refresh is always available.

- **تشغيل** starts the selected CT.
- **إيقاف** uses `pct shutdown --timeout 60`, with no forced stop or deletion.
- **إعادة تشغيل** uses `pct reboot --timeout 60`.

Changing CT state affects every computer inside it. Operations are serialized
per CT, persisted and audited; changing state is refused when a linked computer
is owned by an Agent or has an active external operation. New computer mutations
and server removal are blocked while a lifecycle operation runs. After start or
reboot, the dashboard checks the CT's SSH fingerprint through its pinned parent,
refreshes its DHCP address if needed, and waits for SSH/Docker readiness. Existing
host keys are never silently replaced. Restarting the dashboard marks unfinished
operations interrupted; it never repeats a previous reboot or creation.

For a running CT registered by DeskSwarm provisioning, select the CT, a name
prefix, and a count (1–10). Desktop names are numbered automatically and skip
existing names across the fleet. The job records each created computer and
individual failures, so partial successes stay usable. Basic RAM/disk headroom
checks reject clearly oversized batches; workloads still share the CT's limits.
The CT list includes other existing CTs, but creating desktops requires a mapped
Docker server from DeskSwarm provisioning. It does not install credentials into
unmapped CTs or infer ownership from a hostname alone.

The lifecycle validation on CT 100 exercised graceful shutdown, start and reboot,
verified a persistent Arabic test file after both transitions, then created two
additional desktops in one batch. Driver commands and screenshots worked on
both, and a file written inside one desktop was absent from the other.

Additional API routes:

- `GET /api/v1/connections/proxmox/cts?server_id=<pinned SSH server>`:
  live inventory, resource samples, linked computers and recent operations.
- `POST /api/v1/connections/proxmox/cts/:vmid/actions`: body
  `{server_id, expected_name, action}` with `start`, `stop`, `restart`, or
  `computers`. The latter also takes `prefix` and integer `count`. Returns HTTP
  202 with an operation ID; inspect it in the inventory's `operations` list.
  A stale CT name, concurrent operation, active Agent or invalid batch is refused.
