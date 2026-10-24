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
configuration, lifecycle deletion and automatic NetBird enrollment are not included.

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
