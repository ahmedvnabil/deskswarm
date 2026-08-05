from datetime import datetime, timedelta, timezone


def test_interval_schedule_round_trip(client):
    client.post("/api/v1/computers", json={"name": "m1"})
    r = client.post("/api/v1/schedules", json={
        "desktop": "m1", "description": "ping", "kind": "interval", "every_minutes": 15})
    assert r.status_code == 201
    row = r.get_json()["data"]
    assert row["every_minutes"] == 15 and row["enabled"] == 1

    sid = row["id"]
    assert client.patch(f"/api/v1/schedules/{sid}", json={"enabled": "0"}).status_code == 200
    assert client.get("/api/v1/schedules").get_json()["data"][0]["enabled"] == 0
    assert client.delete(f"/api/v1/schedules/{sid}").status_code == 200
    assert client.get("/api/v1/schedules").get_json()["data"] == []


def test_bad_time_is_rejected(client):
    r = client.post("/api/v1/schedules", json={
        "desktop": "all", "description": "x", "kind": "daily", "at_time": "25:99"})
    assert r.status_code == 400


def test_daily_next_run_is_in_the_future(client):
    r = client.post("/api/v1/schedules", json={
        "desktop": "all", "description": "x", "kind": "daily", "at_time": "00:01"})
    nxt = datetime.fromisoformat(r.get_json()["data"]["next_run_at"])
    assert nxt > datetime.now(timezone.utc)


def test_a_due_schedule_fires_once_even_with_racing_workers(client, monkeypatch):
    """The scheduler runs in every gunicorn worker. Claiming is a conditional
    UPDATE on next_run_at, so only one tick may dispatch a given schedule."""
    fired = []
    monkeypatch.setattr(client.scheduler, "dispatch_task", lambda d, desc: fired.append((d, desc)))

    client.post("/api/v1/computers", json={"name": "m1"})
    client.post("/api/v1/schedules", json={
        "desktop": "m1", "description": "repeat me", "kind": "interval", "every_minutes": 1})

    # make it due
    conn = client.module.connect()
    conn.execute("UPDATE schedules SET next_run_at = ?",
                 ((datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat(timespec="seconds"),))
    conn.commit()
    conn.close()

    client.scheduler.scheduler_tick()
    client.scheduler.scheduler_tick()   # a second worker arriving right behind the first

    assert fired == [("m1", "repeat me")]
    assert client.get("/api/v1/schedules").get_json()["data"][0]["run_count"] == 1
