

def add(client, name, **kw):
    return client.post("/api/v1/computers", json={"name": name, **kw})


def test_create_rename_delete(client):
    r = add(client, "alpha")
    assert r.status_code == 201
    cid = r.get_json()["data"]["id"]

    assert client.patch(f"/api/v1/computers/{cid}",
                        json={"name": "alpha-renamed"}).status_code == 200
    names = [c["name"] for c in client.get("/api/v1/computers").get_json()["data"]]
    assert names == ["alpha-renamed"]

    assert client.delete(f"/api/v1/computers/{cid}").status_code == 200
    assert client.get("/api/v1/computers").get_json()["data"] == []


def test_duplicate_name_is_rejected(client):
    add(client, "dup")
    assert add(client, "dup").status_code == 409


def test_delete_survives_missing_containers(client):
    """A machine whose containers were removed outside the dashboard must
    still be removable instead of erroring."""
    cid = add(client, "ghost").get_json()["data"]["id"]
    client.created.clear()
    assert client.delete(f"/api/v1/computers/{cid}").status_code == 200


def test_ports_do_not_collide(client):
    for n in ("a", "b", "c"):
        add(client, n)
    ports = [c["novnc_port"] for c in client.get("/api/v1/computers").get_json()["data"]]
    assert len(set(ports)) == len(ports)


class TestBatchNames:
    def test_range_expands(self, client):
        data = add(client, "agent-{1..3}").get_json()["data"]
        assert [c["name"] for c in data["created"]] == ["agent-1", "agent-2", "agent-3"]
        assert data["errors"] == []

    def test_zero_padding_is_preserved(self, client):
        data = add(client, "node-{01..03}").get_json()["data"]
        assert [c["name"] for c in data["created"]] == ["node-01", "node-02", "node-03"]

    def test_clashes_do_not_block_the_rest(self, client):
        add(client, "x-2")
        data = add(client, "x-{1..3}").get_json()["data"]
        assert [c["name"] for c in data["created"]] == ["x-1", "x-3"]
        assert [e["name"] for e in data["errors"]] == ["x-2"]

    def test_oversized_range_is_refused(self, client):
        r = add(client, "big-{1..999}")
        assert r.status_code == 400
        assert "more than" in r.get_json()["error"]

    def test_single_name_returns_the_object_not_a_batch(self, client):
        data = add(client, "solo").get_json()["data"]
        assert data["name"] == "solo"


def test_task_needs_a_fleet(client):
    r = client.post("/api/v1/tasks", json={"description": "do a thing"})
    assert r.status_code == 400
    assert "no computers" in r.get_json()["error"]


def test_task_rejects_unknown_machine(client):
    add(client, "real")
    r = client.post("/api/v1/tasks",
                    json={"desktop": "imaginary", "description": "x"})
    assert r.status_code == 400


def test_snapshot_name_must_be_free(client, monkeypatch):
    import fleet
    monkeypatch.setattr(fleet, "snapshot_computer", lambda slug, tag: f"img:{tag}")
    cid = add(client, "src").get_json()["data"]["id"]
    assert client.post(f"/api/v1/computers/{cid}/snapshot",
                       json={"name": "snap"}).status_code == 201
    assert client.post(f"/api/v1/computers/{cid}/snapshot",
                       json={"name": "snap"}).status_code == 409


def test_creating_from_unknown_snapshot_fails(client):
    r = add(client, "box", snapshot="nope")
    assert r.status_code == 400
    assert "unknown snapshot" in r.get_json()["error"]
