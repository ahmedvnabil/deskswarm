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
    monkeypatch.setattr(fleet, "destroy_computer", lambda slug: created.pop(slug, None))
    monkeypatch.setattr(
        fleet, "container_state",
        lambda slug: {"desktop_state": "running", "bridge_state": "running"})

    import app as app_module

    monkeypatch.setattr(app_module, "check_bridge", lambda view: True)
    app_module.app.config.update(TESTING=True)

    c = app_module.app.test_client()
    c.created = created
    c.module = app_module
    yield c
    tmp.cleanup()
