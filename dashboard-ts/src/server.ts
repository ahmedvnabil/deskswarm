/**
 * The entry point: build the app, make sure someone can sign in, start the
 * housekeeping loop, listen.
 *
 * There is no longer a reclaim step. When the dashboard drove agent sessions
 * itself, a restart left half-finished tasks behind that had to be failed on
 * the way up; now that machines are driven from outside over MCP, a restart
 * interrupts nothing it owns — the worst it costs a connected client is one
 * failed call.
 */

import { app } from "./app";
import { ensureAdmin } from "./auth";
import { startHousekeeping } from "./housekeeping";
import { DISABLE_HOUSEKEEPING, PORT } from "./settings";

await ensureAdmin();

if (!DISABLE_HOUSEKEEPING) startHousekeeping();

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  // Backups and home downloads are large and slow; the default 10s would cut
  // them off mid-stream.
  idleTimeout: 255,
  fetch: (req, srv) => app.fetch(req, { server: srv }),
});

console.log(`deskswarm dashboard on http://0.0.0.0:${server.port}`);
