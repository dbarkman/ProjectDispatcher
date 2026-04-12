import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';

interface TicketRow {
  id: string;
  project_id: string;
  title: string;
  priority: string;
  updated_at: number;
}

interface ProjectRow {
  id: string;
  name: string;
}

export async function inboxRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // GET / — inbox view (all tickets in human columns)
  app.get('/', async (request, reply) => {
    const tickets = db
      .prepare(
        `SELECT t.id, t.project_id, t.title, t.priority, t.updated_at
         FROM tickets t
         WHERE t."column" = 'human'
         ORDER BY t.updated_at DESC`,
      )
      .all() as TicketRow[];

    // Get project names for display
    const projectIds = [...new Set(tickets.map((t) => t.project_id))];
    const projectMap = new Map<string, string>();
    for (const pid of projectIds) {
      const p = db.prepare('SELECT name FROM projects WHERE id = ?').get(pid) as ProjectRow | undefined;
      if (p) projectMap.set(pid, p.name);
    }

    const ticketData = tickets.map((t) => ({
      ...t,
      shortId: t.id.slice(0, 8),
      projectName: projectMap.get(t.project_id) ?? 'Unknown',
    }));

    return reply.view('inbox.hbs', {
      activePage: 'inbox',
      pageTitle: 'Inbox',
      inboxCount: tickets.length || undefined,
      tickets: ticketData,
      isEmpty: tickets.length === 0,
    });
  });
}
