import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import type { Scheduler } from '../scheduler.js';
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  archiveProject,
  wakeProject,
} from '../../db/queries/projects.js';
import {
  cloneProjectType,
  createEmptyProjectType,
  getProjectTypeForProject,
  setProjectTypeOwner,
  updateProjectType,
} from '../../db/queries/project-types.js';
import {
  createProjectBody,
  updateProjectBody,
  updateProjectWorkflowBody,
  listProjectsQuery,
  idParam,
} from '../schemas.js';

export async function projectRoutes(app: FastifyInstance, db: Database, scheduler?: Scheduler): Promise<void> {
  // GET /api/projects — list (filterable by status)
  app.get('/api/projects', async (request) => {
    const query = listProjectsQuery.parse(request.query);
    return listProjects(db, query.status ? { status: query.status } : undefined);
  });

  // GET /api/projects/:id — detail with heartbeat state
  app.get<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const project = getProject(db, id);
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }
    return project;
  });

  // POST /api/projects — register a new project.
  //
  // Project types are *templates*. On registration we clone the chosen template
  // (and its columns) into a fresh project-scoped project_type, then point the
  // new project at that copy. Editing the project's workflow later never
  // touches the library template or any other project. A special 'blank'
  // template id creates an empty workflow the user fills in themselves.
  app.post('/api/projects', async (request, reply) => {
    const body = createProjectBody.parse(request.body);

    // Resolve the template. 'blank' bypasses the library lookup entirely.
    if (body.project_type_id !== 'blank') {
      const tpl = db
        .prepare(
          // Only library templates (owner_project_id IS NULL) can be used at registration.
          // Project-scoped copies of other projects must not be reusable here.
          'SELECT 1 FROM project_types WHERE id = ? AND owner_project_id IS NULL',
        )
        .get(body.project_type_id);
      if (!tpl) {
        return reply
          .status(400)
          .send({ error: `Unknown template: ${body.project_type_id}` });
      }
    }

    // Verify path is not already registered
    const pathExists = db.prepare('SELECT 1 FROM projects WHERE path = ?').get(body.path);
    if (pathExists) {
      return reply.status(409).send({ error: `Path already registered: ${body.path}` });
    }

    // Registration in one transaction:
    //   1. Clone (or create blank) the project_type with owner_project_id=NULL.
    //      Has to come first because the project row FK-references a valid
    //      project_type id.
    //   2. Create the project pointing at that new type.
    //   3. Reparent the project_type to the new project via UPDATE.
    //
    // If any step fails the whole transaction rolls back — no orphaned types,
    // no half-created projects.
    const result = db.transaction(() => {
      const scopedType =
        body.project_type_id === 'blank'
          ? createEmptyProjectType(db, body.name, null)
          : cloneProjectType(db, body.project_type_id, null);

      const project = createProject(db, {
        name: body.name,
        path: body.path,
        projectTypeId: scopedType.id,
      });

      setProjectTypeOwner(db, scopedType.id, project.id);

      return project;
    })();

    return reply.status(201).send(getProject(db, result.id));
  });

  // GET /api/projects/:id/workflow — columns + agent assignments for the project.
  app.get<{ Params: { id: string } }>('/api/projects/:id/workflow', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const project = getProject(db, id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const workflow = getProjectTypeForProject(db, id);
    if (!workflow) {
      // Legacy project created before migration 003 — still points at a
      // shared library template. Surface the state explicitly instead of
      // lying with a 404.
      return reply
        .status(409)
        .send({ error: 'Project uses a legacy shared template; re-register to customize.' });
    }
    return workflow;
  });

  // PUT /api/projects/:id/workflow — replace the project's column list.
  // Validates that no ticket lives in a column that's being removed.
  app.put<{ Params: { id: string } }>('/api/projects/:id/workflow', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = updateProjectWorkflowBody.parse(request.body);
    const project = getProject(db, id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const workflow = getProjectTypeForProject(db, id);
    if (!workflow) {
      return reply
        .status(409)
        .send({ error: 'Project uses a legacy shared template; re-register to customize.' });
    }

    // Refuse to remove any column that still holds tickets. Prevents
    // orphaned tickets pinned to a non-existent column.
    const incomingIds = new Set(body.columns.map((c) => c.column_id));
    const removedIds = workflow.columns
      .map((c) => c.column_id)
      .filter((id) => !incomingIds.has(id));
    if (removedIds.length > 0) {
      const placeholders = removedIds.map(() => '?').join(',');
      const orphaned = db
        .prepare(
          `SELECT "column", COUNT(*) AS c FROM tickets
           WHERE project_id = ? AND "column" IN (${placeholders})
           GROUP BY "column"`,
        )
        .all(project.id, ...removedIds) as Array<{ column: string; c: number }>;
      if (orphaned.length > 0) {
        return reply.status(409).send({
          error: 'Cannot remove columns that still hold tickets',
          columns: orphaned,
        });
      }
    }

    // Verify every referenced agent_type exists and is either library or
    // owned by this project. Prevents leaking another project's agents.
    for (const col of body.columns) {
      if (!col.agent_type_id) continue;
      const agent = db
        .prepare(
          `SELECT owner_project_id FROM agent_types
           WHERE id = ? AND (owner_project_id IS NULL OR owner_project_id = ?)`,
        )
        .get(col.agent_type_id, project.id);
      if (!agent) {
        return reply.status(400).send({
          error: `Unknown or out-of-scope agent: ${col.agent_type_id}`,
        });
      }
    }

    const updated = updateProjectType(db, workflow.id, { columns: body.columns });
    return updated;
  });

  // PATCH /api/projects/:id — update
  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = updateProjectBody.parse(request.body);

    if (body.project_type_id) {
      const typeExists = db
        .prepare('SELECT 1 FROM project_types WHERE id = ?')
        .get(body.project_type_id);
      if (!typeExists) {
        return reply.status(400).send({ error: `Unknown project type: ${body.project_type_id}` });
      }
    }

    const updated = updateProject(db, id, {
      name: body.name,
      projectTypeId: body.project_type_id,
      status: body.status,
    });
    if (!updated) {
      return reply.status(404).send({ error: 'Project not found' });
    }
    return updated;
  });

  // DELETE /api/projects/:id — archive (not hard delete)
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const archived = archiveProject(db, id);
    if (!archived) {
      return reply.status(404).send({ error: 'Project not found' });
    }
    return { status: 'archived' };
  });

  // POST /api/projects/:id/wake — manually reset heartbeat
  app.post<{ Params: { id: string } }>('/api/projects/:id/wake', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const project = getProject(db, id);
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }
    wakeProject(db, id);
    // Also reschedule the scheduler's in-memory timer so the heartbeat
    // fires at the new next_check_at, not the old one. (Gap fix #2)
    scheduler?.resetProject(id);
    return { status: 'heartbeat_reset' };
  });
}
