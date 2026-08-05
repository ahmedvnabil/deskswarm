"""Per-machine resource caps, and what happens when the host refuses them.

Nested Docker — a Proxmox LXC, an unprivileged runner — may not have the
cgroup controllers delegated. Refusing to start the machine there would be a
worse outcome than running it uncapped, so the fallback is the interesting
half of this.
"""

import sys
from pathlib import Path

import docker
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dashboard"))
import fleet  # noqa: E402


class FakeContainers:
    def __init__(self, refuse_on=None):
        self.refuse_on = refuse_on or ()
        self.calls = []

    def run(self, image, **kwargs):
        self.calls.append(kwargs)
        for key in self.refuse_on:
            if key in kwargs:
                raise docker.errors.APIError(
                    "OCI runtime create failed: cgroup memory limit not supported")
        return "container"


@pytest.fixture(autouse=True)
def reset_probe():
    fleet._limits_supported = None
    yield
    fleet._limits_supported = None


@pytest.fixture()
def fake(monkeypatch):
    holder = {}

    def install(refuse_on=None):
        containers = FakeContainers(refuse_on)
        monkeypatch.setattr(fleet, "client",
                            lambda: type("C", (), {"containers": containers})())
        holder["c"] = containers
        return containers

    holder["install"] = install
    return holder


def test_limits_are_applied(fake):
    c = fake["install"]()
    fleet.run_container("img", name="x", limits=fleet.resource_limits("2g"))
    assert c.calls[0]["mem_limit"] == "2g"
    assert c.calls[0]["nano_cpus"] == int(fleet.MACHINE_CPUS * 1e9)
    assert c.calls[0]["pids_limit"] == fleet.MACHINE_PIDS
    assert fleet.limits_supported() is True


def test_zeroed_settings_drop_out(monkeypatch):
    monkeypatch.setattr(fleet, "MACHINE_CPUS", 0.0)
    monkeypatch.setattr(fleet, "MACHINE_PIDS", 0)
    assert fleet.resource_limits("") == {}
    assert fleet.resource_limits("1g") == {"mem_limit": "1g"}


def test_unsupported_host_falls_back_to_no_limits(fake):
    c = fake["install"](refuse_on=("mem_limit",))
    assert fleet.run_container("img", name="x",
                               limits=fleet.resource_limits("2g")) == "container"
    assert len(c.calls) == 2, "should retry once, uncapped"
    assert "mem_limit" not in c.calls[1]
    assert fleet.limits_supported() is False


def test_the_host_is_only_asked_once(fake):
    c = fake["install"](refuse_on=("mem_limit",))
    for _ in range(3):
        fleet.run_container("img", name="x", limits=fleet.resource_limits("2g"))
    # First call probes and retries (2); the rest skip straight to uncapped.
    assert len(c.calls) == 4


def test_unrelated_docker_errors_still_raise(fake):
    class Angry(FakeContainers):
        def run(self, image, **kwargs):
            raise docker.errors.APIError("Conflict: name already in use")

    containers = Angry()
    fake["install"]()
    fleet.client = lambda: type("C", (), {"containers": containers})()
    with pytest.raises(docker.errors.APIError, match="already in use"):
        fleet.run_container("img", name="x", limits=fleet.resource_limits("2g"))


def test_watchers_script_ignores_the_bridges_own_connection(fake):
    """5901 is held open by the bridge forever; counting it would make every
    machine look permanently in use and defeat the idle sweep."""
    assert "1AF5" in fleet.VNC_WATCHERS_SCRIPT      # 6901, the browser
    assert "170D" not in fleet.VNC_WATCHERS_SCRIPT  # 5901, the bridge
