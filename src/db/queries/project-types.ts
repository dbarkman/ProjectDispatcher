import type { Database } from 'better-sqlite3';

export interface ProjectType {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  is_builtin: number;
  created_at: number;
  updated_at: number;
}

export interface ProjectTypeColumn {
  id: number;
  project_type_id: string;
  column_id: string;
  name: string;
  agent_type_id: string | null;
  order: number;
}

export interface ProjectTypeWithColumns extends ProjectType {
  columns: ProjectTypeColumn[];
}

export interface CreateProjectTypeData {
  id: string;
  name: string;
  description?: string;
  columns: Array<{
    column_id: string;
    name: string;
    agent_type_id?: string | null;
    order: number;
  }>;
}

export function listProjectTypes(db: Database): ProjectType[] {
  return db.prepare('SELECT * FROM project_types ORDER BY name').all() as ProjectType[];
}

export function getProjectType(db: Database, id: string): ProjectTypeWithColumns | null {
  const pt = db.prepare('SELECT * FROM project_types WHERE id = ?').get(id) as
    | ProjectType
    | undefined;
  if (!pt) return null;

  const columns = db
    .prepare('SELECT * FROM project_type_columns WHERE project_type_id = ? ORDER BY "order"')
    .all(id) as ProjectTypeColumn[];

  return { ...pt, columns };
}

export function createProjectType(db: Database, data: CreateProjectTypeData): ProjectTypeWithColumns {
  const now = Date.now();

  const insertType = db.prepare(
    `INSERT INTO project_types (id, name, description, is_builtin, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)`,
  );

  const insertCol = db.prepare(
    `INSERT INTO project_type_columns (project_type_id, column_id, name, agent_type_id, "order")
     VALUES (?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    insertType.run(data.id, data.name, data.description ?? null, now, now);
    for (const col of data.columns) {
      insertCol.run(data.id, col.column_id, col.name, col.agent_type_id ?? null, col.order);
    }
  })();

  return getProjectType(db, data.id)!;
}

export function updateProjectType(
  db: Database,
  id: string,
  patch: {
    name?: string;
    description?: string;
    columns?: Array<{
      column_id: string;
      name: string;
      agent_type_id?: string | null;
      order: number;
    }>;
  },
): ProjectTypeWithColumns | null {
  const existing = getProjectType(db, id);
  if (!existing) return null;

  const now = Date.now();

  db.transaction(() => {
    if (patch.name !== undefined || patch.description !== undefined) {
      const fields: string[] = ['updated_at = ?'];
      const values: unknown[] = [now];
      if (patch.name !== undefined) {
        fields.push('name = ?');
        values.push(patch.name);
      }
      if (patch.description !== undefined) {
        fields.push('description = ?');
        values.push(patch.description);
      }
      values.push(id);
      db.prepare(`UPDATE project_types SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    }

    if (patch.columns) {
      // Delete existing columns and re-insert. Simpler than diffing and handles
      // add/remove/reorder in one shot. Safe because we validate no tickets exist
      // in removed columns at the route level before calling this.
      db.prepare('DELETE FROM project_type_columns WHERE project_type_id = ?').run(id);

      const insertCol = db.prepare(
        `INSERT INTO project_type_columns (project_type_id, column_id, name, agent_type_id, "order")
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const col of patch.columns) {
        insertCol.run(id, col.column_id, col.name, col.agent_type_id ?? null, col.order);
      }
    }
  })();

  return getProjectType(db, id);
}

export function deleteProjectType(db: Database, id: string): { deleted: boolean; reason?: string } {
  const pt = db.prepare('SELECT is_builtin FROM project_types WHERE id = ?').get(id) as
    | { is_builtin: number }
    | undefined;
  if (!pt) return { deleted: false, reason: 'not_found' };
  if (pt.is_builtin === 1) return { deleted: false, reason: 'is_builtin' };

  // Check if any projects reference this type
  const inUse = db
    .prepare('SELECT COUNT(*) AS c FROM projects WHERE project_type_id = ?')
    .get(id) as { c: number };
  if (inUse.c > 0) return { deleted: false, reason: 'in_use' };

  db.transaction(() => {
    db.prepare('DELETE FROM project_type_columns WHERE project_type_id = ?').run(id);
    db.prepare('DELETE FROM project_types WHERE id = ?').run(id);
  })();

  return { deleted: true };
}
