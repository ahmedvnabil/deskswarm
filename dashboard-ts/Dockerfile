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

ARG BUN=oven/bun:1.4.4-slim


# ----------------------------------------------------------------- deps ----
FROM ${BUN} AS deps

WORKDIR /app
COPY package.json bun.lock* ./
# The cache is 60 MB and is only useful to a later install; dropping it in the
# same layer is the only way it does not ship.
# Docker uses the local Unix socket. Skip optional ssh2 native-addon builds
# (its JavaScript fallback remains available) in this toolchain-free image.
RUN bun install --frozen-lockfile --production --ignore-scripts \
    && rm -rf /root/.bun/install/cache ~/.bun/install/cache


# -------------------------------------------------------------- runtime ----
FROM ${BUN}

WORKDIR /app

COPY --from=deps /app/node_modules /app/node_modules
COPY . .

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
    CMD bun -e 'fetch(`http://127.0.0.1:${process.env.PORT || 7000}/health`).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'

CMD ["bun", "run", "src/server.ts"]
