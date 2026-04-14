-- Project-scoped templates.
--
-- project_types and agent_types become template *libraries*. When a user
-- creates a new project, the chosen project_type (and its columns, and any
-- agent_types it references that the user customizes) is cloned to a
-- project-scoped copy. Projects never share editable templates — editing
-- a project's workflow never affects another project.
--
-- Scoping rules:
--   is_builtin = 1                         → ship-with-the-app library template (immutable in UI)
--   is_builtin = 0, owner_project_id NULL  → user-created library template
--   is_builtin = 0, owner_project_id SET   → private to that project
--
-- Library templates remain discoverable on the registration picker.
-- Project-scoped rows are filtered out of the library view.
--
-- Backward compatibility: existing projects created before this migration
-- still point at a library project_type (is_builtin=1, owner_project_id NULL).
-- Those projects are treated as *legacy* by the workflow editor — read still
-- works (board, tickets), but editing the workflow is refused with a 409
-- until the project is re-registered. This avoids the footgun of letting
-- one project's column edits bleed into every other project using the
-- same library template. No data-migration backfill is done, and none is
-- needed: re-registering a legacy folder clones the template cleanly.

ALTER TABLE project_types ADD COLUMN owner_project_id TEXT
  REFERENCES projects(id) ON DELETE CASCADE;

ALTER TABLE agent_types ADD COLUMN owner_project_id TEXT
  REFERENCES projects(id) ON DELETE CASCADE;

-- Partial indexes so the library list (the common case) is cheap.
CREATE INDEX idx_project_types_library ON project_types (name)
  WHERE owner_project_id IS NULL;

CREATE INDEX idx_agent_types_library ON agent_types (name)
  WHERE owner_project_id IS NULL;

-- Lookup by project scope for the workflow editor.
CREATE INDEX idx_project_types_owner ON project_types (owner_project_id)
  WHERE owner_project_id IS NOT NULL;

CREATE INDEX idx_agent_types_owner ON agent_types (owner_project_id)
  WHERE owner_project_id IS NOT NULL;
