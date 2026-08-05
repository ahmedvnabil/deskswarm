# Two stages so the toolchain never ships. cua-computer-server pulls pynput ->
# evdev, which has no wheel and must be compiled; installing build-essential in
# the runtime image left ~680 MB of apt packages behind — LLVM, gcc, g++, mesa
# — for a container whose whole job is translating REST calls into VNC events.
FROM python:3.12-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    linux-libc-dev \
    && rm -rf /var/lib/apt/lists/*

# twisted + vncdotool are required by cua-computer-server's VNC backend at
# runtime but are NOT declared as install dependencies upstream (as of
# cua-computer-server 0.3.42). See docs/UPSTREAM_CUA_BUG.md.
RUN pip install --no-cache-dir --prefix=/install \
    'cua-computer-server==0.3.*' \
    'twisted==26.*' \
    'vncdotool==1.3.*'

# playwright ships ~137 MB of driver payload for browser automation the VNC
# backend never calls. The package has to stay importable, so drop the payload
# rather than the module.
RUN rm -rf /install/lib/python3.12/site-packages/playwright/driver \
           /install/lib/python3.12/site-packages/pip \
           /install/lib/python3.12/site-packages/setuptools \
    && find /install -name '__pycache__' -type d -prune -exec rm -rf {} + \
    && find /install -name '*.pyc' -delete


FROM python:3.12-slim

# Xvfb is not used for anything: importing computer_server pulls in the native
# handler, which imports pynput, which refuses to load without an X display —
# even when the VNC backend is the one actually serving. See
# docs/UPSTREAM_CUA_BUG.md.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11-xserver-utils \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /install /usr/local

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
    CMD curl -fsS "http://127.0.0.1:${BRIDGE_PORT:-8000}/status" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
