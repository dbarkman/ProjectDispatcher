import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface Project {
  id: string;
  name: string;
  path: string;
  project_type_id: string;
  status: string;
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
}

export interface UpdateProjectData {
  name?: string;
  projectTypeId?: string;
  status?: string;
}

export interface ListProjectsFilter {
  status?: string;
}

export function createProject(db: Database, data: CreateProjectData): Project {
  const id = randomUUID();
  const now = Date.now();

  db.prepare(
    `INSERT INTO projects (id, name, path, project_type_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  ).run(id, data.name, data.path, data.projectTypeId, now, now);

  // Also create a heartbeat row for this project
  db.prepare(
    `INSERT INTO project_heartbeats (project_id, next_check_at, updated_at)
     VALUES (?, ?, ?)`,
  ).run(id, now + 300_000, now); // 5 min from now

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
  const existing = getProject(db, id);
  if (!existing) return null;

  const now = Date.now();
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];

  if (data.name !== undefined) {
    fields.push('name = ?');
    values.push(data.name);
  }
  if (data.projectTypeId !== undefined) {
    fields.push('project_type_id = ?');
    values.push(data.projectTypeId);
  }
  if (data.status !== undefined) {
    fields.push('status = ?');
    values.push(data.status);
  }

  values.push(id);
  db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  return getProject(db, id);
}

export function archiveProject(db: Database, id: string): boolean {
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
    .run(now + 5000, 0, now, id); // 5 seconds from now — immediate wake
  return result.changes > 0;
}
