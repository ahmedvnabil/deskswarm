# Bun runs the dashboard; Python is here for one file.
#
# run_task.py drives a cua agent session, and the cua agent loop has no
# published TypeScript equivalent — @trycua/computer covers the computer
# interface but not the loop. Shelling out to the Python worker is a smaller
# and better-understood surface than reimplementing it, and it was already a
# separate process per task.
FROM oven/bun:1.3-debian

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# The cua SDKs move fast and a breaking change here silently stops every task,
# so pin the minor and bump deliberately — same pins the Flask image used.
RUN python3 -m venv /opt/agent \
    && /opt/agent/bin/pip install --no-cache-dir 'cua-agent==0.8.*' 'cua-computer==0.5.*'
ENV DESKSWARM_PYTHON=/opt/agent/bin/python

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

COPY . .

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-7000}/health" || exit 1

CMD ["bun", "run", "src/server.ts"]
