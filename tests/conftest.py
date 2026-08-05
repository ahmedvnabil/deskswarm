import io
import os
import sys
import tarfile
import tempfile
from pathlib import Path

import pytest

DASHBOARD = Path(__file__).resolve().parents[1] / "dashboard"
sys.path.insert(0, str(DASHBOARD))


@pytest.fixture()
def client(monkeypatch):
    """A dashboard app backed by a throwaway database and a stubbed Docker.

    fleet.py is the only module that touches Docker; stubbing it keeps the
    tests runnable anywhere (CI included) without a daemon or a real desktop.
    """
    tmp = tempfile.TemporaryDirectory()
    os.environ["DESKSWARM_DB_PATH"] = str(Path(tmp.name) / "test.db")
    os.environ["DESKSWARM_BACKUP_DIR"] = str(Path(tmp.name) / "backups")
    os.environ.pop("DASHBOARD_TOKEN", None)
    os.environ["DESKSWARM_DISABLE_SCHEDULER"] = "1"

    for mod in ("app", "audit", "backups", "db", "fleet", "shares"):
        sys.modules.pop(mod, None)

    import fleet

    created: dict[str, dict] = {}

    monkeypatch.setattr(fleet, "ensure_bridge_image", lambda: None)
    monkeypatch.setattr(fleet, "detect_network", lambda: "test-net")
    monkeypatch.setattr(fleet, "used_novnc_ports", lambda: set())
    monkeypatch.setattr(
        fleet, "create_computer",
        lambda slug, port, password, image=None: created.__setitem__(
            slug, {"port": port, "image": image}))
    monkeypatch.setattr(fleet, "destroy_computer",
                        lambda slug, keep_home=False: created.pop(slug, None))

    # Container state is what the app reads to decide "is this machine
    # asleep", so tests drive it through this dict rather than Docker.
    states: dict[str, str] = {}
    monkeypatch.setattr(
        fleet, "container_state",
        lambda slug: {"desktop_state": states.get(slug, "running"),
                      "bridge_state": states.get(slug, "running")})
    monkeypatch.setattr(fleet, "suspend_computer",
                        lambda slug: states.__setitem__(slug, "exited"))
    monkeypatch.setattr(fleet, "resume_computer",
                        lambda slug: states.__setitem__(slug, "running"))
    monkeypatch.setattr(fleet, "vnc_watchers", lambda slug: 0)
    monkeypatch.setattr(
        fleet, "awake_machine_count",
        lambda: sum(1 for s in created if states.get(s, "running") == "running"))

    clipboards: dict[str, str] = {}
    pasted: list[tuple[str, str]] = []
    monkeypatch.setattr(fleet, "get_clipboard", lambda slug: clipboards.get(slug, ""))
    monkeypatch.setattr(fleet, "set_clipboard",
                        lambda slug, text: clipboards.__setitem__(slug, text))
    monkeypatch.setattr(fleet, "paste_text",
                        lambda slug, text: (clipboards.__setitem__(slug, text),
                                            pasted.append((slug, text))))

    # A stand-in home directory, kept as {path: bytes}. Backup tars it, restore
    # replaces it — so the streaming, the gzip and the tar sanitising all run
    # for real and only Docker is faked.
    homes: dict[str, dict[str, bytes]] = {}

    def home_archive_stream(slug):
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w") as tar:
            for name, data in homes.get(slug, {}).items():
                info = tarfile.TarInfo(f"cua/{name}")
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        return iter([buf.getvalue()])

    def restore_home(slug, tar_path, wipe=True):
        if wipe:
            homes[slug] = {}
        with tarfile.open(tar_path) as tar:
            for m in tar.getmembers():
                # put_archive unpacks into /home, so members arrive as `cua/x`.
                key = m.name.removeprefix("cua/")
                if m.issym() or m.islnk():
                    # Recorded, not skipped: a symlink that escapes the home
                    # directory is every bit as dangerous as a '..' path, and
                    # dropping it here would make the test that checks for it
                    # pass no matter what the code does.
                    homes.setdefault(slug, {})[key] = f"->{m.linkname}".encode()
                elif m.isfile():
                    fh = tar.extractfile(m)
                    homes.setdefault(slug, {})[key] = fh.read() if fh else b""

    monkeypatch.setattr(fleet, "home_archive_stream", home_archive_stream)
    monkeypatch.setattr(fleet, "restore_home", restore_home)
    monkeypatch.setattr(fleet, "is_running",
                        lambda slug: states.get(slug, "running") == "running")

    import app as app_module

    monkeypatch.setattr(app_module, "check_bridge", lambda view: True)

    # Dispatch normally starts a thread that runs an agent in a subprocess.
    # Left real, those threads outlive the fixture and go looking for a
    # database that has already been deleted. Tests care that dispatch was
    # *decided*, not that an agent ran; test_reserved.py reads the rows back.
    dispatched: list[int] = []
    monkeypatch.setattr(app_module, "run_task_worker",
                        lambda tid, host, port, desc: dispatched.append(tid))
    app_module.app.config.update(TESTING=True)

    c = app_module.app.test_client()
    c.created = created
    c.module = app_module
    c.dispatched = dispatched
    c.states = states
    c.clipboards = clipboards
    c.pasted = pasted
    c.homes = homes
    yield c
    tmp.cleanup()
