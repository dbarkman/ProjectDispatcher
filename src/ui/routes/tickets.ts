import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { getTicketWithComments } from '../../db/queries/tickets.js';
import { getInboxCount } from './helpers.js';

const uuidParam = z.object({ id: z.string().uuid() });

export async function ticketUiRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // GET /ui/tickets/:id — ticket detail with thread
  app.get<{ Params: { id: string } }>('/ui/tickets/:id', async (request, reply) => {
    const { id } = uuidParam.parse(request.params);
    const ticket = getTicketWithComments(db, id);
    if (!ticket) return reply.status(404).send('Ticket not found');

    const project = db
      .prepare('SELECT id, name, project_type_id FROM projects WHERE id = ?')
      .get(ticket.project_id) as { id: string; name: string; project_type_id: string } | undefined;

    // Get available columns for the move dropdown
    const columns = project
      ? (db
          .prepare(
            'SELECT column_id, name FROM project_type_columns WHERE project_type_id = ? ORDER BY "order"',
          )
          .all(project.project_type_id) as Array<{ column_id: string; name: string }>)
      : [];

    const comments = ticket.comments.map((c) => ({
      ...c,
      isMove: c.type === 'move',
      isFinding: c.type === 'finding',
      isBlock: c.type === 'block',
      isComplete: c.type === 'complete',
      isJournal: c.type === 'journal',
      parsedMeta: c.meta ? safeParse(c.meta) : null,
    }));

    return reply.view('ticket.hbs', {
      activePage: 'inbox',
      pageTitle: ticket.title,
      inboxCount: getInboxCount(db) || undefined,
      breadcrumbs: [
        { label: 'Inbox', href: '/' },
        ...(project
          ? [{ label: project.name, href: `/ui/projects/${project.id}` }]
          : []),
        { label: ticket.title, href: `/ui/tickets/${ticket.id}` },
      ],
      ticket: {
        ...ticket,
        shortId: ticket.id.slice(0, 8),
      },
      comments,
      columns,
      projectName: project?.name ?? 'Unknown',
    });
  });
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
