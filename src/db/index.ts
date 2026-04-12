// Database handle factory for Project Dispatcher.
//
// NOTE ON SPEC DEVIATION: DEVELOPMENT.md MVP-02 originally specified
// "exports a singleton database handle." Implementation chose a
// caller-owned-lifetime factory instead. Rationale:
//   - Tests open isolated `:memory:` handles with no global state leaking
//     between the vitest cases.
//   - Daemon shutdown hooks (SIGTERM → db.close() to flush WAL) are
//     cleaner when the daemon explicitly owns the handle.
//   - Future use cases (e.g. a read-only replica for the inbox query)
//     would have to unwind a singleton assumption.
// The daemon startup (MVP-06) will call openDatabase() exactly once and
// pass the handle around — that's the "single handle in practice"
// equivalent of a singleton without the global state. DEVELOPMENT.md
// has been updated to match. See Code Review #1 decision #5.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Default on-disk database path. Resolved via os.homedir() so it works
 * cross-platform — never hardcode /Users/... or /home/...
 */
/**
 * The canonical .tasks directory. All dispatch data (DB, prompts, logs,
 * artifacts) lives under this path. Derived from os.homedir() so it's
 * cross-platform. If config.discovery.root_path is ever changed, this
 * constant should be updated to match — for V1 it's hardcoded to the
 * default. (Code Review #6 M5 / L5)
 */
export const DEFAULT_TASKS_DIR = join(homedir(), 'Development', '.tasks');
export const DEFAULT_DB_PATH = join(DEFAULT_TASKS_DIR, 'tasks.db');

/**
 * Open a SQLite database and apply the required pragmas.
 *
 * Pragmas:
 * - `journal_mode = WAL` — faster concurrent reads; ignored for `:memory:`
 * - `foreign_keys = ON` — SQLite defaults this OFF, which is the FK-enforcement
 *   equivalent of forgetting a WHERE userId clause. We turn it on AND verify
 *   it actually stuck (coding principle: never trust that a safety pragma
 *   was accepted — verify).
 * - `auto_vacuum = INCREMENTAL` — keeps the file from growing unboundedly
 *   after heavy deletes.
 *
 * No module-level caching on purpose: callers own the lifetime of their
 * handle. The daemon holds one; tests open their own `:memory:` handles.
 */
export function openDatabase(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('auto_vacuum = INCREMENTAL');
  // Allow up to 5 seconds of retry on SQLITE_BUSY when another process
  // (e.g. the MCP server subprocess) holds a write lock. WAL mode makes
  // contention rare, but the busy timeout prevents hard failures when it
  // does happen.
  db.pragma('busy_timeout = 5000');

  const fkEnabled = db.pragma('foreign_keys', { simple: true });
  if (fkEnabled !== 1) {
    db.close();
    throw new Error(
      `SQLite foreign_keys pragma failed to enable (got ${String(fkEnabled)}). ` +
        `This SQLite build may not support FK constraints — refusing to open.`,
    );
  }

  return db;
}
