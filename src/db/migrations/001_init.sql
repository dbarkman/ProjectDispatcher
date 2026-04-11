-- MVP-02 initial schema.
-- Mirrors DESIGN.md §7.1 and §7.2 exactly. If you change this file after
-- it has ever been applied to a real database, DON'T — write a new
-- migration file instead. This one is append-frozen.
--
-- Table order is FK-resolution order: tables referenced by FKs come first.
-- SQLite tolerates forward refs in FK definitions, but keeping the order
-- clean makes the file easier to reason about.

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
  allowed_tools TEXT NOT NULL,      -- JSON array of tool names
  permission_mode TEXT NOT NULL,    -- 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
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
CREATE TABLE projects (
  id TEXT PRIMARY KEY,              -- UUID
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,        -- absolute filesystem path
  project_type_id TEXT NOT NULL REFERENCES project_types(id),
  status TEXT NOT NULL DEFAULT 'active',  -- active | dormant | missing | archived
  last_activity_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

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
  priority TEXT NOT NULL DEFAULT 'normal',  -- low | normal | high | urgent
  tags TEXT,                        -- JSON array
  claimed_by_run_id TEXT,           -- if non-null, an agent is working on it
  claimed_at INTEGER,
  created_by TEXT NOT NULL DEFAULT 'human',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Ticket comments: append-only threaded history. Never updated, never deleted.
CREATE TABLE ticket_comments (
  id TEXT PRIMARY KEY,              -- UUID
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  type TEXT NOT NULL,               -- comment|move|claim|complete|finding|journal|block|chat_summary
  author TEXT NOT NULL,             -- 'human' or 'agent:<agent_type>:<run_id>'
  body TEXT,
  meta TEXT,                        -- JSON, type-specific
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
  exit_status TEXT,                 -- running | success | timeout | crashed | blocked
  transcript_path TEXT,
  cost_estimate_cents INTEGER,
  error_message TEXT
);

-- Daemon-level key-value config.
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,              -- JSON
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
