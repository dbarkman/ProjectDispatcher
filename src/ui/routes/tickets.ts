import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import type { TicketComment } from '../../db/queries/tickets.js';
import { getTicketWithComments } from '../../db/queries/tickets.js';
import { listAgentRuns } from '../../db/queries/agent-runs.js';
import { listAttachments } from '../../db/queries/attachments.js';
import { getInboxCount } from './helpers.js';

const uuidParam = z.object({ id: z.string().uuid() });

interface DecoratedComment extends TicketComment {
  isMove: boolean;
  isFinding: boolean;
  isBlock: boolean;
  isComplete: boolean;
  isJournal: boolean;
  isOther: boolean;
  parsedMeta: unknown;
}

function decorateComments(comments: TicketComment[]): DecoratedComment[] {
  return comments.map((c) => {
    const isMove = c.type === 'move';
    const isFinding = c.type === 'finding';
    const isBlock = c.type === 'block';
    const isComplete = c.type === 'complete';
    const isJournal = c.type === 'journal';
    return {
      ...c,
      isMove,
      isFinding,
      isBlock,
      isComplete,
      isJournal,
      isOther: !(isMove || isFinding || isBlock || isComplete || isJournal),
      parsedMeta: c.meta ? safeParse(c.meta) : null,
    };
  });
}

interface TicketRoutesDeps {
  commentThreadTemplate: HandlebarsTemplateDelegate;
}

export async function ticketUiRoutes(
  app: FastifyInstance,
  db: Database,
  deps: TicketRoutesDeps,
): Promise<void> {
  // GET /ui/tickets/:id — ticket detail with thread + agent runs
  app.get<{ Params: { id: string } }>('/ui/tickets/:id', async (request, reply) => {
    const { id } = uuidParam.parse(request.params);
    const ticket = getTicketWithComments(db, id);
    if (!ticket) return reply.status(404).send('Ticket not found');

    const project = db
      .prepare('SELECT id, name, project_type_id, abbreviation FROM projects WHERE id = ?')
      .get(ticket.project_id) as
      | { id: string; name: string; project_type_id: string; abbreviation: string }
      | undefined;

    // Defense in depth: ticket must resolve to an existing project. The daemon
    // has FK constraints so this shouldn't ever fail in practice, but refuse
    // to render anything if the invariant is broken. (Review #8 defense-in-depth)
    if (!project) return reply.status(404).send('Ticket not found');

    // Get available columns for the move dropdown
    const columns = db
      .prepare(
        'SELECT column_id, name FROM project_type_columns WHERE project_type_id = ? ORDER BY "order"',
      )
      .all(project.project_type_id) as Array<{ column_id: string; name: string }>;

    // Get the workflow column order for next/previous column buttons
    const currentColIdx = columns.findIndex((c) => c.column_id === ticket.column);
    const prevColumn = currentColIdx > 0 ? columns[currentColIdx - 1] : null;
    const nextColumn = currentColIdx >= 0 && currentColIdx < columns.length - 1 ? columns[currentColIdx + 1] : null;

    const comments = decorateComments(ticket.comments);

    // Get agent runs for this ticket (Gap fix #5 — transcript modal)
    const agentRuns = listAgentRuns(db, { ticketId: id }).map((r) => ({
      ...r,
      shortId: r.id.slice(0, 8),
      hasTranscript: r.transcript_path !== null,
      durationStr: r.ended_at && r.started_at
        ? formatDuration(r.ended_at - r.started_at)
        : 'running',
    }));

    // Get attachments for this ticket
    const attachments = listAttachments(db, id).map((a) => ({
      ...a,
      sizeStr: formatFileSize(a.size_bytes),
      isImage: a.mime_type.startsWith('image/'),
    }));

    return reply.view('ticket.hbs', {
      activePage: 'inbox',
      pageTitle: ticket.title,
      inboxCount: getInboxCount(db) || undefined,
      breadcrumbs: [
        { label: 'Inbox', href: '/' },
        { label: project.name, href: `/ui/projects/${project.id}` },
        { label: ticket.title, href: `/ui/tickets/${ticket.id}` },
      ],
      ticket: {
        ...ticket,
        displayId: `${project.abbreviation}-${ticket.sequence_number}`,
      },
      comments,
      columns,
      prevColumn,
      nextColumn,
      agentRuns,
      attachments,
      projectName: project.name,
    });
  });

  // GET /ui/tickets/:id/comments — htmx partial endpoint.
  // Returns only the comment-thread fragment so the ticket page can
  // poll for updates without reloading the whole view.
  app.get<{ Params: { id: string } }>('/ui/tickets/:id/comments', async (request, reply) => {
    const { id } = uuidParam.parse(request.params);
    const ticket = getTicketWithComments(db, id);
    if (!ticket) return reply.status(404).send('Ticket not found');

    const comments = decorateComments(ticket.comments);
    return reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(deps.commentThreadTemplate({ comments }));
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}
