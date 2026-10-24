# Native Cua Driver migration and acceptance

## Architecture change

Every machine now has one XFCE desktop container containing Cua Driver 0.38.0.
The dashboard uses the machine provider's native `driverCall`; there is no
HTTP/SSE control service, control sidecar image, per-machine control address,
or pilot/backend-selection setting. Screenshots, pointer/keyboard input,
clipboard paste and readiness all use the same native runtime. Shell/files
remain provider operations. noVNC remains the human viewer.

Removed: `bridge/`, `src/bridge.ts`, the old transport parser, sidecar lifecycle,
sidecar memory/environment settings, sidecar restore helper dependency and its
old troubleshooting document. The restore helper now uses the already-local
desktop image with an overridden entrypoint.

The JSON machine view replaces `bridge_ok` with `control_ok` and removes
`bridge_host`, `bridge_port` and `bridge_state`. Update API consumers accordingly.
The external machine-scoped MCP tool names and authentication remain unchanged.

## Runtime pins

- XFCE index: `sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b`.
- Driver release: `cua-driver-rs-v0.38.0`.
- ARM64 archive SHA-256: `80c9ae66bc7322052dd426c6133c96086b33894bf06c972bca8215384400b33d`.
- AMD64 archive SHA-256: `31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd`.

`desktop/install-driver.py` verifies the digest before installing the binary.
The service uses `/usr/local/bin/cua-driver`, not the image's older Python
wrapper. Supervisor runs it as `cua`, with DISPLAY=:1, the user's Xauthority
and the graphical session D-Bus. The binary path is also first on PATH.
Input dispatch uses argument arrays and a bounded CLI deadline. A timeout does
not prove an input failed; observe state before retrying. No action is replayed
through an alternate backend.

## New installations

```sh
docker compose up -d --build
```

The first machine builds `deskswarm-desktop:0.38.0` from `/desktop-src`, mounted
from `desktop/`. This can take several minutes. Alternatively prebuild it:

```sh
docker build -t deskswarm-desktop:0.38.0 desktop
```

Custom images must provide the same native binary and graphical-session service.
The default image supports AMD64 and ARM64; live behavioral evidence below is
from ARM64. Keep screenshots and input coordinates at the same native scale.

## Existing installations: preserve data before switching

This is a breaking runtime upgrade. It does not silently convert old snapshots
or erase/recreate a running fleet just to install Driver.

1. Back up the dashboard database/data volume with the dashboard stopped, plus
   each machine's home archive and any custom snapshots/images. Keep the old
   Compose configuration and release commit with that backup. Root filesystem
   software is in the image/snapshot, not a home-directory backup.
2. Stop old control sidecars; do not remove desktop containers, home volumes or
   backups. Inventory the exact old container names before removing them.
3. Build the native desktop image above. For existing customized desktops,
   either upgrade their native binary/service in place from `desktop/` and
   commit a new snapshot, or recreate from the native image and restore the
   home archive using the normal backup workflow. In-place upgrades must stop
   any existing Driver daemon before replacing its executable, append the
   Supervisor program only once, then reload Supervisor.
4. Record the upgraded image on the machine's `computers.image` row so recovery
   recreates that upgraded image, not an old snapshot without Driver. In-place
   root changes without a corresponding image/snapshot will be lost on recreation.
5. Rebuild/restart the dashboard from this release. Check `control_ok`, a fresh
   screenshot and a disposable input task for each upgraded machine.
6. Remove the inventoried old sidecar containers/images and obsolete mounts or
   environment settings after the native machines are verified. Do not remove
   named home/data volumes or use `docker compose down -v` for this upgrade.

Old snapshots stay valid as backup artifacts but do not automatically gain a
Driver. Upgrade or retire them explicitly before using them for new machines.
Users, keys and home data remain in the existing database/volumes; there is no
schema migration that rewrites them. The local experiment removed its old
sidecar container and image while keeping the desktop and its home intact.

## Reproducible live acceptance

Provision only the disposable test machine with `python3-gi`,
`gir1.2-gtk-3.0`, `xclip` and `fonts-noto-core`. Copy
`dashboard-ts/scripts/driver-acceptance.py` to `/tmp/deskswarm-fixture.py` and
start `/usr/bin/python3 /tmp/deskswarm-fixture.py` as user `cua` in its X session.
At 1280×900 the fixture starts at (150,150). Inspect a fresh screenshot first;
the smoke's coordinates depend on that position, resolution and theme.

From the dashboard container run:

```sh
bun scripts/driver-smoke.ts <disposable-machine-slug>
```

The smoke creates a temporary, machine-scoped MCP key and revokes it in a
finally block. It exercises the real authenticated HTTP MCP endpoint, while
the GTK application independently writes its text, button count, selected
substring and actual scroll adjustment. Bounded readback polling allows the
application event loop to settle without repeating input actions.

Validated on Debian 12/XFCE/TigerVNC, Linux ARM64, Docker in a dedicated Colima
profile on Apple Silicon (4 CPUs / 6 GiB):

| Operation | Independent application evidence |
| --- | --- |
| Screenshot | Nonblack native PNG, 1280×900; shared wall capture succeeds |
| Click | Button count increments exactly once |
| English / Ctrl+A / BackSpace | Entry reads exactly `MCP 4` |
| Arabic | UTF-8 clipboard plus Driver Ctrl+V produces `MCP 4 مرحبا بالعالم` |
| Drag | Selection starts empty, then reads exactly `DRAG SELECT THIS TEXT` |
| Scroll down | Actual GTK adjustment increases from 0 to about 299.24 |
| Scroll up | Adjustment decreases from about 299.24 to about 119.70 |
| Daemon restart | Missing daemon is an explicit failure; fresh capture returns after start |
| Desktop sleep/wake | Native readiness returns ready=true, recreated=false; fresh PNG succeeds |
| Desktop restart | Supervised native Driver returns without manual daemon launch |

The drag starts inside the text, not the entry's padding; pressing its margin
was a no-op and was caught by the empty-selection assertion. Scroll assertions
compare direction, not timing-sensitive animation pixels. These results cover
this tested desktop, not generic Wayland/background input or every application.

Run automated checks from `dashboard-ts/` so its Bun preload isolates the test
database: `bun test` and `bunx tsc --noEmit`. The unit suite stubs the machine
provider. All 239 tests and the pinned TypeScript check passed. Runtime data is in a Docker named volume, separate from unit tests.
The dashboard Docker healthcheck uses Bun fetch; dependency install scripts are
disabled in its toolchain-free image (the local Docker socket needs no optional
SSH native acceleration).

## Release rollback

There is no runtime legacy switch in this application. If a release rollback
is necessary, stop this dashboard and use the pre-upgrade commit
`ee341c0d096dbe56112ee14839fc3720224e75d7` with the matching data/config backup.
That release can recreate its control sidecars against the preserved desktops.
Rebuild its images and run its own Compose configuration. Do not restore a live
SQLite file over a running process or delete a home volume as a rollback step.
Git history is preserved; no force-push or history rewriting is required.
