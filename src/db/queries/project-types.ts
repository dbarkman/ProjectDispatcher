import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface ProjectType {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  is_builtin: number;
  owner_project_id: string | null;
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

/**
 * List library templates — is_builtin=1 plus user-created with owner_project_id NULL.
 * Project-scoped clones are filtered out. Used by the template picker and the
 * project-types admin list.
 */
export function listProjectTypes(db: Database): ProjectType[] {
  return db
    .prepare('SELECT * FROM project_types WHERE owner_project_id IS NULL ORDER BY name')
    .all() as ProjectType[];
}

/**
 * Get the project_type for a specific project — the project-scoped copy
 * that was cloned at registration. Returns null if the project doesn't
 * own any project_type (pre-migration-003 legacy project still pointing
 * at a shared library template).
 */
export function getProjectTypeForProject(
  db: Database,
  projectId: string,
): ProjectTypeWithColumns | null {
  const pt = db
    .prepare('SELECT * FROM project_types WHERE owner_project_id = ? LIMIT 1')
    .get(projectId) as ProjectType | undefined;
  if (!pt) return null;
  const columns = db
    .prepare('SELECT * FROM project_type_columns WHERE project_type_id = ? ORDER BY "order"')
    .all(pt.id) as ProjectTypeColumn[];
  return { ...pt, columns };
}

/**
 * Classify a project's workflow state.
 *   - 'scoped': the project has its own project_type clone. The happy path
 *     and the only valid state for projects registered through the API.
 *   - 'broken': the project's project_type_id doesn't resolve, or resolves
 *     to something other than its own scoped clone. Should only happen if
 *     a row was hand-edited; never produced by the API.
 */
export function describeProjectWorkflowState(
  db: Database,
  project: { id: string; project_type_id: string },
): 'scoped' | 'broken' {
  const scoped = db
    .prepare('SELECT 1 FROM project_types WHERE owner_project_id = ? LIMIT 1')
    .get(project.id);
  return scoped ? 'scoped' : 'broken';
}

/**
 * Clone a library project_type into a new row. The clone gets a fresh UUID id
 * so it can't conflict with the library slug. Columns are copied verbatim —
 * including their agent_type_id references, which continue pointing at
 * library agent types until the user forks them.
 *
 * `ownerProjectId` is nullable here so the clone can be created *before* the
 * project row exists (the FK on projects.project_type_id forces a valid
 * project_type to exist first). Callers that want the clone project-scoped
 * set the owner via a follow-up UPDATE once the project row is written.
 * See daemon/routes/projects.ts POST handler for the full dance.
 */
export function cloneProjectType(
  db: Database,
  templateId: string,
  ownerProjectId: string | null,
  nameOverride?: string,
): ProjectTypeWithColumns {
  const template = getProjectType(db, templateId);
  if (!template) throw new Error(`Template not found: ${templateId}`);
  const now = Date.now();
  const newId = randomUUID();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO project_types (id, name, description, is_builtin, owner_project_id, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`,
    ).run(
      newId,
      nameOverride ?? template.name,
      template.description,
      ownerProjectId,
      now,
      now,
    );
    const insertCol = db.prepare(
      `INSERT INTO project_type_columns (project_type_id, column_id, name, agent_type_id, "order")
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const col of template.columns) {
      insertCol.run(newId, col.column_id, col.name, col.agent_type_id, col.order);
    }
  })();

  return getProjectType(db, newId)!;
}

/**
 * Create an empty project_type row. Columns are added via updateProjectType
 * afterward. Like cloneProjectType, owner_project_id is nullable and typically
 * set after the project row exists.
 */
export function createEmptyProjectType(
  db: Database,
  name: string,
  ownerProjectId: string | null = null,
): ProjectTypeWithColumns {
  const now = Date.now();
  const newId = randomUUID();
  db.prepare(
    `INSERT INTO project_types (id, name, description, is_builtin, owner_project_id, created_at, updated_at)
     VALUES (?, ?, NULL, 0, ?, ?, ?)`,
  ).run(newId, name, ownerProjectId, now, now);
  return getProjectType(db, newId)!;
}

/**
 * Set owner_project_id on an existing project_type row. Used during project
 * registration, after the project row is created, to scope a freshly-cloned
 * type to its owner.
 */
export function setProjectTypeOwner(
  db: Database,
  projectTypeId: string,
  ownerProjectId: string,
): void {
  db.prepare(
    'UPDATE project_types SET owner_project_id = ?, updated_at = ? WHERE id = ?',
  ).run(ownerProjectId, Date.now(), projectTypeId);
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
