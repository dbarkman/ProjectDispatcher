import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import {
  createTicket,
  getTicketWithComments,
  listTickets,
  updateTicket,
  deleteTicket,
  moveTicket,
  addComment,
} from '../../db/queries/tickets.js';
import { idParam } from '../schemas.js';

const createTicketBody = z.object({
  project_id: z.string().uuid(),
  title: z.string().min(1).max(500),
  body: z.string().optional(),
  column: z.string().optional(), // defaults to 'human'
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  tags: z.array(z.string()).optional(),
  created_by: z.enum(['human', 'agent']).optional(),
});

const updateTicketBody = z.object({
  title: z.string().min(1).max(500).optional(),
  body: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  tags: z.array(z.string()).optional(),
});

const moveTicketBody = z.object({
  to_column: z.string().min(1),
  comment: z.string().optional(),
  author: z.string().optional(),
});

const addCommentBody = z.object({
  type: z.string().min(1),
  author: z.string().min(1),
  body: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

const listTicketsQuery = z.object({
  project: z.string().optional(),
  column: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
});

export async function ticketRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // GET /api/tickets — list with filters
  app.get('/api/tickets', async (request) => {
    const query = listTicketsQuery.parse(request.query);
    return listTickets(db, {
      project: query.project,
      column: query.column,
      priority: query.priority,
    });
  });

  // GET /api/tickets/:id — full detail with comments thread
  app.get<{ Params: { id: string } }>('/api/tickets/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const ticket = getTicketWithComments(db, id);
    if (!ticket) return reply.status(404).send({ error: 'Ticket not found' });
    return ticket;
  });

  // POST /api/tickets — create
  app.post('/api/tickets', async (request, reply) => {
    const body = createTicketBody.parse(request.body);

    // Verify project exists
    const project = db
      .prepare('SELECT id, project_type_id FROM projects WHERE id = ?')
      .get(body.project_id) as { id: string; project_type_id: string } | undefined;
    if (!project) {
      return reply.status(400).send({ error: `Unknown project: ${body.project_id}` });
    }

    // If a column is specified, verify it exists for this project's type
    if (body.column) {
      const colExists = db
        .prepare(
          'SELECT 1 FROM project_type_columns WHERE project_type_id = ? AND column_id = ?',
        )
        .get(project.project_type_id, body.column);
      if (!colExists) {
        return reply.status(400).send({
          error: `Column '${body.column}' does not exist for project type '${project.project_type_id}'`,
        });
      }
    }

    const ticket = createTicket(db, {
      projectId: body.project_id,
      title: body.title,
      body: body.body,
      column: body.column,
      priority: body.priority,
      tags: body.tags,
      createdBy: body.created_by,
    });
    return reply.status(201).send(ticket);
  });

  // PATCH /api/tickets/:id — update title, body, priority, tags (NOT column)
  app.patch<{ Params: { id: string } }>('/api/tickets/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = updateTicketBody.parse(request.body);

    const updated = updateTicket(db, id, body);
    if (!updated) return reply.status(404).send({ error: 'Ticket not found' });
    return updated;
  });

  // DELETE /api/tickets/:id — hard delete
  app.delete<{ Params: { id: string } }>('/api/tickets/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const deleted = deleteTicket(db, id);
    if (!deleted) return reply.status(404).send({ error: 'Ticket not found' });
    return { status: 'deleted' };
  });

  // POST /api/tickets/:id/move — move to another column
  app.post<{ Params: { id: string } }>('/api/tickets/:id/move', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = moveTicketBody.parse(request.body);

    // Get ticket to find its project
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as
      | { project_id: string; column: string }
      | undefined;
    if (!ticket) return reply.status(404).send({ error: 'Ticket not found' });

    // Verify target column exists for the ticket's project type
    const project = db
      .prepare('SELECT project_type_id FROM projects WHERE id = ?')
      .get(ticket.project_id) as { project_type_id: string } | undefined;
    if (project) {
      const colExists = db
        .prepare(
          'SELECT 1 FROM project_type_columns WHERE project_type_id = ? AND column_id = ?',
        )
        .get(project.project_type_id, body.to_column);
      if (!colExists) {
        return reply.status(400).send({
          error: `Column '${body.to_column}' does not exist for project type '${project.project_type_id}'`,
        });
      }
    }

    const moved = moveTicket(db, id, {
      toColumn: body.to_column,
      comment: body.comment,
      author: body.author,
    });
    if (!moved) return reply.status(404).send({ error: 'Ticket not found' });
    return moved;
  });

  // POST /api/tickets/:id/comments — add a comment
  app.post<{ Params: { id: string } }>('/api/tickets/:id/comments', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = addCommentBody.parse(request.body);

    // Verify ticket exists
    const ticket = db.prepare('SELECT 1 FROM tickets WHERE id = ?').get(id);
    if (!ticket) return reply.status(404).send({ error: 'Ticket not found' });

    const comment = addComment(db, id, body);
    return reply.status(201).send(comment);
  });
}
