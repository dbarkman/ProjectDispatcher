import { readdirSync, statSync } from 'node:fs';
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
 * This is a pure read + diff operation against the filesystem and the DB.
 * It does NOT create DB rows for undiscovered folders — the user must
 * explicitly register a project (picking a type) via the API or CLI.
 * This avoids the need for a nullable project_type_id FK or an
 * 'unregistered' status in the schema. Discovery re-runs on every
 * startup, so the "discovered" list is always fresh.
 *
 * It DOES mark registered projects as 'missing' if their folder vanishes,
 * and restores them to 'active' if the folder reappears.
 *
 * Sync fs is deliberate: this runs at daemon startup (same carve-out as
 * migrations and seed). The watcher (MVP-13) handles live changes.
 */
export function discoverProjects(db: Database, config: Config): DiscoveryResult {
  const rootPath = config.discovery.root_path;
  const ignoreSet = new Set(config.discovery.ignore);

  // 1. List immediate subdirectories under the root
  let diskFolders: string[];
  try {
    diskFolders = readdirSync(rootPath)
      .filter((name) => {
        if (name.startsWith('.')) return false;
        if (ignoreSet.has(name)) return false;
        try {
          return statSync(join(rootPath, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .map((name) => join(rootPath, name));
  } catch {
    // Root doesn't exist yet (first run before any projects) — that's fine
    diskFolders = [];
  }

  const diskPathSet = new Set(diskFolders);

  // 2. Get all registered project paths from the DB
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
      // If it was marked 'missing' but folder is back, restore to 'active'
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
 * Just the basename of the path.
 */
export function folderDisplayName(folderPath: string): string {
  return basename(folderPath);
}
