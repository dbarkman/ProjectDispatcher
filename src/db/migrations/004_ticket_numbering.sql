-- Human-readable ticket numbers.
--
-- Today every ticket is identified in the UI by an 8-char UUID prefix
-- (e.g. "a33f3d74"). Hard to read, hard to say out loud. Switch to
-- `<project-abbrev>-<sequence>` (e.g. "pd-1", "hmh-42") for display
-- while keeping the UUID as the primary key for FK integrity.
--
-- Two new columns:
--   projects.abbreviation         — short identifier (lowercase, [a-z0-9]).
--                                    Required. Unique across active projects
--                                    (archived rows excluded — same pattern
--                                    as projects.path).
--   tickets.sequence_number       — monotonically increasing per project.
--                                    Allocated at INSERT via MAX+1 inside
--                                    the create transaction.
--
-- Backfill rules:
--   - abbreviation: derived from project name. Lowercase initials of
--     CamelCase / word boundaries. Uniqueness collisions get a digit
--     suffix (pd, pd2, pd3...). Done in TypeScript-land via a small
--     post-migration backfill since SQLite can't do regex-driven
--     CamelCase splits cleanly. See src/db/migrate.ts for the hook.
--   - sequence_number: assigned by created_at order, partitioned per
--     project. Done with a window function below.

ALTER TABLE projects ADD COLUMN abbreviation TEXT;
ALTER TABLE tickets ADD COLUMN sequence_number INTEGER;

-- Sequence backfill: rank every ticket by created_at within its project
-- and assign that rank as sequence_number. SQLite has had window functions
-- since 3.25 (2018); we already require >=3.38 for partial indexes.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at ASC, id ASC) AS seq
  FROM tickets
)
UPDATE tickets
SET sequence_number = (SELECT seq FROM ranked WHERE ranked.id = tickets.id);

-- Abbreviation backfill is handled in TypeScript (deriveAbbreviation
-- helper) immediately after this migration runs. The column is left
-- nullable here so the migration succeeds even when no projects exist;
-- the post-migration backfill + the API-level abbreviation requirement
-- enforce the invariant.

-- Uniqueness:
--   - sequence_number unique within a project (allocator and human ID rely on this)
--   - abbreviation unique among non-archived projects (archived rows can
--     share — same partial-index pattern as projects.path)
CREATE UNIQUE INDEX idx_tickets_project_seq ON tickets (project_id, sequence_number);
CREATE UNIQUE INDEX idx_projects_abbreviation_active
  ON projects (abbreviation) WHERE status != 'archived';
