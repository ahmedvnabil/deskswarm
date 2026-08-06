/**
 * Preloaded before any test module, because several settings are read once at
 * import time and cannot be changed afterwards.
 *
 * Registered in bunfig.toml as `[test] preload`.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "deskswarm-test-"));

process.env.DESKSWARM_TEST_ROOT = root;
process.env.DESKSWARM_DB_PATH = join(root, "test.db");
process.env.DESKSWARM_BACKUP_DIR = join(root, "backups");
process.env.DESKSWARM_DISABLE_SCHEDULER = "1";
process.env.DESKSWARM_DISABLE_WORKERS = "1";
// Set, not unset: the token path is one of the two ways in and has to be
// covered. Session-authenticated requests pass requireToken on the strength of
// their session, so this does not change what the other tests exercise.
process.env.DASHBOARD_TOKEN = "test-api-token-9f2c";
