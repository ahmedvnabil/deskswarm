/**
 * The entry point: reclaim orphaned tasks, build the app, start the loop,
 * listen.
 *
 * The Python version had to do the reclaim in a separate process before
 * gunicorn forked, or every worker would have run it and a worker respawning
 * later would have failed tasks its sibling was still running. One process
 * makes that a plain function call.
 */

import { app } from "./app";
import { ensureAdmin } from "./auth";
import { reclaim } from "./reclaim";
import { startScheduler } from "./scheduler";
import { DISABLE_SCHEDULER, PORT } from "./settings";

reclaim();
await ensureAdmin();

if (!DISABLE_SCHEDULER) startScheduler();

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  // Backups and home downloads are large and slow; the default 10s would cut
  // them off mid-stream.
  idleTimeout: 255,
  fetch: (req, srv) => app.fetch(req, { server: srv }),
});

console.log(`deskswarm dashboard on http://0.0.0.0:${server.port}`);
