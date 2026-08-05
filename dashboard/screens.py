"""Stills of the machines' screens, cached.

The wall shows every machine at once. Opening a live VNC stream per tile would
mean N simultaneous connections, so tiles poll a cached still and only the tile
you click gets a real interactive session.
"""

import base64
import json
import time

import requests

from settings import SHOT_TTL


_SHOT_CACHE: dict[str, tuple[float, bytes]] = {}


def bridge_screenshot(view: dict) -> bytes | None:
    """Grab a PNG of one machine's screen through its bridge."""
    slug = view["slug"]
    now = time.time()
    hit = _SHOT_CACHE.get(slug)
    if hit and now - hit[0] < SHOT_TTL:
        return hit[1]

    url = f"http://{view['bridge_host']}:{view['bridge_port']}/cmd"
    try:
        r = requests.post(url, json={"command": "screenshot", "params": {}}, timeout=12)
    except Exception:  # noqa: BLE001
        return None
    if r.status_code != 200:
        return None

    # The bridge answers as an SSE-ish stream: `data: {json}`.
    payload = None
    for line in r.text.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            line = line[5:].strip()
        if line.startswith("{"):
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
    if not payload or not payload.get("success") or not payload.get("image_data"):
        return None

    try:
        png = base64.b64decode(payload["image_data"])
    except Exception:  # noqa: BLE001
        return None
    _SHOT_CACHE[slug] = (now, png)
    return png
