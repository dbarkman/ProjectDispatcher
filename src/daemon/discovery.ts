import { readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { Config } from '../config.schema.js';

export interface DiscoveryResult {
  /** Paths already registered in the DB (confirmed still on disk). */
  registered: string[];
  /** Paths found on disk but not in the DB — available for registration. */
  discovered: string[];
  /** Paths in the DB whose folders no longer exist on disk. */
  missing: string[];
  /** Projects whose status was changed from 'missing' back to 'active'. */
  restored: string[];
}

/**
 * Scan the discovery root for project folders and reconcile with the DB.
 *
 * Async: uses fs/promises throughout. Called both at daemon startup
 * (where await is fine — runs before app.listen) and from the watcher
 * callback (where sync I/O would block the event loop). Previous
 * version used readdirSync/statSync which violated the coding principle
 * outside startup. (Review #5 F-01 / M-02)
 *
 * Does NOT create DB rows for undiscovered folders — the user must
 * explicitly register a project (picking a type) via the API or CLI.
 * Discovery re-runs on every startup, so the "discovered" list is
 * always fresh.
 */
export async function discoverProjects(db: Database, config: Config): Promise<DiscoveryResult> {
  const rootPath = config.discovery.root_path;
  const ignoreSet = new Set(config.discovery.ignore);

  // 1. List immediate subdirectories under the root
  let diskFolders: string[];
  try {
    const entries = await readdir(rootPath);
    const checks = await Promise.all(
      entries
        .filter((name) => !name.startsWith('.') && !ignoreSet.has(name))
        .map(async (name) => {
          const fullPath = join(rootPath, name);
          try {
            const s = await stat(fullPath);
            return s.isDirectory() ? fullPath : null;
          } catch {
            return null;
          }
        }),
    );
    diskFolders = checks.filter((p): p is string => p !== null);
  } catch {
    // Root doesn't exist yet (first run before any projects) — that's fine
    diskFolders = [];
  }

  const diskPathSet = new Set(diskFolders);

  // 2. Get all registered project paths from the DB (sync — DB queries are
  //    always sync with better-sqlite3, and that's fine; it's the filesystem
  //    scanning that needed to be async).
  const dbProjects = db
    .prepare("SELECT id, path, status FROM projects WHERE status != 'archived'")
    .all() as Array<{ id: string; path: string; status: string }>;

  const dbPathMap = new Map(dbProjects.map((p) => [p.path, p]));

  const registered: string[] = [];
  const discovered: string[] = [];
  const missing: string[] = [];
  const restored: string[] = [];
  const now = Date.now();

  // 3. For each folder on disk: is it registered?
  for (const folderPath of diskFolders) {
    const existing = dbPathMap.get(folderPath);
    if (existing) {
      registered.push(folderPath);
      if (existing.status === 'missing') {
        db.prepare("UPDATE projects SET status = 'active', updated_at = ? WHERE id = ?").run(
          now,
          existing.id,
        );
        restored.push(folderPath);
      }
    } else {
      discovered.push(folderPath);
    }
  }

  // 4. For each registered project: is its folder still on disk?
  for (const dbProject of dbProjects) {
    if (!diskPathSet.has(dbProject.path) && dbProject.status !== 'missing') {
      db.prepare("UPDATE projects SET status = 'missing', updated_at = ? WHERE id = ?").run(
        now,
        dbProject.id,
      );
      missing.push(dbProject.path);
    }
  }

  return { registered, discovered, missing, restored };
}

/**
 * Get the display name for a discovered (not yet registered) folder.
 */
export function folderDisplayName(folderPath: string): string {
  return basename(folderPath);
}
