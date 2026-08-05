"""
Dynamic fleet management: create, destroy, inspect and shell into desktops.

A "computer" is a pair of containers on the same Docker network:
  <prefix>-desktop-<slug>  — trycua/xfce-cua, a real XFCE session over VNC
  <prefix>-bridge-<slug>   — cua-computer-server in VNC-backend mode

Both are created at runtime through the Docker API (the dashboard mounts
/var/run/docker.sock), so the fleet is not fixed by docker-compose.yml —
users add and remove machines from the UI.
"""

import os
import re
import secrets
from pathlib import Path

import docker

DESKTOP_IMAGE = os.environ.get("DESKSWARM_DESKTOP_IMAGE", "trycua/xfce-cua:latest")
BRIDGE_IMAGE = os.environ.get("DESKSWARM_BRIDGE_IMAGE", "deskswarm-bridge:latest")
BRIDGE_CONTEXT = os.environ.get("DESKSWARM_BRIDGE_CONTEXT", "/bridge-src")
CONTAINER_PREFIX = os.environ.get("DESKSWARM_CONTAINER_PREFIX", "deskswarm-dyn")
NETWORK_NAME = os.environ.get("DESKSWARM_NETWORK", "")
PUBLIC_HOST = os.environ.get("DESKSWARM_PUBLIC_HOST", "localhost")
NOVNC_PORT_BASE = int(os.environ.get("DESKSWARM_NOVNC_PORT_BASE", "6901"))
# Proxmox LXC and some nested-Docker hosts can't apply AppArmor profiles.
DISABLE_APPARMOR = os.environ.get("DESKSWARM_DISABLE_APPARMOR", "").lower() in ("1", "true", "yes")

_client = None


def client() -> docker.DockerClient:
    global _client
    if _client is None:
        _client = docker.from_env()
    return _client


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return slug or "computer"


def desktop_container_name(slug: str) -> str:
    return f"{CONTAINER_PREFIX}-desktop-{slug}"


def bridge_container_name(slug: str) -> str:
    return f"{CONTAINER_PREFIX}-bridge-{slug}"


def detect_network() -> str:
    """Find the Docker network the dashboard itself is attached to."""
    if NETWORK_NAME:
        return NETWORK_NAME
    hostname = os.environ.get("HOSTNAME", "")
    try:
        me = client().containers.get(hostname)
        nets = list(me.attrs["NetworkSettings"]["Networks"].keys())
        if nets:
            return nets[0]
    except Exception:  # noqa: BLE001
        pass
    return "bridge"


def ensure_bridge_image() -> None:
    """Build the bridge image on first use if it isn't present."""
    try:
        client().images.get(BRIDGE_IMAGE)
        return
    except docker.errors.ImageNotFound:
        pass
    context = Path(BRIDGE_CONTEXT)
    if not (context / "Dockerfile").exists():
        raise RuntimeError(
            f"bridge image '{BRIDGE_IMAGE}' is missing and no build context at "
            f"{BRIDGE_CONTEXT} — mount ./bridge into the dashboard container"
        )
    client().images.build(path=str(context), tag=BRIDGE_IMAGE, rm=True)


def used_novnc_ports() -> set[int]:
    ports = set()
    for c in client().containers.list(all=True):
        for _, bindings in (c.attrs.get("HostConfig", {}).get("PortBindings") or {}).items():
            for b in bindings or []:
                try:
                    ports.add(int(b.get("HostPort")))
                except (TypeError, ValueError):
                    pass
    return ports


def next_novnc_port(reserved: set[int]) -> int:
    taken = used_novnc_ports() | set(reserved)
    port = NOVNC_PORT_BASE
    while port in taken:
        port += 1
    return port


def novnc_url(port: int) -> str:
    return f"http://{PUBLIC_HOST}:{port}/vnc.html"


def create_computer(slug: str, novnc_port: int, vnc_password: str,
                    image: str | None = None) -> None:
    """Start the desktop + bridge container pair for one computer.

    `image` overrides the stock desktop image, which is how a machine gets
    created from a snapshot of an already-provisioned one.
    """
    ensure_bridge_image()
    network = detect_network()
    extra = {}
    if DISABLE_APPARMOR:
        extra["security_opt"] = ["apparmor:unconfined"]

    client().containers.run(
        image or DESKTOP_IMAGE,
        name=desktop_container_name(slug),
        detach=True,
        environment={"VNC_PW": vnc_password},
        ports={"6901/tcp": novnc_port},
        network=network,
        restart_policy={"Name": "unless-stopped"},
        labels={"deskswarm.role": "desktop", "deskswarm.slug": slug},
        **extra,
    )
    client().containers.run(
        BRIDGE_IMAGE,
        name=bridge_container_name(slug),
        detach=True,
        environment={
            "VNC_HOST": desktop_container_name(slug),
            "VNC_PORT": "5901",
            "VNC_PASSWORD": vnc_password,
            "BRIDGE_PORT": "8000",
        },
        network=network,
        restart_policy={"Name": "unless-stopped"},
        labels={"deskswarm.role": "bridge", "deskswarm.slug": slug},
        **extra,
    )


def snapshot_computer(slug: str, tag: str) -> str:
    """Commit a running desktop container to an image so new machines can be
    created pre-loaded with whatever was installed on it."""
    container = client().containers.get(desktop_container_name(slug))
    repo = f"{CONTAINER_PREFIX}-snapshot"
    container.commit(repository=repo, tag=tag)
    return f"{repo}:{tag}"


def remove_image(image: str) -> None:
    try:
        client().images.remove(image, force=True)
    except docker.errors.ImageNotFound:
        pass


def destroy_computer(slug: str) -> None:
    for name in (bridge_container_name(slug), desktop_container_name(slug)):
        try:
            c = client().containers.get(name)
            c.remove(force=True)
        except docker.errors.NotFound:
            pass


def container_state(slug: str) -> dict:
    out = {"desktop_state": "missing", "bridge_state": "missing"}
    for key, name in (
        ("desktop_state", desktop_container_name(slug)),
        ("bridge_state", bridge_container_name(slug)),
    ):
        try:
            out[key] = client().containers.get(name).status
        except docker.errors.NotFound:
            pass
    return out


def exec_in_desktop(slug: str, command: str, timeout_note: str = "") -> dict:
    """Run a shell command inside the desktop container (management shell)."""
    try:
        c = client().containers.get(desktop_container_name(slug))
    except docker.errors.NotFound:
        return {"ok": False, "exit_code": None, "output": "desktop container not found"}

    result = c.exec_run(
        ["bash", "-lc", command],
        demux=False,
        workdir="/home/cua",
        environment={"HOME": "/home/cua", "DISPLAY": ":1"},
    )
    output = result.output.decode("utf-8", errors="replace") if result.output else ""
    return {"ok": result.exit_code == 0, "exit_code": result.exit_code, "output": output}


INVENTORY_SCRIPT = r"""
echo "##OS##"
. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -a
echo "##KERNEL##"
uname -r
echo "##RUNTIMES##"
for b in python3 node npm pip3 java go rustc php ruby perl git docker; do
  if command -v "$b" >/dev/null 2>&1; then
    v=$("$b" --version 2>&1 | grep -v '^[[:space:]]*$' | head -1)
    echo "$b|$v"
  fi
done
echo "##APPS##"
for b in firefox firefox-esr chromium google-chrome libreoffice thunar xfce4-terminal \
         code gimp vlc curl wget xdotool wmctrl xclip ffmpeg; do
  command -v "$b" >/dev/null 2>&1 && echo "$b"
done
echo "##PKGCOUNT##"
dpkg-query -f '.\n' -W 2>/dev/null | wc -l
echo "##PYPKGS##"
(pip3 list --disable-pip-version-check --format=freeze 2>/dev/null || true) | head -40
echo "##DISK##"
df -h / 2>/dev/null | tail -1
echo "##MEM##"
free -h 2>/dev/null | awk '/^Mem:/{print $2" total, "$3" used, "$7" available"}'
"""


def parse_inventory(raw: str) -> dict:
    sections: dict[str, list[str]] = {}
    current = None
    for line in raw.splitlines():
        m = re.fullmatch(r"##([A-Z]+)##", line.strip())
        if m:
            current = m.group(1)
            sections[current] = []
        elif current:
            if line.strip():
                sections[current].append(line.rstrip())

    def first(key):
        vals = sections.get(key) or []
        return vals[0] if vals else None

    runtimes = []
    for line in sections.get("RUNTIMES", []):
        if "|" in line:
            name, version = line.split("|", 1)
            runtimes.append({"name": name, "version": version.strip()})

    try:
        pkg_count = int((first("PKGCOUNT") or "0").strip())
    except ValueError:
        pkg_count = None

    return {
        "os": first("OS"),
        "kernel": first("KERNEL"),
        "runtimes": runtimes,
        "apps": sections.get("APPS", []),
        "package_count": pkg_count,
        "python_packages": sections.get("PYPKGS", []),
        "disk": first("DISK"),
        "memory": first("MEM"),
    }


def get_inventory(slug: str) -> dict:
    res = exec_in_desktop(slug, INVENTORY_SCRIPT)
    if res["exit_code"] is None:
        return {"error": res["output"]}
    return parse_inventory(res["output"])


def random_vnc_password() -> str:
    return secrets.token_hex(8)
