#!/bin/bash
set -e

Xvfb :99 -screen 0 1024x768x24 >/tmp/xvfb.log 2>&1 &
sleep 1

export DISPLAY=:99
export CUA_BACKEND=vnc
export CUA_VNC_HOST="${VNC_HOST:?VNC_HOST is required}"
export CUA_VNC_PORT="${VNC_PORT:-5901}"
export CUA_VNC_PASSWORD="${VNC_PASSWORD:-}"

exec python3 -m computer_server \
  --host 0.0.0.0 \
  --port "${BRIDGE_PORT:-8000}" \
  --backend vnc \
  --vnc-host "${VNC_HOST}" \
  --vnc-port "${VNC_PORT:-5901}" \
  --vnc-password "${VNC_PASSWORD:-}"
