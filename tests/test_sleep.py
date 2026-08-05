"""Sleeping frees a machine's memory; waking brings it back.

The rules that matter here are the ones that protect work in progress: a
machine running a task must not be suspended, and a machine someone is
watching must not be either.
"""

from datetime import datetime, timedelta, timezone


def add(client, name="m1"):
    r = client.post("/api/v1/computers", json={"name": name})
    assert r.status_code == 201
    return r.get_json()["data"]["id"]


def view(client, comp_id):
    for c in client.get("/api/v1/computers").get_json()["data"]:
        if c["id"] == comp_id:
            return c
    raise AssertionError("machine vanished")


def test_sleep_then_wake_round_trip(client):
    comp_id = add(client)
    assert view(client, comp_id)["sleeping"] is False

    assert client.post(f"/api/v1/computers/{comp_id}/sleep").status_code == 200
    assert view(client, comp_id)["sleeping"] is True

    assert client.post(f"/api/v1/computers/{comp_id}/wake").status_code == 200
    assert view(client, comp_id)["sleeping"] is False


def test_sleeping_machine_reports_no_screen(client):
    """The wall must not spend a bridge timeout per tile on stopped machines."""
    comp_id = add(client)
    client.post(f"/api/v1/computers/{comp_id}/sleep")
    r = client.get(f"/api/v1/computers/{comp_id}/screenshot")
    assert r.status_code == 503
    assert r.get_json()["error"] == "sleeping"


def test_sleep_refused_while_a_task_is_running(client):
    comp_id = add(client)
    client.post("/api/v1/tasks", json={"desktop": "m1", "description": "work"})
    r = client.post(f"/api/v1/computers/{comp_id}/sleep")
    assert r.status_code == 409
    assert "running" in r.get_json()["error"]
    assert view(client, comp_id)["sleeping"] is False


def test_idle_sweep_is_off_by_default(client):
    """Suspending costs someone their open windows, so it has to be opted in."""
    app = client.module
    assert app.IDLE_SUSPEND_MINUTES == 0
    comp_id = add(client)
    app.idle_tick()
    assert view(client, comp_id)["sleeping"] is False


def stale(client, comp_id, minutes):
    conn = client.module.connect()
    when = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    conn.execute("UPDATE computers SET last_active_at = ? WHERE id = ?",
                 (when.isoformat(timespec="seconds"), comp_id))
    conn.commit()
    conn.close()


def test_idle_sweep_suspends_only_after_the_timeout(client, monkeypatch):
    app = client.module
    monkeypatch.setattr(app, "IDLE_SUSPEND_MINUTES", 30)
    comp_id = add(client)

    stale(client, comp_id, 5)
    app.idle_tick()
    assert view(client, comp_id)["sleeping"] is False, "5 minutes idle is not idle"

    stale(client, comp_id, 45)
    app.idle_tick()
    assert view(client, comp_id)["sleeping"] is True


def test_idle_sweep_spares_a_watched_machine(client, monkeypatch):
    """Someone with the screen open is using it, however long since a task."""
    app = client.module
    monkeypatch.setattr(app, "IDLE_SUSPEND_MINUTES", 30)
    monkeypatch.setattr(app.fleet, "vnc_watchers", lambda slug: 1)
    comp_id = add(client)
    stale(client, comp_id, 120)

    app.idle_tick()
    assert view(client, comp_id)["sleeping"] is False


def test_idle_sweep_spares_a_busy_machine(client, monkeypatch):
    app = client.module
    monkeypatch.setattr(app, "IDLE_SUSPEND_MINUTES", 30)
    comp_id = add(client)
    stale(client, comp_id, 120)
    client.post("/api/v1/tasks", json={"desktop": "m1", "description": "long job"})

    app.idle_tick()
    assert view(client, comp_id)["sleeping"] is False


def test_no_suspend_flag_is_honoured(client, monkeypatch):
    app = client.module
    monkeypatch.setattr(app, "IDLE_SUSPEND_MINUTES", 30)
    comp_id = add(client)
    assert client.patch(f"/api/v1/computers/{comp_id}",
                        json={"no_suspend": "1"}).status_code == 200
    stale(client, comp_id, 999)

    app.idle_tick()
    assert view(client, comp_id)["sleeping"] is False
    assert view(client, comp_id)["no_suspend"] is True


def test_first_sweep_starts_the_clock_instead_of_suspending(client, monkeypatch):
    """Turning the feature on must not stop every machine at the next tick."""
    app = client.module
    monkeypatch.setattr(app, "IDLE_SUSPEND_MINUTES", 30)
    comp_id = add(client)
    conn = app.connect()
    conn.execute("UPDATE computers SET last_active_at = NULL WHERE id = ?", (comp_id,))
    conn.commit()
    conn.close()

    app.idle_tick()
    assert view(client, comp_id)["sleeping"] is False
    assert view(client, comp_id)["last_active_at"] is not None


def test_sleeping_machines_do_not_spend_the_memory_budget(client):
    """A sleeping machine costs nothing, so charging the budget for it would
    refuse new machines while the RAM it supposedly holds sits free."""
    app = client.module
    for n in ("m1", "m2", "m3"):
        add(client, n)
    assert app.budgeted_machine_count() == 3

    client.post(f"/api/v1/computers/{add(client, 'm4')}/sleep")
    assert app.budgeted_machine_count() == 3, "the sleeper should not be counted"


def test_budget_falls_back_to_the_whole_fleet_if_docker_is_silent(client, monkeypatch):
    """Over-counting is the safe direction for an admission check."""
    app = client.module
    add(client, "m1")
    add(client, "m2")
    monkeypatch.setattr(app.fleet, "awake_machine_count", lambda: None)
    assert app.budgeted_machine_count() == 2


def test_wake_recreates_a_bridge_that_will_not_come_back(client, monkeypatch):
    """A started container keeps its old filesystem, and things that refuse to
    start twice live there — stale X locks, sockets, pid files. Recreating
    clears them; the home volume is untouched either way."""
    app = client.module
    comp_id = add(client)
    client.post(f"/api/v1/computers/{comp_id}/sleep")

    monkeypatch.setattr(app, "check_bridge", lambda view: False)
    monkeypatch.setattr(app, "WAKE_TIMEOUT_SECONDS", 0.01)
    client.created.clear()

    r = client.post(f"/api/v1/computers/{comp_id}/wake")
    assert r.get_json()["data"]["recreated"] is True
    assert "m1" in client.created, "the pair should have been rebuilt"


def test_a_healthy_wake_does_not_recreate(client):
    comp_id = add(client)
    client.post(f"/api/v1/computers/{comp_id}/sleep")
    data = client.post(f"/api/v1/computers/{comp_id}/wake").get_json()["data"]
    assert data == {"id": comp_id, "sleeping": False, "ready": True, "recreated": False}


def test_a_task_wakes_a_sleeping_target(client):
    """A schedule naming a sleeping machine should work, not fail."""
    comp_id = add(client)
    client.post(f"/api/v1/computers/{comp_id}/sleep")
    assert view(client, comp_id)["sleeping"] is True

    r = client.post("/api/v1/tasks", json={"desktop": "m1", "description": "after hours"})
    assert r.status_code == 201
    # start_task_thread wakes before handing off to the runner.
    for _ in range(50):
        if not view(client, comp_id)["sleeping"]:
            break
        import time
        time.sleep(0.05)
    assert view(client, comp_id)["sleeping"] is False
