-- Re-registering an archived project's path failed with a UNIQUE
-- constraint violation on projects.path, because archiving only flipped
-- status='archived' but left the path intact.
--
-- The cleanest fix would be a partial unique index (only enforce UNIQUE
-- among active rows), but SQLite requires a full table rebuild to remove
-- the column-level UNIQUE constraint. That's a lot of blast radius for
-- this bug, so we take the lower-risk approach: mangle the path on archive
-- so the UNIQUE constraint is satisfied without blocking re-registration.
--
-- One-off data fix for already-archived rows. New archives get the same
-- treatment via archiveProject() (see src/db/queries/projects.ts).
-- The id (UUID) is appended to guarantee the suffix is unique even if
-- two projects with identical paths were somehow archived.

UPDATE projects
SET path = path || '::archived::' || id
WHERE status = 'archived'
  AND path NOT LIKE '%::archived::%';
