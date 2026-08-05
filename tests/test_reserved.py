"""A reserved machine is one you are driving by hand. The point of the flag is
that a fleet-wide dispatch must not grab its keyboard out from under you."""

import pytest


@pytest.fixture()
def fleet(client):
    for n in ("w1", "w2", "mine"):
        client.post("/api/v1/computers", json={"name": n})
    ids = {c["name"]: c["id"] for c in client.get("/api/v1/computers").get_json()["data"]}
    client.patch(f"/api/v1/computers/{ids['mine']}", json={"reserved": "1"})
    return ids


def targets_of(client, **body):
    r = client.post("/api/v1/tasks", json={"description": "x", **body})
    assert r.status_code == 201, r.get_json()
    ids = r.get_json()["data"]["task_ids"]
    rows = {t["id"]: t["desktop"] for t in client.get("/api/v1/tasks").get_json()["data"]}
    return sorted(rows[i] for i in ids)


def test_fleet_wide_dispatch_skips_a_reserved_machine(client, fleet):
    assert targets_of(client, desktop="all") == ["w1", "w2"]


def test_naming_a_reserved_machine_still_works(client, fleet):
    """Explicitly targeting it is a deliberate choice, not an accident."""
    assert targets_of(client, desktop="mine") == ["mine"]


def test_unreserving_puts_it_back_in_the_fleet(client, fleet):
    client.patch(f"/api/v1/computers/{fleet['mine']}", json={"reserved": "0"})
    assert targets_of(client, desktop="all") == ["mine", "w1", "w2"]


def test_all_reserved_is_an_error_not_a_silent_no_op(client, fleet):
    for name in ("w1", "w2"):
        client.patch(f"/api/v1/computers/{fleet[name]}", json={"reserved": "1"})
    r = client.post("/api/v1/tasks", json={"desktop": "all", "description": "x"})
    assert r.status_code == 400
    assert "every machine is reserved" in r.get_json()["error"]


def test_flag_is_reported_and_toggles(client, fleet):
    by_name = {c["name"]: c for c in client.get("/api/v1/computers").get_json()["data"]}
    assert by_name["mine"]["reserved"] is True
    assert by_name["w1"]["reserved"] is False


def test_reserving_does_not_touch_the_name(client, fleet):
    client.patch(f"/api/v1/computers/{fleet['mine']}", json={"reserved": "1"})
    names = sorted(c["name"] for c in client.get("/api/v1/computers").get_json()["data"])
    assert names == ["mine", "w1", "w2"]
