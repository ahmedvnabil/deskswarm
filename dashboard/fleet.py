"""
Dynamic fleet management: create, destroy, inspect and shell into desktops.

A "computer" is a pair of containers on the same Docker network:
  <prefix>-desktop-<slug>  — trycua/xfce-cua, a real XFCE session over VNC
  <prefix>-bridge-<slug>   — cua-computer-server in VNC-backend mode

Both are created at runtime through the Docker API (the dashboard mounts
/var/run/docker.sock), so the fleet is not fixed by docker-compose.yml —
users add and remove machines from the UI.
"""

import io
import os
import re
import secrets
import tarfile
import time
from urllib.parse import quote
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

# Give every machine a named volume for its home directory. Without one a
# restart — or a rebuild onto a newer image — silently throws away whatever
# was on the desktop, which makes a machine something you look at rather than
# something you work in.
PERSIST_HOME = os.environ.get("DESKSWARM_PERSIST_HOME", "1").lower() in ("1", "true", "yes")
HOME_PATH = "/home/cua"

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


def home_volume_name(slug: str) -> str:
    return f"{CONTAINER_PREFIX}-home-{slug}"


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


def novnc_url(port: int, password: str | None = None) -> str:
    """Link to a machine's screen.

    Each machine gets its own random VNC password, so a bare /vnc.html link
    would just prompt for a secret the user has no way to know. Passing it as
    autoconnect params makes "screen" work in one click. The password is only
    as protected as the dashboard itself, which already mounts docker.sock.
    """
    base = f"http://{PUBLIC_HOST}:{port}/vnc.html"
    if password:
        return f"{base}?autoconnect=true&resize=scale&password={quote(password)}"
    return base


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

    # Only the desktop gets the home volume; the bridge has no business
    # holding a reference to the user's files.
    desktop_extra = dict(extra)
    if PERSIST_HOME:
        # Docker seeds a fresh named volume from the image's own /home/cua, so
        # a new machine still gets its skeleton — Desktop, dotfiles, correct
        # ownership — and only keeps it from then on.
        desktop_extra["volumes"] = {home_volume_name(slug): {"bind": HOME_PATH, "mode": "rw"}}

    client().containers.run(
        image or DESKTOP_IMAGE,
        name=desktop_container_name(slug),
        detach=True,
        environment={"VNC_PW": vnc_password},
        ports={"6901/tcp": novnc_port},
        network=network,
        restart_policy={"Name": "unless-stopped"},
        labels={"deskswarm.role": "desktop", "deskswarm.slug": slug},
        **desktop_extra,
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


def destroy_computer(slug: str, keep_home: bool = False) -> None:
    """Remove a machine. `keep_home` spares the home volume, which is what a
    restart needs — the containers go, the work stays."""
    for name in (bridge_container_name(slug), desktop_container_name(slug)):
        try:
            client().containers.get(name).remove(force=True)
        except docker.errors.NotFound:
            pass
    if keep_home or not PERSIST_HOME:
        return
    try:
        client().volumes.get(home_volume_name(slug)).remove(force=True)
    except docker.errors.NotFound:
        pass


def home_size_mb(slug: str) -> float | None:
    """How much the machine's home volume holds, so the UI can say."""
    if not PERSIST_HOME:
        return None
    try:
        info = client().df()
    except Exception:  # noqa: BLE001
        return None
    want = home_volume_name(slug)
    for v in info.get("Volumes") or []:
        if v.get("Name") == want:
            size = (v.get("UsageData") or {}).get("Size", -1)
            return round(size / 1e6, 1) if size and size >= 0 else None
    return None


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


# ------------------------------------------------------------------ files

class PathOutsideHome(ValueError):
    """Refuse to read or write outside the machine's home directory."""


def safe_home_path(rel: str = "") -> str:
    """Resolve a user-supplied path inside /home/cua, or refuse.

    Paths arrive from the browser, so '../../etc/shadow' has to bounce here
    rather than at the Docker API, which would happily serve it.
    """
    target = os.path.normpath(os.path.join(HOME_PATH, (rel or "").lstrip("/")))
    if target != HOME_PATH and not target.startswith(HOME_PATH + "/"):
        raise PathOutsideHome(f"'{rel}' is outside {HOME_PATH}")
    return target


LIST_SCRIPT = r"""
cd "$1" 2>/dev/null || { echo "__MISSING__"; exit 0; }
for f in .* *; do
  [ "$f" = "." ] && continue
  [ "$f" = ".." ] && continue
  [ -e "$f" ] || continue
  if [ -d "$f" ]; then t=dir; sz=0; else t=file; sz=$(stat -c %s "$f" 2>/dev/null || echo 0); fi
  printf '%s|%s|%s
' "$t" "$sz" "$f"
done
"""


def list_home(slug: str, rel: str = "") -> list[dict]:
    target = safe_home_path(rel)
    c = client().containers.get(desktop_container_name(slug))
    res = c.exec_run(["bash", "-c", LIST_SCRIPT, "--", target], demux=False)
    out = (res.output or b"").decode("utf-8", errors="replace")
    if "__MISSING__" in out:
        raise FileNotFoundError(rel or HOME_PATH)
    entries = []
    for line in out.splitlines():
        parts = line.split("|", 2)
        if len(parts) != 3:
            continue
        kind, size, name = parts
        entries.append({"name": name, "type": kind, "size": int(size or 0)})
    entries.sort(key=lambda e: (e["type"] != "dir", e["name"].lower()))
    return entries


def upload_to_home(slug: str, rel_dir: str, filename: str, data: bytes) -> str:
    """Drop one file into the machine's home. Owned by `cua`, or the desktop
    session could not open what you just handed it."""
    if "/" in filename or filename in ("", ".", ".."):
        raise PathOutsideHome(f"bad filename '{filename}'")
    target_dir = safe_home_path(rel_dir)

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        info = tarfile.TarInfo(name=filename)
        info.size = len(data)
        info.mtime = int(time.time())
        info.mode = 0o644
        info.uid = info.gid = 1000          # the desktop runs as cua (1000)
        info.uname = info.gname = "cua"
        tar.addfile(info, io.BytesIO(data))
    buf.seek(0)

    c = client().containers.get(desktop_container_name(slug))
    if not c.put_archive(target_dir, buf.getvalue()):
        raise RuntimeError("docker refused the upload")
    return os.path.join(target_dir, filename)


def download_from_home(slug: str, rel: str) -> tuple[bytes, str, bool]:
    """Return (bytes, download name, is_tar). Directories come back as a tar,
    single files as themselves."""
    target = safe_home_path(rel)
    c = client().containers.get(desktop_container_name(slug))
    stream, stat = c.get_archive(target)
    raw = b"".join(stream)

    with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
        members = [m for m in tar.getmembers() if m.isfile()]
        base = os.path.basename(target) or "home"
        # A single file is what people expect back as a file, not a tarball.
        if len(members) == 1 and members[0].name == base:
            fh = tar.extractfile(members[0])
            return (fh.read() if fh else b""), base, False
    return raw, f"{base}.tar", True
