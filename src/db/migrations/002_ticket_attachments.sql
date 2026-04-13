-- Ticket attachments: screenshots and files attached to tickets.
-- Files are stored on disk under ~/Development/.tasks/artifacts/attachments/.
-- This table stores the metadata; the binary content lives on the filesystem.

CREATE TABLE ticket_attachments (
  id TEXT PRIMARY KEY,                -- UUID
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,             -- original filename from upload
  stored_name TEXT NOT NULL,          -- on-disk filename (UUID-based, prevents collisions)
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_ticket_attachments_ticket ON ticket_attachments (ticket_id, created_at);
