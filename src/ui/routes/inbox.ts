import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { listProjects } from '../../db/queries/projects.js';
import { formatTicketDisplayId } from '../../db/queries/abbreviation.js';

interface InboxTicketRow {
  id: string;
  project_id: string;
  title: string;
  priority: string;
  sequence_number: number;
  updated_at: number;
  project_name: string | null;
  project_abbreviation: string;
}

export async function inboxRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // GET / — inbox view (all tickets in human columns)
  app.get('/', async (request, reply) => {
    const tickets = db
      .prepare(
        `SELECT t.id, t.project_id, t.title, t.priority, t.sequence_number, t.updated_at,
                p.name AS project_name, p.abbreviation AS project_abbreviation
         FROM tickets t
         JOIN projects p ON p.id = t.project_id
         WHERE t."column" = 'human' AND p.status != 'archived'
         ORDER BY t.updated_at DESC`,
      )
      .all() as InboxTicketRow[];

    const ticketData = tickets.map((t) => ({
      ...t,
      displayId: formatTicketDisplayId(t.project_abbreviation, t.sequence_number),
      projectName: t.project_name ?? 'Unknown',
    }));

    // Pass projects list for the "New Ticket" form dropdown
    const projects = listProjects(db);

    return reply.view('inbox.hbs', {
      activePage: 'inbox',
      pageTitle: 'Inbox',
      inboxCount: tickets.length || undefined,
      tickets: ticketData,
      projects,
      isEmpty: tickets.length === 0,
    });
  });
}
