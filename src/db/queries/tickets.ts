import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface Ticket {
  id: string;
  project_id: string;
  title: string;
  body: string | null;
  column: string;
  priority: string;
  tags: string | null; // JSON array
  claimed_by_run_id: string | null;
  claimed_at: number | null;
  created_by: string;
  /** Per-project monotonically-increasing number used for human-readable ids. */
  sequence_number: number;
  created_at: number;
  updated_at: number;
}

export interface TicketComment {
  id: string;
  ticket_id: string;
  type: string;
  author: string;
  body: string | null;
  meta: string | null; // JSON
  created_at: number;
}

export interface TicketWithComments extends Ticket {
  comments: TicketComment[];
}

export interface CreateTicketData {
  projectId: string;
  title: string;
  body?: string;
  column?: string;
  priority?: string;
  tags?: string[];
  createdBy?: string;
}

export interface UpdateTicketData {
  title?: string;
  body?: string;
  priority?: string;
  tags?: string[];
}

export interface ListTicketsFilter {
  project?: string;
  column?: string;
  priority?: string;
}

export interface MoveTicketData {
  toColumn: string;
  comment?: string;
  author?: string;
}

export interface AddCommentData {
  type: string;
  author: string;
  body?: string;
  meta?: Record<string, unknown>;
}

export function createTicket(db: Database, data: CreateTicketData): Ticket {
  const id = randomUUID();
  const now = Date.now();

  // Allocate the next sequence_number inside the transaction so two
  // concurrent INSERTs can't pick the same number. better-sqlite3
  // serializes transactions, and the UNIQUE (project_id, sequence_number)
  // index is the schema-level safety net.
  return db.transaction(() => {
    const row = db
      .prepare(
        'SELECT COALESCE(MAX(sequence_number), 0) + 1 AS next FROM tickets WHERE project_id = ?',
      )
      .get(data.projectId) as { next: number };

    db.prepare(
      `INSERT INTO tickets (id, project_id, title, body, "column", priority, tags, created_by, sequence_number, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      data.projectId,
      data.title,
      data.body ?? null,
      data.column ?? 'human',
      data.priority ?? 'normal',
      data.tags ? JSON.stringify(data.tags) : null,
      data.createdBy ?? 'human',
      row.next,
      now,
      now,
    );

    return getTicket(db, id)!;
  })();
}

export function getTicket(db: Database, id: string): Ticket | null {
  return (db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Ticket | undefined) ?? null;
}

export function getTicketWithComments(db: Database, id: string): TicketWithComments | null {
  const ticket = getTicket(db, id);
  if (!ticket) return null;

  const comments = db
    .prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at')
    .all(id) as TicketComment[];

  return { ...ticket, comments };
}

export function listTickets(db: Database, filter?: ListTicketsFilter): Ticket[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter?.project) {
    conditions.push('project_id = ?');
    values.push(filter.project);
  }
  if (filter?.column) {
    conditions.push('"column" = ?');
    values.push(filter.column);
  }
  if (filter?.priority) {
    conditions.push('priority = ?');
    values.push(filter.priority);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db
    .prepare(`SELECT * FROM tickets ${where} ORDER BY updated_at DESC`)
    .all(...values) as Ticket[];
}

export function updateTicket(db: Database, id: string, data: UpdateTicketData): Ticket | null {
  const existing = getTicket(db, id);
  if (!existing) return null;

  const now = Date.now();
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];

  if (data.title !== undefined) {
    fields.push('title = ?');
    values.push(data.title);
  }
  if (data.body !== undefined) {
    fields.push('body = ?');
    values.push(data.body);
  }
  if (data.priority !== undefined) {
    fields.push('priority = ?');
    values.push(data.priority);
  }
  if (data.tags !== undefined) {
    fields.push('tags = ?');
    values.push(JSON.stringify(data.tags));
  }

  values.push(id);
  db.prepare(`UPDATE tickets SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  return getTicket(db, id);
}

export function deleteTicket(db: Database, id: string): boolean {
  const result = db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
  return result.changes > 0;
}

/**
 * Move a ticket to a different column. Atomic: updates the ticket and
 * inserts a 'move' comment in one transaction.
 *
 * Returns the updated ticket or null if not found.
 */
export function moveTicket(
  db: Database,
  id: string,
  data: MoveTicketData,
): Ticket | null {
  const ticket = getTicket(db, id);
  if (!ticket) return null;

  const now = Date.now();
  const fromColumn = ticket.column;
  const author = data.author ?? 'human';

  const apply = db.transaction(() => {
    // Update the ticket's column
    db.prepare(
      `UPDATE tickets SET "column" = ?, updated_at = ? WHERE id = ?`,
    ).run(data.toColumn, now, id);

    // Insert a 'move' comment recording the transition
    db.prepare(
      `INSERT INTO ticket_comments (id, ticket_id, type, author, body, meta, created_at)
       VALUES (?, ?, 'move', ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      id,
      author,
      data.comment ?? null,
      JSON.stringify({ from_column: fromColumn, to_column: data.toColumn }),
      now,
    );

    // If moving to an agent column, reset the project's heartbeat so the
    // scheduler picks it up quickly. Check if the target column has an
    // agent_type_id.
    const project = db
      .prepare('SELECT project_type_id FROM projects WHERE id = ?')
      .get(ticket.project_id) as { project_type_id: string } | undefined;

    if (project) {
      const col = db
        .prepare(
          `SELECT agent_type_id FROM project_type_columns
           WHERE project_type_id = ? AND column_id = ?`,
        )
        .get(project.project_type_id, data.toColumn) as { agent_type_id: string | null } | undefined;

      if (col?.agent_type_id) {
        // Target is an agent column — reset heartbeat to near-immediate
        db.prepare(
          `UPDATE project_heartbeats
           SET next_check_at = ?, consecutive_empty_checks = 0, last_wake_at = ?, updated_at = ?
           WHERE project_id = ?`,
        ).run(now + 5000, now, now, ticket.project_id);
      }
    }
  });

  apply();
  return getTicket(db, id);
}

/**
 * Add a comment to a ticket. Append-only — comments are never updated
 * or deleted.
 */
export function addComment(db: Database, ticketId: string, data: AddCommentData): TicketComment {
  const id = randomUUID();
  const now = Date.now();

  db.prepare(
    `INSERT INTO ticket_comments (id, ticket_id, type, author, body, meta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    ticketId,
    data.type,
    data.author,
    data.body ?? null,
    data.meta ? JSON.stringify(data.meta) : null,
    now,
  );

  return db.prepare('SELECT * FROM ticket_comments WHERE id = ?').get(id) as TicketComment;
}
