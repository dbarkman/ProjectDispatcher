import type { Database } from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveAbbreviation, uniqueAbbreviation } from './queries/abbreviation.js';

/**
 * Migrations live next to this file. In dev (vitest / tsx) this resolves to
 * `src/db/migrations/`; in prod it resolves to `dist/db/migrations/` thanks
 * to `scripts/copy-assets.mjs` which copies the SQL files during `npm run
 * build`. Same relative path in both cases, no environment branching.
 */
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Migration filenames must match this convention: three-digit zero-padded
 * sequence number, underscore, lowercase-letters/digits/underscores/hyphens,
 * `.sql`. Example: `002_add_webhooks.sql`.
 *
 * The convention exists because `readdirSync().sort()` is lexicographic —
 * `02_foo.sql` would sort between `001` and `002` instead of becoming file
 * number 2. Enforcing the NNN prefix makes the sort order match the intended
 * application order.
 */
const MIGRATION_FILENAME_RE = /^\d{3}_[a-z0-9_-]+\.sql$/;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply any pending SQL migrations in lexicographic filename order.
 *
 * Each migration runs inside its own transaction. A failed migration rolls
 * back cleanly and does not record itself in `schema_migrations`, so the
 * next run retries it. Already-applied migrations are skipped.
 *
 * Sync file I/O is deliberate: this is one-shot startup work that runs
 * before the HTTP server binds. Per our coding principles, sync fs is only
 * acceptable in that window.
 *
 * **Filename convention:** files must match `NNN_name.sql` (see
 * `MIGRATION_FILENAME_RE`). Any `.sql` file that doesn't match throws
 * loudly — silently skipping a real migration because of a typo is
 * exactly the class of bug that bites people in production.
 *
 * **Non-transactional statements are NOT supported.** Because each file
 * runs inside a single `db.transaction()`, do NOT include statements that
 * cannot run inside a transaction — `VACUUM`, `CREATE VIRTUAL TABLE USING
 * fts5`, and certain `PRAGMA` calls will fail with a confusing SQLite
 * error. If you genuinely need one, invent a convention at that time
 * (e.g. a `.no-tx.sql` suffix this function can detect) — don't build that
 * flexibility preemptively.
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

  // Read every .sql file in the migrations directory, then validate that each
  // matches the naming convention. Non-.sql files (e.g. editor swap files like
  // `.swp`, `#001_init.sql#` emacs autosaves, `.bak` copies) are ignored
  // silently because they can never be intended as migrations. Malformed .sql
  // filenames fail loudly.
  const sqlFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const malformed = sqlFiles.filter((f) => !MIGRATION_FILENAME_RE.test(f));
  if (malformed.length > 0) {
    throw new Error(
      `Migration filename(s) do not match NNN_name.sql convention: ${malformed.join(', ')}. ` +
        `Rename to e.g. 002_add_webhooks.sql or remove the file.`,
    );
  }
  const files = sqlFiles.sort();

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
      // Per-migration post-hooks run inside the same transaction so a hook
      // failure rolls the migration back. Keep these tiny — purely the kind
      // of data fix-up that can't be expressed in SQL.
      runPostMigrationHook(db, filename);
    });

    apply();
    applied.push(filename);
  }

  return { applied, skipped };
}

/**
 * Hook for migrations that need a small TypeScript-driven backfill on top
 * of the SQL. Currently only used for migration 004 which adds an
 * abbreviation column to projects but defers the CamelCase-aware
 * derivation to the deriveAbbreviation helper. Keep this explicit and
 * file-named so the link from SQL → code is obvious to a reader.
 */
function runPostMigrationHook(db: Database, filename: string): void {
  if (filename === '004_ticket_numbering.sql') {
    backfillProjectAbbreviations(db);
  }
}

function backfillProjectAbbreviations(db: Database): void {
  // Process in created_at order so older projects get the unsuffixed
  // abbreviation when two project names happen to derive the same root.
  const rows = db
    .prepare(
      "SELECT id, name FROM projects WHERE abbreviation IS NULL ORDER BY created_at ASC, id ASC",
    )
    .all() as { id: string; name: string }[];
  if (rows.length === 0) return;

  const update = db.prepare('UPDATE projects SET abbreviation = ? WHERE id = ?');
  for (const row of rows) {
    const abbr = uniqueAbbreviation(db, deriveAbbreviation(row.name));
    update.run(abbr, row.id);
  }
}
