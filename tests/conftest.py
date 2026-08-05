import os
import sys
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
    os.environ.pop("DASHBOARD_TOKEN", None)

    for mod in ("app", "fleet"):
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
    yield c
    tmp.cleanup()
