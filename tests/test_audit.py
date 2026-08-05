"""The audit log.

Coverage is the point. Because it is written by one `after_request` hook
rather than by calls inside handlers, the test that matters most is the one
that sweeps every mutating endpoint and insists each left a line — a log with
holes is worse than no log, because it reads as complete.
"""

def add(client, name="m1"):
    return client.post("/api/v1/computers", json={"name": name}).get_json()["data"]["id"]


def entries(client, **params):
    q = "&".join(f"{k}={v}" for k, v in params.items())
    return client.get("/api/v1/audit" + ("?" + q if q else "")).get_json()["data"]


def test_a_mutation_is_recorded_with_who_what_and_where(client):
    add(client, "recorded")
    row = entries(client)[0]
    assert row["action"] == "POST /api/v1/computers"
    assert row["actor"] == "dashboard"
    assert row["target"] == "recorded"
    assert row["status"] == 201
    assert row["ok"] == 1


def test_reads_are_not_recorded(client):
    add(client)
    before = len(entries(client))
    for _ in range(5):
        client.get("/api/v1/computers")
        client.get("/partials/fleet")
    assert len(entries(client)) == before


def test_failures_are_recorded_too(client):
    """A rejected attempt is exactly what you want to find later."""
    client.post("/api/v1/computers", json={})       # no name -> 400
    row = entries(client)[0]
    assert row["status"] == 400
    assert row["ok"] == 0


def test_every_mutating_endpoint_leaves_a_line(client):
    comp_id = add(client)
    calls = [
        ("post", f"/api/v1/computers/{comp_id}/exec", {"json": {"command": "id"}}),
        ("post", f"/api/v1/computers/{comp_id}/clipboard", {"json": {"text": "x"}}),
        ("patch", f"/api/v1/computers/{comp_id}", {"json": {"reserved": "1"}}),
        ("post", f"/api/v1/computers/{comp_id}/sleep", {}),
        ("post", f"/api/v1/computers/{comp_id}/wake", {}),
        ("post", f"/api/v1/computers/{comp_id}/restart", {}),
        ("post", f"/api/v1/computers/{comp_id}/backups", {}),
        ("post", f"/api/v1/computers/{comp_id}/shares", {"json": {"label": "x"}}),
        ("post", f"/api/v1/computers/{comp_id}/rotate-password", {}),
        ("post", "/api/v1/tasks", {"json": {"desktop": "m1", "description": "d"}}),
        ("delete", f"/api/v1/computers/{comp_id}", {}),
    ]
    for method, path, kwargs in calls:
        getattr(client, method)(path, **kwargs)

    logged = {e["action"] for e in entries(client, page=1)}
    missing = [f"{m.upper()} {p}" for m, p, _ in calls
               if f"{m.upper()} {p}" not in logged]
    assert not missing, f"unlogged mutations: {missing}"


def test_the_shell_command_is_kept_because_that_is_the_point(client):
    comp_id = add(client)
    client.post(f"/api/v1/computers/{comp_id}/exec",
                json={"command": "rm -rf /var/tmp/something"})
    row = [e for e in entries(client) if e["action"].endswith("/exec")][0]
    assert row["detail"] == "rm -rf /var/tmp/something"


def test_clipboard_contents_are_counted_never_stored(client):
    """An audit trail that quietly archives everything anyone pasted is its
    own kind of problem."""
    comp_id = add(client)
    secret = "correct horse battery staple"
    client.post(f"/api/v1/computers/{comp_id}/clipboard", json={"text": secret})
    row = [e for e in entries(client) if e["action"].endswith("/clipboard")][0]
    assert secret not in (row["detail"] or "")
    assert "bytes" in row["detail"]


def test_filtering_by_machine(client):
    a = add(client, "alpha")
    add(client, "beta")
    client.post(f"/api/v1/computers/{a}/sleep")
    rows = entries(client, target="alpha")
    assert rows and all(r["target"] == "alpha" for r in rows)


def test_export_is_csv(client):
    add(client)
    r = client.get("/api/v1/audit/export.csv")
    assert r.status_code == 200
    assert r.mimetype == "text/csv"
    assert b"POST /api/v1/computers" in r.data


def test_retention_drops_old_entries_only(client, monkeypatch):
    add(client)
    conn = client.module.connect()
    conn.execute("UPDATE audit SET at = '2020-01-01T00:00:00+00:00'")
    conn.commit()
    client.audit.record("recent thing")
    dropped = client.audit.prune(conn)
    conn.close()

    assert dropped >= 1
    remaining = [e["action"] for e in entries(client)]
    assert "recent thing" in remaining
    assert "POST /api/v1/computers" not in remaining


def test_a_broken_audit_never_breaks_the_request(client, monkeypatch):
    monkeypatch.setattr(client.audit, "record",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("disk full")))
    assert client.post("/api/v1/computers", json={"name": "still-works"}).status_code == 201
