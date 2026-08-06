# Bun runs the dashboard; Python is here for one file.
#
# run_task.py drives a cua agent session, and the cua agent loop has no
# published TypeScript equivalent — @trycua/computer covers the computer
# interface but not the loop. Shelling out to the Python worker is a smaller
# and better-understood surface than reimplementing it, and it was already a
# separate process per task.
#
# Three stages so the runtime carries neither toolchain: pip, python3-venv and
# bun's download cache together were about 200 MB of an image that never uses
# them again. Every stage shares one base, which is what makes the venv
# copyable — it is built against the same interpreter it will run against.

ARG BUN=oven/bun:1.3-slim


# ---------------------------------------------------------------- agent ----
FROM ${BUN} AS agent

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# The cua SDKs move fast and a breaking change here silently stops every task,
# so pin the minor and bump deliberately — the same pins the Flask image used.
RUN python3 -m venv /opt/agent \
    && /opt/agent/bin/pip install --no-cache-dir \
         'cua-agent==0.8.*' 'cua-computer==0.5.*'

# pip and wheel exist to install things; nothing installs anything after this.
# setuptools stays — enough libraries still import pkg_resources at runtime
# that dropping it trades 30 MB for a class of import error that only shows up
# when a task runs.
RUN rm -rf /opt/agent/lib/python3*/site-packages/pip \
           /opt/agent/lib/python3*/site-packages/wheel \
           /opt/agent/bin/pip* \
    && find /opt/agent -name '__pycache__' -type d -prune -exec rm -rf {} + \
    && find /opt/agent -name '*.pyc' -delete


# ----------------------------------------------------------------- deps ----
FROM ${BUN} AS deps

WORKDIR /app
COPY package.json bun.lock* ./
# The cache is 60 MB and is only useful to a later install; dropping it in the
# same layer is the only way it does not ship.
RUN bun install --frozen-lockfile --production \
    && rm -rf /root/.bun/install/cache ~/.bun/install/cache


# -------------------------------------------------------------- runtime ----
FROM ${BUN}

WORKDIR /app

# python3 for the agent worker, curl for the healthcheck. No pip, no venv
# module, no build tooling.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=agent /opt/agent /opt/agent
COPY --from=deps /app/node_modules /app/node_modules
COPY . .

ENV DESKSWARM_PYTHON=/opt/agent/bin/python

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-7000}/health" || exit 1

CMD ["bun", "run", "src/server.ts"]
