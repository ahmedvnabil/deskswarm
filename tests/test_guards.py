"""deskswarm already survives process failures. These guard the quiet ones —
a schedule burning money, memory running out a machine at a time, a disk
filling with snapshots, or every task failing because the provider is down."""

from datetime import datetime, timedelta, timezone

import pytest


def add(client, name="m1"):
    return client.post("/api/v1/computers", json={"name": name})


def seed_task(app, desktop, status, cost=None, when=None):
    ts = (when or datetime.now(timezone.utc)).isoformat(timespec="seconds")
    conn = app.connect()
    conn.execute(
        "INSERT INTO tasks (desktop, description, status, cost_usd, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?)", (desktop, "x", status, cost, ts, ts))
    conn.commit()
    conn.close()


class TestCostCap:
    def test_off_by_default(self, client, monkeypatch):
        import guards
        monkeypatch.setattr(guards, "DAILY_COST_LIMIT", 0)
        add(client)
        seed_task(client.module, "m1", "COMPLETED", cost=999)
        assert client.post("/api/v1/tasks", json={"description": "x"}).status_code == 201

    def test_dispatch_is_refused_once_the_day_is_spent(self, client, monkeypatch):
        import guards
        monkeypatch.setattr(guards, "DAILY_COST_LIMIT", 1.0)
        add(client)
        seed_task(client.module, "m1", "COMPLETED", cost=1.5)
        r = client.post("/api/v1/tasks", json={"description": "x"})
        assert r.status_code == 400
        assert "daily cost limit" in r.get_json()["error"]

    def test_spending_under_the_cap_is_fine(self, client, monkeypatch):
        import guards
        monkeypatch.setattr(guards, "DAILY_COST_LIMIT", 10.0)
        add(client)
        seed_task(client.module, "m1", "COMPLETED", cost=0.5)
        assert client.post("/api/v1/tasks", json={"description": "x"}).status_code == 201

    def test_yesterdays_spend_does_not_count(self, client, monkeypatch):
        import guards
        monkeypatch.setattr(guards, "DAILY_COST_LIMIT", 1.0)
        add(client)
        seed_task(client.module, "m1", "COMPLETED", cost=99,
                  when=datetime.now(timezone.utc) - timedelta(days=2))
        assert client.post("/api/v1/tasks", json={"description": "x"}).status_code == 201


class TestMemoryAdmission:
    @staticmethod
    def _budget(monkeypatch, mb):
        import guards
        monkeypatch.setattr(guards, "MEMORY_BUDGET_MB", mb)
        monkeypatch.setattr(guards, "MACHINE_MB", 300)
        monkeypatch.setattr(guards, "MIN_FREE_MB", 512)

    def test_creation_is_refused_when_memory_is_short(self, client, monkeypatch):
        self._budget(monkeypatch, 600)
        r = add(client, "too-many")
        assert r.status_code == 507
        assert "not enough memory" in r.get_json()["error"]

    def test_a_batch_is_sized_as_a_whole(self, client, monkeypatch):
        """Room for one machine is not room for ten."""
        self._budget(monkeypatch, 1200)
        assert add(client, "solo").status_code == 201
        assert client.post("/api/v1/computers",
                           json={"name": "many-{1..10}"}).status_code == 507

    def test_the_budget_is_spent_by_existing_machines(self, client, monkeypatch):
        """Each machine already running eats into what is left, so a fleet
        fills up rather than accepting new machines for ever."""
        # budget 1500, 300 per machine, 512 must stay free -> a new machine
        # needs 812 MB of headroom.
        self._budget(monkeypatch, 1500)
        assert add(client, "one").status_code == 201     # 1500 free, needs 812
        assert add(client, "two").status_code == 201     # 1200 free
        assert add(client, "three").status_code == 201   #  900 free
        assert add(client, "four").status_code == 507    #  600 free -> refused

    def test_meminfo_is_used_when_no_budget_is_set(self, client, monkeypatch):
        import guards
        monkeypatch.setattr(guards, "MEMORY_BUDGET_MB", 0)
        monkeypatch.setattr(guards, "cgroup_limit_mb", lambda: None)
        monkeypatch.setattr(guards, "meminfo_available_mb", lambda: 400)
        monkeypatch.setattr(guards, "MACHINE_MB", 300)
        monkeypatch.setattr(guards, "MIN_FREE_MB", 512)
        r = add(client, "tight")
        assert r.status_code == 507
        # and it says why the number may be wrong under a nested cap
        assert "DESKSWARM_MEMORY_BUDGET_MB" in r.get_json()["error"]

    def test_a_nested_cap_is_not_silently_trusted(self, client, monkeypatch):
        """Docker inside an LXC reads the *host's* /proc/meminfo — 63 GB on a
        CT capped at 8 GB — so that reading must be marked untrusted."""
        import guards
        monkeypatch.setattr(guards, "MEMORY_BUDGET_MB", 0)
        monkeypatch.setattr(guards, "cgroup_limit_mb", lambda: None)
        monkeypatch.setattr(guards, "meminfo_available_mb", lambda: 63000)
        assert guards.memory_report()["trusted"] is False
        assert guards.memory_report()["source"] == "meminfo"

    def test_an_explicit_budget_is_trusted(self, client, monkeypatch):
        import guards
        monkeypatch.setattr(guards, "MEMORY_BUDGET_MB", 8192)
        rep = guards.memory_report()
        assert rep["trusted"] is True and rep["source"] == "budget"

    def test_unknown_memory_does_not_block(self, client, monkeypatch):
        import guards
        monkeypatch.setattr(guards, "MEMORY_BUDGET_MB", 0)
        monkeypatch.setattr(guards, "cgroup_limit_mb", lambda: None)
        monkeypatch.setattr(guards, "meminfo_available_mb", lambda: None)
        assert add(client, "unknowable").status_code == 201


class TestDisk:
    def test_creation_is_refused_when_the_disk_is_nearly_full(self, client, monkeypatch):
        import guards
        monkeypatch.setattr(guards, "disk_free_gb", lambda: 1.0)
        monkeypatch.setattr(guards, "MIN_FREE_DISK_GB", 5.0)
        r = add(client, "nospace")
        assert r.status_code == 507
        assert "disk left" in r.get_json()["error"]

    def test_snapshots_are_refused_too(self, client, monkeypatch):
        """Snapshots are 2-6 GB each and are what actually fills the disk."""
        import fleet, guards
        monkeypatch.setattr(fleet, "snapshot_computer", lambda slug, tag: "img")
        cid = add(client, "src").get_json()["data"]["id"]
        monkeypatch.setattr(guards, "disk_free_gb", lambda: 1.0)
        monkeypatch.setattr(guards, "MIN_FREE_DISK_GB", 5.0)
        assert client.post(f"/api/v1/computers/{cid}/snapshot",
                           json={"name": "s"}).status_code == 507

    def test_low_disk_warns_before_it_blocks(self, client, monkeypatch):
        import guards
        monkeypatch.setattr(guards, "disk_free_gb", lambda: 9.0)
        monkeypatch.setattr(guards, "MIN_FREE_DISK_GB", 5.0)
        monkeypatch.setattr(guards, "LOW_DISK_WARN_GB", 15.0)
        assert add(client, "ok-for-now").status_code == 201
        assert any("disk left" in w for w in
                   client.get("/api/v1/guards").get_json()["data"]["warnings"])


class TestFailureBreaker:
    def test_dispatch_pauses_after_a_run_of_failures(self, client, monkeypatch):
        import guards
        monkeypatch.setattr(guards, "FAILURE_BREAKER", 3)
        add(client)
        for _ in range(3):
            seed_task(client.module, "m1", "FAILED")
        r = client.post("/api/v1/tasks", json={"description": "x"})
        assert r.status_code == 400
        assert "all failed" in r.get_json()["error"]

    def test_a_success_in_the_run_clears_it(self, client, monkeypatch):
        import guards
        monkeypatch.setattr(guards, "FAILURE_BREAKER", 3)
        add(client)
        seed_task(client.module, "m1", "FAILED")
        seed_task(client.module, "m1", "FAILED")
        seed_task(client.module, "m1", "COMPLETED")
        assert client.post("/api/v1/tasks", json={"description": "x"}).status_code == 201

    def test_it_reopens_after_the_cooldown(self, client, monkeypatch):
        """A breaker that never retries is just an outage of its own."""
        import guards
        monkeypatch.setattr(guards, "FAILURE_BREAKER", 3)
        monkeypatch.setattr(guards, "BREAKER_COOLDOWN_MIN", 10)
        add(client)
        old = datetime.now(timezone.utc) - timedelta(minutes=30)
        for _ in range(3):
            seed_task(client.module, "m1", "FAILED", when=old)
        assert client.post("/api/v1/tasks", json={"description": "x"}).status_code == 201


def test_status_endpoint_reports_everything(client):
    d = client.get("/api/v1/guards").get_json()["data"]
    for key in ("spend_today_usd", "memory_available_mb", "disk_free_gb",
                "consecutive_failures", "blocking", "warnings", "ok"):
        assert key in d
