"""Backing a machine's home up, and putting it back.

Only Docker is stubbed here: the streaming, the gzip and the tar sanitising
all run for real against a stand-in home, so a round trip that says the bytes
came back really means it.
"""

import gzip
import io
import tarfile

import pytest


def add(client, name="m1"):
    return client.post("/api/v1/computers", json={"name": name}).get_json()["data"]["id"]


def test_backup_then_restore_returns_the_same_bytes(client):
    comp_id = add(client)
    client.homes["m1"] = {"Desktop/notes.txt": "مرحبا يا عالم\n".encode("utf-8"),
                          ".config/app.conf": b"key=value"}

    r = client.post(f"/api/v1/computers/{comp_id}/backups")
    assert r.status_code == 201
    name = r.get_json()["data"]["name"]

    client.homes["m1"] = {"Desktop/notes.txt": b"clobbered"}
    r = client.post(f"/api/v1/computers/{comp_id}/restore", json={"backup": name})
    assert r.status_code == 200

    assert client.homes["m1"]["Desktop/notes.txt"].decode() == "مرحبا يا عالم\n"
    assert client.homes["m1"][".config/app.conf"] == b"key=value"


def test_restore_replaces_rather_than_merges(client):
    """Anything not in the backup should not survive it — otherwise 'restore'
    quietly means 'merge' and the machine lands in a state that never was."""
    comp_id = add(client)
    client.homes["m1"] = {"keep.txt": b"a"}
    name = client.post(f"/api/v1/computers/{comp_id}/backups").get_json()["data"]["name"]

    client.homes["m1"]["appeared-later.txt"] = b"b"
    client.post(f"/api/v1/computers/{comp_id}/restore", json={"backup": name})

    assert set(client.homes["m1"]) == {"keep.txt"}


def test_a_sleeping_machine_can_be_backed_up_and_stays_asleep(client):
    comp_id = add(client)
    client.homes["m1"] = {"a.txt": b"x"}
    client.post(f"/api/v1/computers/{comp_id}/sleep")

    assert client.post(f"/api/v1/computers/{comp_id}/backups").status_code == 201
    assert client.states["m1"] == "exited", "backing up should not wake it"


def test_restore_stops_a_running_machine_and_starts_it_again(client):
    comp_id = add(client)
    client.homes["m1"] = {"a.txt": b"x"}
    name = client.post(f"/api/v1/computers/{comp_id}/backups").get_json()["data"]["name"]

    data = client.post(f"/api/v1/computers/{comp_id}/restore",
                       json={"backup": name}).get_json()["data"]
    assert data["restarted"] is True
    assert client.states.get("m1", "running") == "running"


def test_old_backups_are_pruned(client, monkeypatch):
    monkeypatch.setattr(client.backups, "KEEP_PER_MACHINE", 2)
    comp_id = add(client)
    client.homes["m1"] = {"a.txt": b"x"}

    names = []
    for i in range(4):
        # The filename is a UTC second, so distinct backups need distinct
        # stamps — otherwise this test measures the clock, not the pruning.
        monkeypatch.setattr(client.backups, "stamp", lambda i=i: f"2026010{i}T000000Z")
        names.append(client.post(f"/api/v1/computers/{comp_id}/backups")
                     .get_json()["data"]["name"])

    kept = [b["name"] for b in
            client.get(f"/api/v1/computers/{comp_id}/backups").get_json()["data"]]
    assert kept == names[-1:-3:-1], "only the newest two should remain"


def test_download_and_delete(client):
    comp_id = add(client)
    client.homes["m1"] = {"a.txt": b"hello"}
    name = client.post(f"/api/v1/computers/{comp_id}/backups").get_json()["data"]["name"]

    r = client.get(f"/api/v1/computers/{comp_id}/backups/{name}")
    assert r.status_code == 200
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(r.data))) as tar:
        assert "cua/a.txt" in tar.getnames()

    assert client.delete(f"/api/v1/computers/{comp_id}/backups/{name}").status_code == 200
    assert client.get(f"/api/v1/computers/{comp_id}/backups").get_json()["data"] == []


@pytest.mark.parametrize("name", [
    "../../../etc/passwd",
    "..%2f..%2fetc",
    "a/b",
    "",
])
def test_backup_names_cannot_escape_the_backup_directory(client, name):
    comp_id = add(client)
    r = client.get(f"/api/v1/computers/{comp_id}/backups/{name}")
    assert r.status_code in (400, 404), f"{name!r} was not refused"


# ------------------------------------------------------- untrusted archives

def make_upload(members: list[tuple[str, bytes]], links=()) -> bytes:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as tar:
        for path, data in members:
            info = tarfile.TarInfo(path)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        for path, target in links:
            info = tarfile.TarInfo(path)
            info.type = tarfile.SYMTYPE
            info.linkname = target
            tar.addfile(info)
    return gzip.compress(raw.getvalue())


def upload(client, comp_id, blob, filename="backup.tar.gz"):
    return client.post(f"/api/v1/computers/{comp_id}/restore/upload",
                       data={"file": (io.BytesIO(blob), filename)},
                       content_type="multipart/form-data")


def test_uploaded_backup_is_restored(client):
    comp_id = add(client)
    r = upload(client, comp_id, make_upload([("cua/from-elsewhere.txt", b"hi")]))
    assert r.status_code == 200
    assert client.homes["m1"]["from-elsewhere.txt"] == b"hi"


def test_escaping_members_are_dropped_not_written(client):
    """An uploaded tar is entirely untrusted input, and '../../etc/cron.d/x'
    is the oldest trick there is."""
    comp_id = add(client)
    blob = make_upload([
        ("cua/ok.txt", b"fine"),
        ("../../../etc/cron.d/pwn", b"* * * * * root sh -c evil"),
        ("/etc/shadow", b"root::"),
        ("cua/../../root/.ssh/authorized_keys", b"ssh-rsa AAAA"),
    ])
    r = upload(client, comp_id, blob)
    assert r.status_code == 200
    assert set(client.homes["m1"]) == {"ok.txt"}


def test_symlinks_pointing_outside_are_dropped(client):
    """A symlink to /etc that a later member writes through escapes just as
    effectively as a '..' path."""
    comp_id = add(client)
    blob = make_upload([("cua/ok.txt", b"fine")],
                       links=[("cua/escape", "/etc"),
                              ("cua/escape2", "../../../root")])
    r = upload(client, comp_id, blob)
    assert r.status_code == 200
    assert set(client.homes["m1"]) == {"ok.txt"}


def test_a_symlink_staying_inside_the_home_is_kept(client):
    """The check is about where the link points, not that it is a link —
    otherwise a restore would quietly drop half of a real home directory."""
    comp_id = add(client)
    blob = make_upload([("cua/real.txt", b"fine")],
                       links=[("cua/shortcut", "real.txt"),
                              ("cua/Desktop/up", "../real.txt")])
    assert upload(client, comp_id, blob).status_code == 200
    assert client.homes["m1"]["shortcut"] == b"->real.txt"
    assert client.homes["m1"]["Desktop/up"] == b"->../real.txt"


def test_a_file_that_is_not_an_archive_is_refused(client):
    comp_id = add(client)
    r = upload(client, comp_id, b"this is not a tarball at all")
    assert r.status_code >= 400
    assert "m1" not in client.homes or client.homes["m1"] == {}


def test_restored_files_belong_to_the_desktop_user(client, monkeypatch):
    """Root-owned files under /home/cua are the exact fault that broke
    LibreOffice for the desktop session once already."""
    comp_id = add(client)
    seen = []
    real = client.backups.sanitise

    def spy(source, dest):
        kept = real(source, dest)
        with tarfile.open(dest) as tar:
            seen.extend((m.uid, m.gid, m.uname) for m in tar.getmembers())
        return kept

    monkeypatch.setattr(client.backups, "sanitise", spy)
    upload(client, comp_id, make_upload([("cua/a.txt", b"x")]))
    assert seen and all(u == (1000, 1000, "cua") for u in seen)
