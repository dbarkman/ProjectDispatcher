-- MVP-02 initial schema.
-- Mirrors DESIGN.md §7.1 and §7.2. If you change this file after it has
-- ever been applied to a real (non-:memory:) database, DON'T — write a new
-- migration file instead. This one is append-frozen.
--
-- Table order is FK-resolution order: tables referenced by FKs come first.
-- SQLite tolerates forward refs, but readable order beats relying on that.
--
-- CHECK constraints policy (decided in Code Review #1):
--   - CHECK is applied to enum-like columns whose value sets are STABLE and
--     closed: projects.status, tickets.priority, tickets.created_by,
--     agent_runs.exit_status, agent_types.permission_mode. DB-level
--     enforcement is defense-in-depth behind the Zod validation at the
--     boundary (see CLAUDE.md coding principles).
--   - CHECK is NOT applied to ticket_comments.type because the valid set
--     is expected to grow with new agent behaviors, and each growth would
--     otherwise force a schema migration purely for CHECK maintenance.
--     Validated at the Zod boundary instead. Current valid values per
--     DESIGN.md §7.1: comment, move, claim, complete, finding, journal,
--     block, chat_summary.
--   - json_valid() CHECKs are applied to every JSON-storing TEXT column
--     as a corruption guard. Cheap insurance against a bug writing a
--     non-JSON string via a db.exec() that bypasses Zod.

-- Project types: first-class, seeded on install, user-editable.
CREATE TABLE project_types (
  id TEXT PRIMARY KEY,              -- slug, e.g., 'software-dev'
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Agent types: define how agents behave. Referenced by project_type_columns
-- and agent_runs, so it needs to come before them.
CREATE TABLE agent_types (
  id TEXT PRIMARY KEY,              -- slug, e.g., 'coding-agent'
  name TEXT NOT NULL,
  description TEXT,
  system_prompt_path TEXT NOT NULL, -- relative to ~/Development/.tasks/prompts/
  model TEXT NOT NULL,
  allowed_tools TEXT NOT NULL CHECK (json_valid(allowed_tools)),  -- JSON array
  permission_mode TEXT NOT NULL
    CHECK (permission_mode IN ('default', 'acceptEdits', 'bypassPermissions', 'plan')),
  timeout_minutes INTEGER NOT NULL DEFAULT 30,
  max_retries INTEGER NOT NULL DEFAULT 0,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Columns belong to a project type and define its workflow.
CREATE TABLE project_type_columns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_type_id TEXT NOT NULL REFERENCES project_types(id) ON DELETE CASCADE,
  column_id TEXT NOT NULL,          -- e.g., 'human', 'coding-agent', 'done'
  name TEXT NOT NULL,
  agent_type_id TEXT REFERENCES agent_types(id),  -- null for Human and Done columns
  "order" INTEGER NOT NULL,
  UNIQUE (project_type_id, column_id)
);

-- Projects: folders under ~/Development/ (or any absolute path).
-- Path uniqueness is enforced by a *partial* unique index below rather than
-- a column-level UNIQUE constraint. Archived projects don't own their path,
-- so you can re-register the same folder after archiving without collision.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,              -- UUID
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  project_type_id TEXT NOT NULL REFERENCES project_types(id),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'dormant', 'missing', 'archived')),
  last_activity_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Unique-among-active path index. Archived rows are excluded, so the same
-- folder can be re-registered after archive without a UNIQUE violation.
CREATE UNIQUE INDEX idx_projects_path_active
  ON projects (path) WHERE status != 'archived';

-- Heartbeat state per project (split from projects for clarity).
CREATE TABLE project_heartbeats (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  next_check_at INTEGER NOT NULL,   -- unix ms
  consecutive_empty_checks INTEGER NOT NULL DEFAULT 0,
  last_wake_at INTEGER,
  last_work_found_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- Tickets: the unit of work.
CREATE TABLE tickets (
  id TEXT PRIMARY KEY,              -- UUID
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT,
  "column" TEXT NOT NULL,           -- matches a project_type_columns.column_id
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  tags TEXT CHECK (tags IS NULL OR json_valid(tags)),  -- JSON array
  claimed_by_run_id TEXT,
  claimed_at INTEGER,
  created_by TEXT NOT NULL DEFAULT 'human'
    CHECK (created_by IN ('human', 'agent')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Ticket comments: append-only threaded history. Never updated, never deleted.
CREATE TABLE ticket_comments (
  id TEXT PRIMARY KEY,              -- UUID
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  type TEXT NOT NULL,               -- see header for why this lacks a CHECK
  author TEXT NOT NULL,             -- 'human' or 'agent:<agent_type>:<run_id>'
  body TEXT,
  meta TEXT CHECK (meta IS NULL OR json_valid(meta)),  -- type-specific JSON
  created_at INTEGER NOT NULL
);

-- Agent runs: every invocation of an agent subprocess.
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,              -- UUID
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  agent_type_id TEXT NOT NULL REFERENCES agent_types(id),
  model TEXT NOT NULL,              -- snapshot at invocation time
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  exit_status TEXT
    CHECK (exit_status IS NULL OR exit_status IN ('running', 'success', 'timeout', 'crashed', 'blocked')),
  transcript_path TEXT,
  cost_estimate_cents INTEGER,
  error_message TEXT
);

-- Daemon-level key-value config.
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL CHECK (json_valid(value)),  -- JSON
  updated_at INTEGER NOT NULL
);

-- Indexes (DESIGN.md §7.2)
CREATE INDEX idx_tickets_project_column ON tickets (project_id, "column");
CREATE INDEX idx_tickets_column ON tickets ("column");
CREATE INDEX idx_tickets_updated ON tickets (updated_at DESC);
CREATE INDEX idx_ticket_comments_ticket ON ticket_comments (ticket_id, created_at);
CREATE INDEX idx_agent_runs_ticket ON agent_runs (ticket_id);
CREATE INDEX idx_projects_status ON projects (status);
CREATE INDEX idx_project_heartbeats_next_check ON project_heartbeats (next_check_at);
