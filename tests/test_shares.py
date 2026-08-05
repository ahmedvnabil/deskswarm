"""Sharing one machine without sharing the fleet.

The interesting cases are the negative ones: a share must reach exactly one
machine, stop working the moment it is revoked or expires, and never become a
way into the dashboard.
"""

from datetime import datetime, timedelta, timezone


def add(client, name="m1"):
    return client.post("/api/v1/computers", json={"name": name}).get_json()["data"]["id"]


def make_share(client, comp_id, **kw):
    body = {"label": "sara", "mode": "watch", "hours": 24, **kw}
    r = client.post(f"/api/v1/computers/{comp_id}/shares", json=body)
    assert r.status_code == 201, r.get_json()
    return r.get_json()["data"]


def test_a_share_opens_its_machine_and_says_which(client):
    comp_id = add(client, "reception")
    share = make_share(client, comp_id)
    r = client.get(f"/s/{share['token']}")
    assert r.status_code == 200
    assert b"reception" in r.data


def test_a_watch_share_never_exposes_the_screen_password(client):
    """That is the whole difference between watch and control."""
    comp_id = add(client)
    share = make_share(client, comp_id, mode="watch")
    password = client.get("/api/v1/computers").get_json()["data"][0]["vnc_password"]

    page = client.get(f"/s/{share['token']}").data
    assert password.encode() not in page
    assert b"/vnc.html" not in page


def test_a_control_share_does_embed_the_session(client):
    comp_id = add(client)
    share = make_share(client, comp_id, mode="control")
    page = client.get(f"/s/{share['token']}").data
    assert b"/vnc.html" in page


def test_revoking_kills_the_link_immediately(client):
    comp_id = add(client)
    share = make_share(client, comp_id)
    assert client.get(f"/s/{share['token']}").status_code == 200

    assert client.delete(f"/api/v1/shares/{share['id']}").status_code == 200
    assert client.get(f"/s/{share['token']}").status_code == 404
    assert client.get(f"/s/{share['token']}/screen.png").status_code == 404


def test_revoking_a_control_share_admits_what_it_cannot_do(client):
    comp_id = add(client)
    share = make_share(client, comp_id, mode="control")
    note = client.delete(f"/api/v1/shares/{share['id']}").get_json()["data"]["note"]
    assert note and "rotate" in note


def test_an_expired_share_stops_working(client):
    comp_id = add(client)
    share = make_share(client, comp_id)
    conn = client.module.connect()
    past = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat(timespec="seconds")
    conn.execute("UPDATE shares SET expires_at = ? WHERE id = ?", (past, share["id"]))
    conn.commit()
    conn.close()

    assert client.get(f"/s/{share['token']}").status_code == 404


def test_a_wrong_token_looks_exactly_like_a_revoked_one(client):
    """Telling a stranger which it is tells them whether to keep guessing."""
    comp_id = add(client)
    share = make_share(client, comp_id)
    client.delete(f"/api/v1/shares/{share['id']}")

    revoked = client.get(f"/s/{share['token']}")
    never = client.get("/s/" + "z" * 43)
    assert revoked.status_code == never.status_code == 404
    assert revoked.data == never.data


def test_rotating_the_password_revokes_control_shares_and_changes_the_password(client):
    comp_id = add(client)
    before = client.get("/api/v1/computers").get_json()["data"][0]["vnc_password"]
    watch = make_share(client, comp_id, mode="watch", label="watcher")
    control = make_share(client, comp_id, mode="control", label="driver")

    assert client.post(f"/api/v1/computers/{comp_id}/rotate-password").status_code == 200
    after = client.get("/api/v1/computers").get_json()["data"][0]["vnc_password"]
    assert after != before

    states = {s["id"]: s["status"] for s in client.get("/api/v1/shares").get_json()["data"]}
    assert states[control["id"]] == "revoked"
    assert states[watch["id"]] == "live", "a watch share was never at risk"


def test_a_share_cannot_reach_another_machine_or_the_fleet(client):
    add(client, "m1")
    other = add(client, "m2")
    share = make_share(client, other)
    token = share["token"]

    # The share namespace is exactly two routes; nothing else answers under it.
    assert client.get(f"/s/{token}/../api/v1/computers").status_code in (301, 308, 404)
    assert client.post(f"/s/{token}/screen.png").status_code == 405


def test_share_use_is_counted_and_attributed(client):
    comp_id = add(client, "shared-box")
    share = make_share(client, comp_id, label="sara")
    client.get(f"/s/{share['token']}")
    client.get(f"/s/{share['token']}")

    row = [s for s in client.get("/api/v1/shares").get_json()["data"]
           if s["id"] == share["id"]][0]
    assert row["uses"] == 2
    assert row["last_used_at"]

    entries = client.get("/api/v1/audit").get_json()["data"]
    guest = [e for e in entries if e["actor"] == "share:sara"]
    assert guest, "opening a share should be recorded"
    assert guest[0]["target"] == "shared-box"


def test_bad_mode_and_silly_expiry_are_refused(client):
    comp_id = add(client)
    assert client.post(f"/api/v1/computers/{comp_id}/shares",
                       json={"mode": "root"}).status_code == 400
    assert client.post(f"/api/v1/computers/{comp_id}/shares",
                       json={"hours": 0}).status_code == 400
    assert client.post(f"/api/v1/computers/{comp_id}/shares",
                       json={"hours": 99999}).status_code == 400


def test_tokens_are_not_guessable(client):
    comp_id = add(client)
    tokens = {make_share(client, comp_id)["token"] for _ in range(5)}
    assert len(tokens) == 5
    assert all(len(t) >= 32 for t in tokens)
