# Bun runs the dashboard. Nothing else is in here.
#
# This used to carry a Python venv with the cua agent SDK, because the
# dashboard drove agent sessions itself and shelled out to run_task.py for
# each one. Machines are now driven from outside over MCP, so the loop, the
# worker and the interpreter under them are all gone — along with about
# 300 MB of image.
#
# Two stages so the runtime carries no toolchain: bun's download cache alone
# was 60 MB of an image that never installs anything again.

ARG BUN=oven/bun:1.3-slim


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

# curl for the healthcheck. Nothing else.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules /app/node_modules
COPY . .

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-7000}/health" || exit 1

CMD ["bun", "run", "src/server.ts"]
