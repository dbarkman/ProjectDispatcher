import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { idParam } from '../schemas.js';
import {
  createAttachment,
  listAttachments,
  getAttachment,
  deleteAttachment,
} from '../../db/queries/attachments.js';

/**
 * Base directory for attachment file storage.
 * Cross-platform via os.homedir() — no hardcoded paths.
 */
const ATTACHMENTS_DIR = join(homedir(), 'Development', '.tasks', 'artifacts', 'attachments');

/**
 * Allowed MIME types for uploads. Images only for now (screenshot use case).
 * Extend later if needed.
 */
const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

/** Maximum file size: 10 MB. */
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const ticketIdParam = z.object({
  ticketId: z.string().uuid(),
});

export async function attachmentRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // POST /api/tickets/:ticketId/attachments — upload a file
  app.post<{ Params: { ticketId: string } }>(
    '/api/tickets/:ticketId/attachments',
    async (request, reply) => {
      const { ticketId } = ticketIdParam.parse(request.params);

      // Verify ticket exists
      const ticket = db.prepare('SELECT id, project_id FROM tickets WHERE id = ?').get(ticketId) as
        | { id: string; project_id: string }
        | undefined;
      if (!ticket) {
        return reply.status(404).send({ error: 'Ticket not found' });
      }

      const file = await request.file();
      if (!file) {
        return reply.status(400).send({ error: 'No file uploaded' });
      }

      // Validate MIME type
      if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
        return reply.status(400).send({
          error: `Unsupported file type: ${file.mimetype}. Allowed: ${[...ALLOWED_MIME_TYPES].join(', ')}`,
        });
      }

      // Read file content into buffer (respecting size limit)
      const chunks: Buffer[] = [];
      let totalSize = 0;
      for await (const chunk of file.file) {
        totalSize += chunk.length;
        if (totalSize > MAX_FILE_SIZE) {
          return reply
            .status(400)
            .send({ error: `File too large. Maximum size: ${MAX_FILE_SIZE / 1024 / 1024} MB` });
        }
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      // Generate a UUID-based stored name to prevent collisions and path traversal
      const ext = extFromMime(file.mimetype);
      const storedName = `${randomUUID()}${ext}`;

      // Ensure the ticket's attachment directory exists
      const ticketDir = join(ATTACHMENTS_DIR, ticketId);
      await mkdir(ticketDir, { recursive: true });

      // Write file to disk
      const filePath = join(ticketDir, storedName);
      await writeFile(filePath, buffer);

      // Record in DB
      const attachment = createAttachment(db, {
        ticketId,
        filename: sanitizeFilename(file.filename),
        storedName,
        mimeType: file.mimetype,
        sizeBytes: buffer.length,
      });

      return reply.status(201).send(attachment);
    },
  );

  // GET /api/tickets/:ticketId/attachments — list attachments for a ticket
  app.get<{ Params: { ticketId: string } }>(
    '/api/tickets/:ticketId/attachments',
    async (request, reply) => {
      const { ticketId } = ticketIdParam.parse(request.params);

      // Verify ticket exists
      const ticket = db.prepare('SELECT 1 FROM tickets WHERE id = ?').get(ticketId);
      if (!ticket) {
        return reply.status(404).send({ error: 'Ticket not found' });
      }

      return listAttachments(db, ticketId);
    },
  );

  // GET /api/attachments/:id/file — serve the actual file content
  app.get<{ Params: { id: string } }>('/api/attachments/:id/file', async (request, reply) => {
    const { id } = idParam.parse(request.params);

    const attachment = getAttachment(db, id);
    if (!attachment) {
      return reply.status(404).send({ error: 'Attachment not found' });
    }

    const filePath = join(ATTACHMENTS_DIR, attachment.ticket_id, attachment.stored_name);

    // Verify file exists on disk
    try {
      await stat(filePath);
    } catch {
      return reply.status(404).send({ error: 'Attachment file missing from disk' });
    }

    const stream = createReadStream(filePath);
    return reply
      .header('Content-Type', attachment.mime_type)
      .header('Content-Disposition', `inline; filename="${attachment.filename}"`)
      .header('Cache-Control', 'private, max-age=86400')
      .send(stream);
  });

  // DELETE /api/attachments/:id — delete an attachment
  app.delete<{ Params: { id: string } }>('/api/attachments/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);

    const attachment = getAttachment(db, id);
    if (!attachment) {
      return reply.status(404).send({ error: 'Attachment not found' });
    }

    // Remove from DB (file on disk is left as orphan — cheap, no risk,
    // retention cleanup can sweep later if needed)
    deleteAttachment(db, id);

    return { status: 'deleted' };
  });
}

/**
 * Map MIME type to a file extension. Falls back to empty string for unknowns.
 */
function extFromMime(mime: string): string {
  switch (mime) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/svg+xml':
      return '.svg';
    default:
      return '';
  }
}

/**
 * Strip path components and control characters from a user-supplied filename.
 * The stored_name (UUID-based) is what actually hits the filesystem — this
 * is purely for display.
 */
function sanitizeFilename(name: string): string {
  // Remove path separators and control chars
  const cleaned = name.replace(/[/\\<>:"|?*\x00-\x1f]/g, '_');
  // Limit length
  return cleaned.slice(0, 255) || 'unnamed';
}
