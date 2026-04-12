import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import {
  listProjectTypes,
  getProjectType,
  createProjectType,
  updateProjectType,
  deleteProjectType,
} from '../../db/queries/project-types.js';

const columnSchema = z.object({
  column_id: z.string().min(1),
  name: z.string().min(1),
  agent_type_id: z.string().nullable().optional(),
  order: z.number().int().min(0),
});

const createProjectTypeBody = z.object({
  id: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'Must be a lowercase slug'),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  columns: z.array(columnSchema).min(2).refine(
    (cols) => {
      const ids = cols.map((c) => c.column_id);
      return ids.includes('human') && ids.includes('done');
    },
    { message: "Must include 'human' and 'done' columns" },
  ),
});

const updateProjectTypeBody = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  columns: z.array(columnSchema).min(2).refine(
    (cols) => {
      const ids = cols.map((c) => c.column_id);
      return ids.includes('human') && ids.includes('done');
    },
    { message: "Must include 'human' and 'done' columns" },
  ).optional(),
});

// Use a simple string param for project type IDs (slugs, not UUIDs)
const slugParam = z.object({ id: z.string().min(1) });

export async function projectTypeRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // GET /api/project-types
  app.get('/api/project-types', async () => {
    return listProjectTypes(db);
  });

  // GET /api/project-types/:id — with columns
  app.get<{ Params: { id: string } }>('/api/project-types/:id', async (request, reply) => {
    const { id } = slugParam.parse(request.params);
    const pt = getProjectType(db, id);
    if (!pt) return reply.status(404).send({ error: 'Project type not found' });
    return pt;
  });

  // POST /api/project-types
  app.post('/api/project-types', async (request, reply) => {
    const body = createProjectTypeBody.parse(request.body);

    // Check for duplicate ID
    const exists = db.prepare('SELECT 1 FROM project_types WHERE id = ?').get(body.id);
    if (exists) {
      return reply.status(409).send({ error: `Project type already exists: ${body.id}` });
    }

    // Validate agent_type_ids in columns
    for (const col of body.columns) {
      if (col.agent_type_id) {
        const atExists = db
          .prepare('SELECT 1 FROM agent_types WHERE id = ?')
          .get(col.agent_type_id);
        if (!atExists) {
          return reply
            .status(400)
            .send({ error: `Unknown agent type: ${col.agent_type_id} in column ${col.column_id}` });
        }
      }
    }

    const pt = createProjectType(db, body);
    return reply.status(201).send(pt);
  });

  // PATCH /api/project-types/:id
  app.patch<{ Params: { id: string } }>('/api/project-types/:id', async (request, reply) => {
    const { id } = slugParam.parse(request.params);
    const body = updateProjectTypeBody.parse(request.body);

    // If columns are being replaced, check that no tickets exist in removed columns
    if (body.columns) {
      const existing = getProjectType(db, id);
      if (!existing) return reply.status(404).send({ error: 'Project type not found' });

      const newColumnIds = new Set(body.columns.map((c) => c.column_id));
      const removedColumns = existing.columns.filter((c) => !newColumnIds.has(c.column_id));

      for (const removed of removedColumns) {
        const ticketsInColumn = db
          .prepare(
            `SELECT COUNT(*) AS c FROM tickets t
             JOIN projects p ON t.project_id = p.id
             WHERE p.project_type_id = ? AND t."column" = ?`,
          )
          .get(id, removed.column_id) as { c: number };
        if (ticketsInColumn.c > 0) {
          return reply.status(409).send({
            error: `Cannot remove column '${removed.column_id}': ${ticketsInColumn.c} ticket(s) still in it`,
          });
        }
      }

      // Validate agent_type_ids
      for (const col of body.columns) {
        if (col.agent_type_id) {
          const atExists = db
            .prepare('SELECT 1 FROM agent_types WHERE id = ?')
            .get(col.agent_type_id);
          if (!atExists) {
            return reply
              .status(400)
              .send({ error: `Unknown agent type: ${col.agent_type_id} in column ${col.column_id}` });
          }
        }
      }
    }

    const updated = updateProjectType(db, id, body);
    if (!updated) return reply.status(404).send({ error: 'Project type not found' });
    return updated;
  });

  // DELETE /api/project-types/:id
  app.delete<{ Params: { id: string } }>('/api/project-types/:id', async (request, reply) => {
    const { id } = slugParam.parse(request.params);
    const result = deleteProjectType(db, id);

    if (!result.deleted) {
      const status = result.reason === 'not_found' ? 404 : 409;
      const message =
        result.reason === 'is_builtin'
          ? 'Cannot delete built-in project type'
          : result.reason === 'in_use'
            ? 'Cannot delete project type: projects are using it'
            : 'Project type not found';
      return reply.status(status).send({ error: message });
    }

    return { status: 'deleted' };
  });
}
