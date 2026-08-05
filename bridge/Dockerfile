FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11-xserver-utils \
    curl \
    build-essential \
    linux-libc-dev \
    && rm -rf /var/lib/apt/lists/*

# twisted + vncdotool are required by cua-computer-server's VNC backend at
# runtime but are NOT declared as install dependencies upstream (as of
# cua-computer-server 0.3.42). See docs/UPSTREAM_CUA_BUG.md.
RUN pip install --no-cache-dir \
    'cua-computer-server==0.3.*' \
    'twisted==26.*' \
    'vncdotool==1.3.*'

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
    CMD curl -fsS "http://127.0.0.1:${BRIDGE_PORT:-8000}/status" || exit 1

ENTRYPOINT ["/entrypoint.sh"]
