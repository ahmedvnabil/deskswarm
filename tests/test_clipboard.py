"""Copy/paste across the VNC boundary.

The encoding cases are the point: the clipboard is where non-Latin text and
shell metacharacters go to break, and both travel base64-encoded precisely so
they don't.
"""

import pytest

ARABIC = "مرحبا يا عالم"


def add(client, name="m1"):
    return client.post("/api/v1/computers", json={"name": name}).get_json()["data"]["id"]


def test_set_then_get_round_trip(client):
    comp_id = add(client)
    r = client.post(f"/api/v1/computers/{comp_id}/clipboard", json={"text": "hello"})
    assert r.status_code == 200
    assert client.get(f"/api/v1/computers/{comp_id}/clipboard").get_json()["data"]["text"] == "hello"


@pytest.mark.parametrize("text", [
    ARABIC,
    "emoji ✅ and — dashes",
    "quotes ' \" and $(echo pwned) `backticks`",
    "line one\nline two\ttabbed",
])
def test_awkward_text_survives_intact(client, text):
    comp_id = add(client)
    client.post(f"/api/v1/computers/{comp_id}/clipboard", json={"text": text})
    got = client.get(f"/api/v1/computers/{comp_id}/clipboard").get_json()["data"]["text"]
    assert got == text


def test_byte_count_is_utf8_not_characters(client):
    """Arabic is two bytes a letter; a character count would under-report it."""
    comp_id = add(client)
    r = client.post(f"/api/v1/computers/{comp_id}/clipboard", json={"text": ARABIC})
    assert r.get_json()["data"]["bytes"] == len(ARABIC.encode("utf-8"))


def test_paste_flag_presses_ctrl_v(client):
    comp_id = add(client)
    r = client.post(f"/api/v1/computers/{comp_id}/clipboard",
                    json={"text": ARABIC, "paste": "1"})
    assert r.get_json()["data"]["pasted"] is True
    assert client.pasted == [("m1", ARABIC)]


def test_without_the_flag_nothing_is_typed(client):
    comp_id = add(client)
    client.post(f"/api/v1/computers/{comp_id}/clipboard", json={"text": "x"})
    assert client.pasted == []


def test_empty_string_is_allowed_but_missing_text_is_not(client):
    comp_id = add(client)
    assert client.post(f"/api/v1/computers/{comp_id}/clipboard",
                       json={"text": ""}).status_code == 200
    r = client.post(f"/api/v1/computers/{comp_id}/clipboard", json={})
    assert r.status_code == 400
    assert "text is required" in r.get_json()["error"]


def test_oversized_clipboard_is_refused(client):
    comp_id = add(client)
    huge = "a" * (client.settings.MAX_CLIPBOARD_KB * 1024 + 1)
    r = client.post(f"/api/v1/computers/{comp_id}/clipboard", json={"text": huge})
    assert r.status_code == 413


def test_unknown_machine_is_404(client):
    assert client.get("/api/v1/computers/999/clipboard").status_code == 404
    assert client.post("/api/v1/computers/999/clipboard",
                       json={"text": "x"}).status_code == 404


def test_cross_site_write_is_blocked(client):
    """Writing the clipboard then pressing Ctrl+V is remote code execution by
    another name — a page on another origin must not reach it."""
    comp_id = add(client)
    r = client.post(f"/api/v1/computers/{comp_id}/clipboard",
                    json={"text": "rm -rf /", "paste": "1"},
                    headers={"Origin": "http://evil.example"})
    assert r.status_code == 403
    assert client.pasted == []
