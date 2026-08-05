#!/bin/bash
set -e

# A stopped container keeps its filesystem, and Xvfb leaves a lock file behind
# when it is killed rather than shut down. On the next start it refuses with
# "Server is already active for display 99", the server dies importing pynput,
# and the container crash-loops for ever. Every machine that sleeps and wakes
# hits this, so clear the remains of the previous run first.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

Xvfb :99 -screen 0 1024x768x24 >/tmp/xvfb.log 2>&1 &

# Wait for the socket instead of guessing. The old fixed `sleep 1` was a race
# the server lost whenever the host was busy — and losing it looks like the
# bug above, which sent us chasing the wrong thing.
for _ in $(seq 1 50); do
  [ -e /tmp/.X11-unix/X99 ] && break
  sleep 0.2
done

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
