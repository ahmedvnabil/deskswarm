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
delete process.env.DASHBOARD_TOKEN;
