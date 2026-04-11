import type { Database } from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Migrations live next to this file. In dev (vitest / tsx) this resolves to
 * `src/db/migrations/`; in prod it resolves to `dist/db/migrations/` thanks
 * to `scripts/copy-assets.mjs` which copies the SQL files during `npm run
 * build`. Same relative path in both cases, no environment branching.
 */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply any pending SQL migrations in lexicographic filename order.
 *
 * Each migration runs inside its own transaction — if it fails, the file is
 * rolled back and no record is written to `schema_migrations`, so the next
 * run will retry it cleanly. Already-applied migrations are skipped.
 *
 * Sync file I/O is deliberate: this is one-shot startup work that runs
 * before the server binds. Per our coding principles, sync fs is only
 * acceptable in that window.
 */
export function runMigrations(db: Database): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const alreadyApplied = new Set(
    (db.prepare('SELECT filename FROM schema_migrations').all() as { filename: string }[]).map(
      (r) => r.filename,
    ),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  const skipped: string[] = [];

  const recordStmt = db.prepare(
    'INSERT INTO schema_migrations (filename, applied_at) VALUES (?, ?)',
  );

  for (const filename of files) {
    if (alreadyApplied.has(filename)) {
      skipped.push(filename);
      continue;
    }

    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');

    const apply = db.transaction(() => {
      db.exec(sql);
      recordStmt.run(filename, Date.now());
    });

    apply();
    applied.push(filename);
  }

  return { applied, skipped };
}
