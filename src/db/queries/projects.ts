import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  deriveAbbreviation,
  isAbbreviationTaken,
  uniqueAbbreviation,
} from './abbreviation.js';

/** Thrown by updateProject when the requested abbreviation is taken by
 *  another active project. Routes catch + return 409 with a clear message
 *  instead of silently auto-suffixing the user's typed value. */
export class AbbreviationConflictError extends Error {
  constructor(public readonly requested: string) {
    super(`Abbreviation already in use by another active project: ${requested}`);
    this.name = 'AbbreviationConflictError';
  }
}

export interface Project {
  id: string;
  name: string;
  path: string;
  project_type_id: string;
  status: string;
  abbreviation: string;
  last_activity_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ProjectWithHeartbeat extends Project {
  next_check_at: number | null;
  consecutive_empty_checks: number | null;
  last_wake_at: number | null;
  last_work_found_at: number | null;
}

export interface CreateProjectData {
  name: string;
  path: string;
  projectTypeId: string;
  /**
   * Caller-supplied short identifier used to compose human-readable ticket
   * ids ("pd-1"). If omitted, derived from `name` via deriveAbbreviation
   * with collision-resolution against existing active projects.
   */
  abbreviation?: string;
}

export interface UpdateProjectData {
  name?: string;
  projectTypeId?: string;
  status?: string;
  abbreviation?: string;
}

export interface ListProjectsFilter {
  status?: string;
}

export function createProject(db: Database, data: CreateProjectData): Project {
  const id = randomUUID();
  const now = Date.now();

  // Transactional: project + heartbeat + abbreviation resolution all land
  // or nothing does. abbreviation collision-check happens inside the same
  // transaction as the INSERT to avoid a TOCTOU race where two concurrent
  // registrations claim the same suffix.
  db.transaction(() => {
    const baseAbbr = data.abbreviation?.trim() || deriveAbbreviation(data.name);
    const abbreviation = uniqueAbbreviation(db, baseAbbr);

    db.prepare(
      `INSERT INTO projects (id, name, path, project_type_id, status, abbreviation, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(id, data.name, data.path, data.projectTypeId, abbreviation, now, now);

    db.prepare(
      `INSERT INTO project_heartbeats (project_id, next_check_at, updated_at)
       VALUES (?, ?, ?)`,
    ).run(id, now + 300_000, now);
  })();

  return getProject(db, id)!;
}

export function getProject(db: Database, id: string): ProjectWithHeartbeat | null {
  return (
    db
      .prepare(
        `SELECT p.*, ph.next_check_at, ph.consecutive_empty_checks,
                ph.last_wake_at, ph.last_work_found_at
         FROM projects p
         LEFT JOIN project_heartbeats ph ON ph.project_id = p.id
         WHERE p.id = ?`,
      )
      .get(id) as ProjectWithHeartbeat | undefined
  ) ?? null;
}

export function listProjects(db: Database, filter?: ListProjectsFilter): Project[] {
  if (filter?.status) {
    return db
      .prepare('SELECT * FROM projects WHERE status = ? ORDER BY name')
      .all(filter.status) as Project[];
  }
  // Default: show all non-archived
  return db
    .prepare("SELECT * FROM projects WHERE status != 'archived' ORDER BY name")
    .all() as Project[];
}

export function updateProject(
  db: Database,
  id: string,
  data: UpdateProjectData,
): ProjectWithHeartbeat | null {
  // Wrap the read + collision check + UPDATE in a single transaction so
  // two concurrent renames to the same target can't both pass the check
  // and race on the partial unique index.
  return db.transaction(() => {
    const existing = getProject(db, id);
    if (!existing) return null;

    const fields: string[] = [];
    const values: unknown[] = [];

    if (data.name !== undefined && data.name !== existing.name) {
      fields.push('name = ?');
      values.push(data.name);
    }
    if (data.projectTypeId !== undefined && data.projectTypeId !== existing.project_type_id) {
      fields.push('project_type_id = ?');
      values.push(data.projectTypeId);
    }
    if (data.status !== undefined && data.status !== existing.status) {
      fields.push('status = ?');
      values.push(data.status);
    }
    if (data.abbreviation !== undefined) {
      const requested = data.abbreviation.trim();
      if (requested !== existing.abbreviation) {
        // Explicit user input — refuse with a typed error on collision instead
        // of silently appending a digit suffix. Caller (route) maps to 409.
        if (isAbbreviationTaken(db, requested, existing.id)) {
          throw new AbbreviationConflictError(requested);
        }
        fields.push('abbreviation = ?');
        values.push(requested);
      }
    }

    // No real changes? Skip the UPDATE entirely so updated_at doesn't
    // get bumped on a no-op. (Review L-1.)
    if (fields.length === 0) return existing;

    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);
    db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    return getProject(db, id);
  })();
}

export function archiveProject(db: Database, id: string): boolean {
  // Just flip status. The partial unique index on projects.path excludes
  // archived rows, so the folder can be re-registered without collision.
  const result = db
    .prepare("UPDATE projects SET status = 'archived', updated_at = ? WHERE id = ?")
    .run(Date.now(), id);
  return result.changes > 0;
}

export function wakeProject(db: Database, id: string): boolean {
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE project_heartbeats
       SET next_check_at = ?, consecutive_empty_checks = 0, last_wake_at = ?, updated_at = ?
       WHERE project_id = ?`,
    )
    .run(now + 5000, now, now, id); // consecutive_empty_checks=0 is a SQL literal, not a param
  return result.changes > 0;
}
