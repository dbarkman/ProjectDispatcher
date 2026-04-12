import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  archiveProject,
  wakeProject,
} from '../../db/queries/projects.js';
import {
  createProjectBody,
  updateProjectBody,
  listProjectsQuery,
  idParam,
} from '../schemas.js';

export async function projectRoutes(app: FastifyInstance, db: Database): Promise<void> {
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

  // POST /api/projects — register a new project
  app.post('/api/projects', async (request, reply) => {
    const body = createProjectBody.parse(request.body);

    // Verify project_type_id exists
    const typeExists = db
      .prepare('SELECT 1 FROM project_types WHERE id = ?')
      .get(body.project_type_id);
    if (!typeExists) {
      return reply.status(400).send({ error: `Unknown project type: ${body.project_type_id}` });
    }

    // Verify path is not already registered
    const pathExists = db.prepare('SELECT 1 FROM projects WHERE path = ?').get(body.path);
    if (pathExists) {
      return reply.status(409).send({ error: `Path already registered: ${body.path}` });
    }

    const project = createProject(db, {
      name: body.name,
      path: body.path,
      projectTypeId: body.project_type_id,
    });
    return reply.status(201).send(project);
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
    return { status: 'heartbeat_reset' };
  });
}
