"""File transfer takes paths straight from the browser, so the confinement to
/home/cua is the whole security story here."""

import io
import pytest


def test_paths_stay_inside_home():
    import fleet
    assert fleet.safe_home_path("") == "/home/cua"
    assert fleet.safe_home_path("Desktop") == "/home/cua/Desktop"
    assert fleet.safe_home_path("a/b/c.txt") == "/home/cua/a/b/c.txt"
    # A leading slash is read as home-relative rather than as the real root,
    # so an absolute-looking path lands harmlessly inside home.
    assert fleet.safe_home_path("/Desktop") == "/home/cua/Desktop"
    assert fleet.safe_home_path("/etc/passwd") == "/home/cua/etc/passwd"


@pytest.mark.parametrize("evil", [
    "../../etc/shadow",
    "..",
    "Desktop/../../../root/.ssh/id_rsa",
    "a/../../..",
    "/../etc/passwd",
])
def test_traversal_is_refused(evil):
    import fleet
    with pytest.raises(fleet.PathOutsideHome):
        fleet.safe_home_path(evil)


@pytest.mark.parametrize("bad", ["../x", "a/b", "", ".", ".."])
def test_upload_filenames_cannot_carry_a_path(bad):
    import fleet
    with pytest.raises(fleet.PathOutsideHome):
        fleet.upload_to_home("slug", "Desktop", bad, b"x")


def test_traversal_is_refused_over_http(client):
    client.post("/api/v1/computers", json={"name": "m1"})
    r = client.get("/api/v1/computers/1/files?path=../../etc")
    assert r.status_code == 400
    assert "outside" in r.get_json()["error"]

    r = client.get("/api/v1/computers/1/files/download?path=../../etc/passwd")
    assert r.status_code == 400


def test_upload_rejects_an_oversized_file(client, monkeypatch):
    import app as app_module
    monkeypatch.setattr(app_module, "MAX_UPLOAD_MB", 1)
    client.post("/api/v1/computers", json={"name": "m1"})
    big = io.BytesIO(b"x" * (2 * 1024 * 1024))
    r = client.post("/api/v1/computers/1/files",
                    data={"file": (big, "big.bin")},
                    content_type="multipart/form-data")
    assert r.status_code == 413


def test_upload_needs_a_file(client):
    client.post("/api/v1/computers", json={"name": "m1"})
    r = client.post("/api/v1/computers/1/files", data={},
                    content_type="multipart/form-data")
    assert r.status_code == 400


def test_a_cross_site_upload_is_blocked(client):
    """Multipart POST is a CORS simple request, so the Origin check is what
    stops a page dropping a file onto someone's machine."""
    client.post("/api/v1/computers", json={"name": "m1"})
    r = client.post("/api/v1/computers/1/files",
                    data={"file": (io.BytesIO(b"x"), "x.txt")},
                    content_type="multipart/form-data",
                    headers={"Origin": "https://evil.example.com"})
    assert r.status_code == 403


def test_uploaded_files_are_owned_by_the_desktop_user(monkeypatch):
    """Written as root they would land on the desktop unopenable."""
    import fleet, tarfile, io as _io
    captured = {}

    class FakeContainer:
        def put_archive(self, path, data):
            captured["path"] = path
            captured["tar"] = data
            return True

    monkeypatch.setattr(fleet, "client", lambda: type(
        "C", (), {"containers": type("X", (), {"get": staticmethod(lambda n: FakeContainer())})()})())
    fleet.upload_to_home("slug", "Desktop", "note.txt", b"hello")

    assert captured["path"] == "/home/cua/Desktop"
    with tarfile.open(fileobj=_io.BytesIO(captured["tar"])) as tar:
        m = tar.getmember("note.txt")
        assert (m.uid, m.gid) == (1000, 1000)
        assert (m.uname, m.gname) == ("cua", "cua")
