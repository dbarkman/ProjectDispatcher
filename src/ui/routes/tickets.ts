import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { getTicketWithComments } from '../../db/queries/tickets.js';
import { listAgentRuns } from '../../db/queries/agent-runs.js';
import { getInboxCount } from './helpers.js';

const uuidParam = z.object({ id: z.string().uuid() });

export async function ticketUiRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // GET /ui/tickets/:id — ticket detail with thread + agent runs
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

    // Get the workflow column order for next/previous column buttons
    const currentColIdx = columns.findIndex((c) => c.column_id === ticket.column);
    const prevColumn = currentColIdx > 0 ? columns[currentColIdx - 1] : null;
    const nextColumn = currentColIdx >= 0 && currentColIdx < columns.length - 1 ? columns[currentColIdx + 1] : null;

    const comments = ticket.comments.map((c) => ({
      ...c,
      isMove: c.type === 'move',
      isFinding: c.type === 'finding',
      isBlock: c.type === 'block',
      isComplete: c.type === 'complete',
      isJournal: c.type === 'journal',
      parsedMeta: c.meta ? safeParse(c.meta) : null,
    }));

    // Get agent runs for this ticket (Gap fix #5 — transcript modal)
    const agentRuns = listAgentRuns(db, { ticketId: id }).map((r) => ({
      ...r,
      shortId: r.id.slice(0, 8),
      hasTranscript: r.transcript_path !== null,
      durationStr: r.ended_at && r.started_at
        ? formatDuration(r.ended_at - r.started_at)
        : 'running',
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
      prevColumn,
      nextColumn,
      agentRuns,
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

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}
