/**
 * The entry point: build the app, make sure someone can sign in, start the
 * housekeeping loop, listen.
 *
 * Interrupted managed runs retain ownership for explicit human takeover;
 * they are never replayed automatically.
 */

import { recoverInterrupted } from "./agents/store";
import { app } from "./app";
import { ensureAdmin } from "./auth";
import { startHousekeeping } from "./housekeeping";
import { DISABLE_HOUSEKEEPING, PORT } from "./settings";

recoverInterrupted();
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
