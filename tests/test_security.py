"""The dashboard can run shell commands as root inside a machine, so a
cross-site request reaching a mutating endpoint is remote code execution.
These tests pin that door shut."""


def test_cross_site_form_post_is_rejected(client):
    """A plain HTML form post is a CORS "simple request" — no preflight stops
    it — so the Origin check is the only thing between a malicious page and
    /exec. This is the exact request that was exploitable before the fix."""
    r = client.post(
        "/api/v1/computers/1/exec",
        data={"command": "id"},
        content_type="application/x-www-form-urlencoded",
        headers={"Origin": "https://evil.example.com"},
    )
    assert r.status_code == 403
    assert "cross-site" in r.get_json()["error"]


def test_cross_site_json_post_is_rejected(client):
    r = client.post("/api/v1/tasks", json={"description": "x"},
                    headers={"Origin": "https://evil.example.com"})
    assert r.status_code == 403


def test_cross_site_delete_is_rejected(client):
    r = client.delete("/api/v1/computers/1",
                      headers={"Origin": "https://evil.example.com"})
    assert r.status_code == 403


def test_same_origin_request_is_allowed(client):
    r = client.post("/api/v1/computers", json={"name": "same-origin"},
                    headers={"Origin": "http://localhost"})
    assert r.status_code == 201


def test_client_without_origin_still_works(client):
    """curl / n8n / cron send no Origin and are not a CSRF vector."""
    r = client.post("/api/v1/computers", json={"name": "scripted"})
    assert r.status_code == 201


def test_reads_are_never_blocked(client):
    assert client.get("/api/v1/computers",
                      headers={"Origin": "https://evil.example.com"}).status_code == 200


def test_form_encoded_body_cannot_supply_parameters(client):
    """Defence in depth: even same-origin, a form body is ignored, so a simple
    request can never carry a command."""
    client.post("/api/v1/computers", json={"name": "box"})
    r = client.post("/api/v1/computers/1/exec",
                    data={"command": "id"},
                    content_type="application/x-www-form-urlencoded")
    assert r.status_code == 400
    assert "command is required" in r.get_json()["error"]
