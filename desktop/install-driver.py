"""Install the pinned native binary, verifying GitHub's published asset digest."""
import hashlib
import io
import platform
import tarfile
import urllib.request
from pathlib import Path

ARTIFACTS = {
    "aarch64": ("arm64", "80c9ae66bc7322052dd426c6133c96086b33894bf06c972bca8215384400b33d"),
    "x86_64": ("x86_64", "31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd"),
}
arch, digest = ARTIFACTS[platform.machine()]
url = f"https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.38.0/cua-driver-rs-0.38.0-linux-{arch}-binary.tar.gz"
data = urllib.request.urlopen(url, timeout=120).read()
if hashlib.sha256(data).hexdigest() != digest:
    raise RuntimeError("Cua Driver archive checksum mismatch")
with tarfile.open(fileobj=io.BytesIO(data)) as archive:
    binary = archive.extractfile("cua-driver").read()
path = Path("/usr/local/bin/cua-driver")
path.write_bytes(binary)
path.chmod(0o755)
