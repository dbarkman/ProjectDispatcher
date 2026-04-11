import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Default on-disk database path. Resolved via os.homedir() so it works
 * cross-platform — never hardcode /Users/... or /home/...
 */
export const DEFAULT_DB_PATH = join(homedir(), 'Development', '.tasks', 'tasks.db');

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
