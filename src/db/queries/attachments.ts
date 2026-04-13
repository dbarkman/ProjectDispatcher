import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface TicketAttachment {
  id: string;
  ticket_id: string;
  filename: string;
  stored_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: number;
}

export interface CreateAttachmentData {
  ticketId: string;
  filename: string;
  storedName: string;
  mimeType: string;
  sizeBytes: number;
}

export function createAttachment(db: Database, data: CreateAttachmentData): TicketAttachment {
  const id = randomUUID();
  const now = Date.now();

  db.prepare(
    `INSERT INTO ticket_attachments (id, ticket_id, filename, stored_name, mime_type, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, data.ticketId, data.filename, data.storedName, data.mimeType, data.sizeBytes, now);

  return db.prepare('SELECT * FROM ticket_attachments WHERE id = ?').get(id) as TicketAttachment;
}

export function listAttachments(db: Database, ticketId: string): TicketAttachment[] {
  return db
    .prepare('SELECT * FROM ticket_attachments WHERE ticket_id = ? ORDER BY created_at')
    .all(ticketId) as TicketAttachment[];
}

export function getAttachment(db: Database, id: string): TicketAttachment | null {
  return (
    (db.prepare('SELECT * FROM ticket_attachments WHERE id = ?').get(id) as TicketAttachment | undefined) ?? null
  );
}

export function deleteAttachment(db: Database, id: string): boolean {
  const result = db.prepare('DELETE FROM ticket_attachments WHERE id = ?').run(id);
  return result.changes > 0;
}
