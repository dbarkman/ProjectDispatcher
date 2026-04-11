# Project Dispatcher — Development Roadmap

**Purpose:** Breakdown of work into self-contained tasks that an agent (or human) can pick up cold. Each task has a size estimate, dependencies, a description with enough context to start, and acceptance criteria.

**Companion docs:**
- [`DESIGN.md`](./DESIGN.md) — the authoritative design specification (read this first)
- [`README.md`](./README.md) — one-page intro
- [`CLAUDE.md`](./CLAUDE.md) — project handoff for agents

**Task ID convention:** `MVP-NN` for MVP tasks, `V1-NN` for V1 post-MVP, `V2-NN` for V2 extensions. IDs are stable; do not renumber.

**Size estimates:**
- **XS** — 30 min to 1 hour
- **S** — 1 to 3 hours
- **M** — 3 to 6 hours
- **L** — 6 to 12 hours
- **XL** — 12+ hours (consider breaking down further)

**Status field in an MVP ticket system:** once Project Dispatcher is self-hosting, each of these tasks becomes a real ticket in the Project Dispatcher project's board. Until then, they live here.

---

## Table of contents

- [MVP — Phase 1: Foundation](#mvp--phase-1-foundation)
- [MVP — Phase 2: HTTP API + Daemon](#mvp--phase-2-http-api--daemon)
- [MVP — Phase 3: Filesystem Integration](#mvp--phase-3-filesystem-integration)
- [MVP — Phase 4: Agent Runtime](#mvp--phase-4-agent-runtime)
- [MVP — Phase 5: Scheduler](#mvp--phase-5-scheduler)
- [MVP — Phase 6: Web UI](#mvp--phase-6-web-ui)
- [MVP — Phase 7: CLI](#mvp--phase-7-cli)
- [MVP — Phase 8: Installation and Platform](#mvp--phase-8-installation-and-platform)
- [MVP — Phase 9: Testing and Hardening](#mvp--phase-9-testing-and-hardening)
- [V1 — Post-MVP improvements](#v1--post-mvp-improvements)
- [V2 — Future extensions](#v2--future-extensions)

---

## MVP — Phase 1: Foundation

Work that sets up the project skeleton. Everything after this phase depends on these tasks being done.

### MVP-01 — Project bootstrap

**Size:** S
**Depends on:** none
**Files:** `package.json`, `tsconfig.json`, `.eslintrc.json`, `.prettierrc`, `vitest.config.ts`, `.gitignore`

**Description:**
Initialize the Node.js project. Create `package.json` with the name `projectdispatcher`, binary `dispatch`, main `dist/index.js`, type `module`. Add scripts: `dev`, `build`, `start`, `test`, `lint`, `typecheck`, `format`.

Install dev dependencies:
- `typescript` (5.x)
- `@types/node`
- `tsx` (for dev-mode hot reload)
- `vitest`
- `eslint`, `@typescript-eslint/*`
- `prettier`

Install runtime dependencies:
- `fastify` (5.x)
- `@fastify/static`
- `better-sqlite3`
- `zod`
- `pino`
- `pino-pretty` (dev only)
- `chokidar`
- `commander` (for the CLI)

Create `tsconfig.json` with strict mode, target ES2022, module NodeNext, outDir `dist/`, rootDir `src/`.

Create `.eslintrc.json` extending `@typescript-eslint/recommended` plus `prettier` for formatting.

Create `.gitignore` ignoring `node_modules/`, `dist/`, `*.db`, `*.log`, `.tasks/` (in case the project ever runs its own install inside the source tree for testing).

Create a minimal `src/index.ts` that exports an empty function — just enough for `npm run build` to succeed.

**Acceptance criteria:**
- `npm install` completes without errors
- `npm run build` produces `dist/index.js`
- `npm run typecheck` passes
- `npm run lint` passes
- `npm test` runs (zero tests is fine)

---

### MVP-02 — Database schema and migrations

**Size:** M
**Depends on:** MVP-01
**Files:** `src/db/index.ts`, `src/db/migrations/001_init.sql`, `src/db/migrate.ts`

**Description:**
Implement the full SQLite schema from DESIGN.md section 7. Use `better-sqlite3` (sync API).

Create `src/db/index.ts`:
- Exports `openDatabase(path?)` factory — callers own the handle lifetime. The daemon (MVP-06) will call it exactly once at startup and pass the handle around; tests can open isolated `:memory:` handles. This replaces the original "singleton database handle" spec (rationale in the src file header — see Code Review #1 decision #5).
- Default path is `~/Development/.tasks/tasks.db`, resolved via `os.homedir()` (never hardcoded).
- Enables WAL mode (`PRAGMA journal_mode=WAL`).
- Enables foreign keys (`PRAGMA foreign_keys=ON`) AND verifies the pragma stuck — throws and closes the handle if the effective value isn't `1`. Defense in depth against SQLite builds where the pragma can silently no-op.
- Applies `PRAGMA auto_vacuum=INCREMENTAL`.

Create `src/db/migrations/001_init.sql` with all eight tables from DESIGN.md section 7.1:
- `project_types`
- `project_type_columns`
- `agent_types`
- `projects`
- `project_heartbeats`
- `tickets`
- `ticket_comments`
- `agent_runs`
- `config`

Add all indexes from DESIGN.md section 7.2.

Create `src/db/migrate.ts`:
- Reads all `.sql` files in `src/db/migrations/` in lexicographic order
- Applies them in a transaction
- Tracks applied migrations in a `schema_migrations` table (create this too)
- Idempotent — running it twice is safe

**Acceptance criteria:**
- Running the migrate script creates the database file with all tables
- Running it a second time is a no-op
- All indexes exist
- Foreign keys work (test by trying to insert a ticket with an invalid project_id — should fail)

---

### MVP-03 — Database seed data

**Size:** M
**Depends on:** MVP-02
**Files:** `src/db/seed.ts`, `src/prompts/defaults/*.md` (9 files)

**Description:**
Seed the built-in `project_types` and `agent_types` from DESIGN.md sections 8 and 9.

Create `src/prompts/defaults/` with 9 markdown files, one per built-in agent type:
- `coding-agent.md`
- `code-reviewer.md`
- `security-reviewer.md`
- `sysadmin.md`
- `security-auditor.md`
- `writer.md`
- `editor.md`
- `deployer.md`
- `researcher.md`

Each file is the system prompt (flesh out the "abbreviated" versions from DESIGN.md section 9 into ~30-50 line prompts). These are the shipped defaults — after install, they are copied to `~/Development/.tasks/prompts/` where the user can edit them.

Create `src/db/seed.ts`:
- Exports a function `seedBuiltins(db)` that checks if any built-in agent/project types exist
- If not, inserts them with `is_builtin = 1`
- Inserts project type columns in the right order
- Skips types that already exist (idempotent)
- Does NOT overwrite user edits — if a built-in type was edited, leave it alone

Built-in project types to seed (from DESIGN.md section 8):
- `software-dev` — columns: human, coding-agent, code-reviewer, security-reviewer, done
- `vps-maintenance` — columns: human, sysadmin, security-auditor, done
- `content` — columns: human, writer, editor, done
- `research` — columns: human, researcher, done
- `personal` — columns: human, in-progress, done (no agents)

Built-in agent types to seed with the defaults from DESIGN.md section 9 (model, allowed_tools, permission_mode, timeout_minutes for each).

**Acceptance criteria:**
- After running the seed, the database has 5 project types and 9 agent types
- All 9 prompt files exist
- Running seed twice doesn't duplicate anything
- Each project type has the correct columns in the correct order

---

### MVP-04 — Configuration loader

**Size:** S
**Depends on:** MVP-02
**Files:** `src/config.ts`, `src/config.schema.ts`

**Description:**
Implement config loading from `~/Development/.tasks/config.json` with Zod validation and env var overrides.

Create `src/config.schema.ts`:
```typescript
import { z } from 'zod';

export const configSchema = z.object({
  heartbeat: z.object({
    base_interval_seconds: z.number().int().positive().default(300),
    max_interval_seconds: z.number().int().positive().default(86400),
    backoff_multiplier: z.number().positive().default(2),
  }),
  agents: z.object({
    max_concurrent_per_project: z.number().int().positive().default(3),
    max_concurrent_global: z.number().int().positive().default(10),
    default_timeout_minutes: z.number().int().positive().default(30),
  }),
  ui: z.object({
    port: z.number().int().min(1024).max(65535).default(5757),
    auto_open_on_install: z.boolean().default(true),
    theme: z.enum(['dark', 'light']).default('dark'),
  }),
  retention: z.object({
    transcript_days: z.number().int().positive().default(30),
    log_days: z.number().int().positive().default(7),
    backup_count: z.number().int().positive().default(14),
  }),
  discovery: z.object({
    root_path: z.string().default('~/Development'),
    ignore: z.array(z.string()).default(['.tasks', 'Archive', 'tmp']),
  }),
  claude_cli: z.object({
    binary_path: z.string().default('claude'),
    default_model: z.string().default('claude-sonnet-4-6'),
  }),
});

export type Config = z.infer<typeof configSchema>;
```

Create `src/config.ts`:
- Reads `~/Development/.tasks/config.json` (if exists)
- Overlays environment variables prefixed `DISPATCH_` (e.g., `DISPATCH_UI_PORT=5858`)
- Validates with Zod
- Exits with a clear error message on invalid config
- Exports `getConfig()` as a function returning the parsed config
- Supports `reloadConfig()` for hot reload

Use `~` expansion for the root path.

**Acceptance criteria:**
- Missing config file → defaults are used
- Invalid config file → daemon refuses to start with a clear error
- `DISPATCH_UI_PORT=5858` overrides the port
- `reloadConfig()` picks up file changes

---

### MVP-05 — Logging

**Size:** XS
**Depends on:** MVP-01
**Files:** `src/logger.ts`

**Description:**
Set up structured JSON logging with Pino.

Create `src/logger.ts`:
- In production: writes JSON to `~/Development/.tasks/logs/daemon.log` with daily rotation
- In development (NODE_ENV=development): writes pretty-printed logs to stdout via `pino-pretty`
- Exports a `logger` instance and a `child(bindings)` helper for contextual logs

Log rotation can be handled by Pino's `pino.destination()` with `sync: false` — for MVP, use a simple daily file with `daemon-YYYY-MM-DD.log` naming; old files cleaned up by the retention job (MVP-34).

**Acceptance criteria:**
- `logger.info({ project: 'HMH' }, 'test')` writes a JSON line to the log file
- In dev mode, the same call prints a colorized line to stdout

---

## MVP — Phase 2: HTTP API + Daemon

The Fastify server and REST-ish endpoints the UI and CLI use.

### MVP-06 — Fastify server skeleton

**Size:** S
**Depends on:** MVP-01, MVP-04, MVP-05
**Files:** `src/daemon/http.ts`, `src/daemon/index.ts`

**Description:**
Set up the Fastify HTTP server. Bind to `127.0.0.1` on the configured port. Register a global error handler that returns JSON errors. Register CORS (allow localhost only).

Create `src/daemon/http.ts`:
- Exports `createHttpServer(config, db, logger)` returning a Fastify instance
- Registers the `@fastify/cors` plugin
- Registers a `GET /api/health` route returning `{ status: 'ok', uptime_seconds: ..., database: 'connected', ... }`
- Registers a global error handler that logs the error and returns `{ error: string }` with appropriate status codes
- Logs all requests via Pino

Create `src/daemon/index.ts` as the main daemon entry:
- Loads config
- Initializes the logger
- Opens the database
- Applies migrations
- Creates the HTTP server
- Starts listening
- Handles SIGTERM/SIGINT gracefully (close db, close server, exit 0)

**Acceptance criteria:**
- `npm run dev` starts the daemon
- `curl http://127.0.0.1:5757/api/health` returns `{ status: 'ok' }`
- Pressing Ctrl+C shuts down cleanly
- Binding to a non-localhost address fails (it shouldn't even try)

---

### MVP-07 — Projects API

**Size:** M
**Depends on:** MVP-06
**Files:** `src/daemon/routes/projects.ts`, `src/db/queries/projects.ts`

**Description:**
Implement CRUD for projects. Use Zod validation on every input.

Endpoints:
- `GET /api/projects` — list all projects (sortable, filterable by status)
- `GET /api/projects/:id` — project detail including heartbeat state
- `POST /api/projects` — register a project (body: `{ name, path, project_type_id }`) — does NOT require the folder to exist yet (auto-discovery handles that)
- `PATCH /api/projects/:id` — update `name`, `project_type_id`, `status`
- `DELETE /api/projects/:id` — archive (sets `status = archived`, does NOT delete)
- `POST /api/projects/:id/wake` — manually reset the heartbeat to 5 min

Create `src/db/queries/projects.ts` with typed functions:
- `createProject(data): Project`
- `getProject(id): Project | null`
- `listProjects(filter?): Project[]`
- `updateProject(id, patch): Project`
- `archiveProject(id): void`

Zod schemas go inline in the route file or in a shared `src/daemon/schemas.ts`.

The `POST /api/projects/:id/wake` endpoint calls into the scheduler (MVP-22) — for now, it can update `project_heartbeats.next_check_at` directly. The scheduler will pick it up.

**Acceptance criteria:**
- Can create a project with `curl -X POST http://127.0.0.1:5757/api/projects -d '{...}'`
- Can list, show, update, archive via corresponding endpoints
- Invalid inputs return 400 with Zod error details
- Archived projects don't appear in list by default (filter with `?status=archived` to see them)

---

### MVP-08 — Project types API

**Size:** M
**Depends on:** MVP-07
**Files:** `src/daemon/routes/project-types.ts`, `src/db/queries/project-types.ts`

**Description:**
CRUD for project types, including the columns that belong to each.

Endpoints:
- `GET /api/project-types` — list all types
- `GET /api/project-types/:id` — detail including columns (ordered)
- `POST /api/project-types` — create a custom type with columns
- `PATCH /api/project-types/:id` — update name, description, columns
- `DELETE /api/project-types/:id` — delete (only if no projects use it, and only if not built-in)

When updating columns, the diff logic must handle:
- Adding a new column (insert)
- Removing a column (only if no tickets are currently in it)
- Renaming a column (update)
- Reordering columns (update `order`)

Validate that every project type has at least `human` and `done` columns.

**Acceptance criteria:**
- All CRUD operations work
- Built-in types cannot be deleted (`is_builtin = 1` → 409 Conflict)
- Cannot delete a type in use by a project
- Cannot remove a column that has tickets

---

### MVP-09 — Agent types API

**Size:** M
**Depends on:** MVP-07
**Files:** `src/daemon/routes/agent-types.ts`, `src/db/queries/agent-types.ts`

**Description:**
CRUD for agent types. The system prompt lives in a markdown file — the API reads/writes that file via a helper.

Endpoints:
- `GET /api/agent-types` — list all types
- `GET /api/agent-types/:id` — detail including the prompt text
- `POST /api/agent-types` — create custom type
- `PATCH /api/agent-types/:id` — update any field, including prompt text (which writes to the `.md` file)
- `DELETE /api/agent-types/:id` — delete (blocked if built-in or in use by a project type's columns)

Prompt file handling:
- When a new agent type is created, write `<id>.md` to `~/Development/.tasks/prompts/`
- When prompt text is updated via PATCH, write to the same file
- When reading an agent type, read the prompt text from the file
- File operations go through a helper at `src/services/prompt-file.ts` for safety (path sanitization to prevent `../` escapes)

**Acceptance criteria:**
- Prompt edits in the API immediately affect the file on disk
- Editing the file on disk is picked up on next read (no stale cache)
- Filename sanitization prevents writing outside `~/Development/.tasks/prompts/`

---

### MVP-10 — Tickets API

**Size:** L
**Depends on:** MVP-07
**Files:** `src/daemon/routes/tickets.ts`, `src/db/queries/tickets.ts`, `src/db/queries/comments.ts`

**Description:**
The biggest API surface. Tickets and their comments/history.

Endpoints:
- `GET /api/tickets` — flat list across all projects, filterable by `?project=X&column=Y&priority=Z&tag=T`
- `GET /api/tickets?column=human` — the inbox query (most important)
- `GET /api/tickets/:id` — full ticket detail including the complete thread
- `POST /api/tickets` — create a new ticket
- `PATCH /api/tickets/:id` — update title, body, priority, tags (NOT column — use `/move`)
- `DELETE /api/tickets/:id` — hard delete (only in dev mode; production should archive)
- `POST /api/tickets/:id/comments` — add a comment (body: `{ type, body, meta? }`)
- `POST /api/tickets/:id/move` — move to another column (body: `{ to_column, comment? }`)

The `/move` endpoint is special:
- Validates that the target column exists for the ticket's project type
- Inserts a `move` comment with from/to in the meta
- If the target column is an agent column, resets the project's heartbeat to 5 min via the scheduler
- Atomic: all in one transaction

The `add_comment` route supports all comment types from DESIGN.md section 4.5 (`comment`, `move`, `claim`, `complete`, `finding`, `journal`, `block`, `chat_summary`). Authorization: for V1, accept any author string; agents authenticate implicitly by virtue of being local subprocesses with MCP tools.

**Acceptance criteria:**
- Can create, list, show, update, delete tickets
- Comments append-only (no DELETE endpoint)
- Moving a ticket to an agent column triggers a heartbeat reset (verify via db read after)
- Thread includes all comment types in chronological order

---

### MVP-11 — Config API

**Size:** XS
**Depends on:** MVP-06, MVP-04
**Files:** `src/daemon/routes/config.ts`

**Description:**
Simple endpoints to read and write the daemon config.

Endpoints:
- `GET /api/config` — returns the current config (merged defaults + file + env)
- `PATCH /api/config` — updates the config file, validates with Zod, triggers hot reload
- `POST /api/config/reload` — forces a reload from disk

Sensitive values (none in V1, but plan for future) should be masked in GET responses.

**Acceptance criteria:**
- PATCHing a valid config updates the file and takes effect
- PATCHing invalid config returns 400 without modifying the file

---

## MVP — Phase 3: Filesystem Integration

Auto-discovery and the watcher that make projects appear in the UI without manual registration.

### MVP-12 — Project auto-discovery

**Size:** M
**Depends on:** MVP-07
**Files:** `src/daemon/discovery.ts`

**Description:**
On daemon startup, scan `config.discovery.root_path` for subdirectories and reconcile with the database.

Logic:
1. Read the root path
2. List all immediate subdirectories (not recursive)
3. For each:
   - Skip if name starts with `.` or matches `config.discovery.ignore`
   - Check if a project with that path already exists in the db
   - If yes, verify the folder still exists (it does, we just listed it) and update `status = active` if it was `missing`
   - If no, create a new project with `status = 'unregistered'`, default name from folder basename, no project_type_id yet (user picks in UI)
4. For projects in the db whose path no longer exists on disk, mark `status = missing` (don't delete — tickets are preserved)

Export `discoverProjects(db, config)` as a function. Called on daemon startup and by the watcher (MVP-13) when folders appear/disappear.

A project in `unregistered` status shows up in the UI with a prompt to pick a type. Until a type is chosen, no columns exist and no agents can run.

**Acceptance criteria:**
- Starting the daemon with 5 folders under `~/Development/` creates 5 project rows
- Deleting a folder and restarting marks the project `missing`
- Creating a new folder and restarting adds a new `unregistered` project
- Re-running discovery doesn't duplicate existing projects

---

### MVP-13 — Filesystem watcher

**Size:** S
**Depends on:** MVP-12
**Files:** `src/daemon/watcher.ts`

**Description:**
Use `chokidar` to watch the discovery root for new/deleted subdirectories, so auto-discovery is live (no restart required).

Configure chokidar:
- Watch `config.discovery.root_path`
- Depth: 1 (only immediate subdirectories)
- Ignore: dotfiles, files (we only care about directories), the ignore list
- Events: `addDir`, `unlinkDir`

On `addDir`: call `discoverProjects` (idempotent — safe to run repeatedly)
On `unlinkDir`: mark the matching project as `missing`

Debounce events at 1 second to batch rapid changes.

**Acceptance criteria:**
- Creating a new folder under `~/Development/` causes it to appear in the UI within a few seconds
- Deleting a folder marks the project as missing
- Renaming isn't detected perfectly (becomes delete + add) — this is acceptable for V1, documented as a known limitation

---

### MVP-14 — Prompt file service

**Size:** S
**Depends on:** MVP-09
**Files:** `src/services/prompt-file.ts`

**Description:**
Safe read/write of agent prompt markdown files in `~/Development/.tasks/prompts/`. Used by the agent types API and the prompt builder.

Exports:
- `readPromptFile(agentTypeId): string` — reads the file, throws if missing
- `writePromptFile(agentTypeId, content): void` — writes atomically (write to temp + rename)
- `promptFilePath(agentTypeId): string` — resolves the full path
- `ensurePromptFileExists(agentTypeId, defaultContent): void` — used during seeding

Sanitize `agentTypeId` to prevent path traversal: reject anything with `/`, `\`, `..`, or null bytes. Allow only `[a-z0-9-_]`.

Ensure the prompts directory exists (create it if missing).

**Acceptance criteria:**
- Reading and writing work
- Attempts to write `../../../etc/passwd` are rejected
- Atomic writes (temp file + rename) prevent corruption on crash
- Directory is created automatically

---

## MVP — Phase 4: Agent Runtime

The core that makes the whole system work — running Claude as ephemeral subprocesses.

### MVP-15 — MCP server skeleton

**Size:** M
**Depends on:** MVP-06
**Files:** `src/daemon/mcp.ts`

**Description:**
Implement an MCP server using `@modelcontextprotocol/sdk`. Mount it on the Fastify instance at `/mcp` (or run it on a separate Unix socket — DESIGN.md is flexible here, pick whichever the SDK supports cleanly).

Skeleton setup:
- Create an MCP server instance
- Register it with Fastify (or as a standalone Unix socket server if simpler)
- Expose a minimal "list tools" endpoint that returns the tools defined in MVP-16
- Every MCP request should be logged

For V1, simplicity wins. If the MCP SDK expects stdio transport, implement it as a separate process mode: the daemon starts an MCP server child process per agent run. If it supports HTTP/SSE transport, run it inside the daemon.

Research the current state of the `@modelcontextprotocol/sdk` package and choose the approach that requires the least custom plumbing.

**Acceptance criteria:**
- An agent invoked with the MCP config can list available tools
- Every tool call is logged
- Malformed requests return clear errors

---

### MVP-16 — MCP tools

**Size:** L
**Depends on:** MVP-15, MVP-10
**Files:** `src/daemon/mcp-tools.ts`

**Description:**
Implement the ticket-manipulation tools that agents use. Each tool:
- Validates its input with Zod
- Performs the database operation
- Returns a structured response
- Logs the call
- Enforces scope: an agent can only touch tickets in the project it was invoked for

Required context: when the daemon spawns an agent, it passes the `project_id`, `ticket_id`, and `run_id` to the MCP server session. The MCP tools use these to validate every call.

Tools:

- **`read_my_ticket()`** — returns the ticket the agent was assigned (full object + thread). The agent doesn't need to pass the ID; the session knows.

- **`read_ticket(ticket_id)`** — read any ticket in the same project (for cross-reference). Fails if the ticket is in a different project.

- **`claim_ticket()`** — atomically marks the agent's assigned ticket as claimed by this run. Sets `claimed_by_run_id` and `claimed_at`. Fails if already claimed by a different run. Normally called first thing by the agent.

- **`add_comment(type, body, meta?)`** — appends a comment to the agent's assigned ticket. `type` must be one of the valid types from DESIGN.md section 4.5. Author is auto-set to `agent:<agent_type>:<run_id>`.

- **`attach_finding(severity, title, body, file_refs?)`** — shorthand for `add_comment({ type: 'finding', ... })` with validated severity (`critical`, `high`, `medium`, `low`).

- **`move_to_column(column_id, comment?)`** — validates the column exists for the project, inserts a `move` comment, updates the ticket's column, releases the claim, and notifies the scheduler. If `comment` is provided, appends it as a `complete` comment first.

- **`release_ticket()`** — unclaims without moving. Used if the agent decides it can't proceed but doesn't want to block.

- **`list_project_files(pattern?)`** — (optional, low priority) returns a list of files in the project directory matching a glob pattern. Redundant with the `Glob` tool from Claude Code, so maybe skip for V1.

Every tool logs `{ run_id, tool, args, result, duration_ms }`.

**Acceptance criteria:**
- Agent can call each tool and get expected results
- Calling `read_ticket` with an ID from a different project fails
- `claim_ticket` is atomic (run a race condition test)
- `move_to_column` correctly triggers heartbeat reset (verify via db)

---

### MVP-17 — Prompt builder

**Size:** M
**Depends on:** MVP-09, MVP-14
**Files:** `src/services/prompt-builder.ts`

**Description:**
Assembles the full system prompt passed to `claude -p` for each agent run.

Exports `buildPrompt({ agentType, project, ticket, runId })` returning a string.

Structure (from DESIGN.md section 11.2):
1. **Role prefix:** `"You are a ${agentType.name} working on project ${project.name}."`
2. **Agent type prompt body** (read from `~/Development/.tasks/prompts/${agentType.id}.md`)
3. **Project context:** `"Your CWD is ${project.path}. Read CLAUDE.md first if it exists."`
4. **Ticket context:** `"You have been assigned a ticket. Call read_my_ticket via the MCP tools to see it. Run ID: ${runId}. Current column: ${ticket.column}."`
5. **Output instructions:** `"When done, call move_to_column with the next column slug and a comment. Blocks go to the 'human' column with a question. Make judgment calls on ambiguity and document them in journal comments. Only block on irreversible decisions."`

Insert project-type-specific guidance if relevant (e.g., for `software-dev`, mention that the next column is usually `code-reviewer`).

Return the full prompt as a single string.

**Acceptance criteria:**
- Given an agent type, project, and ticket, returns a well-formed prompt string
- Missing CLAUDE.md is handled gracefully (agent is told to check but not required)
- Prompt is deterministic for the same inputs

---

### MVP-18 — Agent runner

**Size:** XL
**Depends on:** MVP-15, MVP-16, MVP-17
**Files:** `src/daemon/agent-runner.ts`

**Description:**
The component that actually spawns `claude -p` subprocesses. This is the heart of the system.

Exports `runAgent({ projectId, agentTypeId, ticketId }): Promise<AgentRunResult>`.

Logic:
1. Load project, agent type, ticket
2. Create a new `agent_runs` row with `exit_status = 'running'` and `started_at = now`
3. Build the prompt via MVP-17
4. Write MCP config to a temporary file that includes:
   - The MCP server endpoint
   - A session token binding `run_id` to `ticket_id` and `project_id` (used by MCP tools to enforce scope)
5. Construct the `claude -p` command line:
   ```
   claude -p "${prompt}"
     --cwd "${project.path}"
     --model "${agentType.model}"
     --allowed-tools "${agentType.allowed_tools.join(',')}"
     --permission-mode "${agentType.permission_mode}"
     --mcp-config "${mcpConfigPath}"
     --output-format "stream-json"
   ```
6. Open a write stream to the transcript file at `~/Development/.tasks/artifacts/runs/${runId}.log`
7. Spawn the subprocess with `child_process.spawn`, set CWD, pipe stdout and stderr to the transcript
8. Start a timeout timer based on `agentType.timeout_minutes`
9. Wait for the subprocess to exit (or timeout)
10. Update the `agent_runs` row with `exit_status`, `ended_at`, `error_message` if any
11. If the process crashed or timed out, release the ticket claim and add a `block` comment automatically
12. Return the result

Concurrency:
- Track active runs in an in-memory map keyed by `project_id`
- Reject the run if at max concurrent (per-project or global)
- The scheduler handles queueing; the runner just enforces the caps

**Acceptance criteria:**
- Spawning a real `claude -p` process with a simple test ticket works end-to-end
- The subprocess's stdout goes to the transcript file
- Timeouts are enforced (test with a sleep)
- Crashes (non-zero exit) result in a block comment
- Concurrency limits are enforced

---

### MVP-19 — Transcript viewer helper

**Size:** S
**Depends on:** MVP-18
**Files:** `src/services/transcript.ts`

**Description:**
Parse and format agent run transcripts for display in the UI.

Exports:
- `readTranscript(runId): string` — raw read
- `parseTranscript(raw): TranscriptEntry[]` — parses stream-json into structured entries (user message, assistant message, tool call, tool result, error)
- `formatTranscript(entries): string` — renders as a human-readable string for display

This is used by the agent runs detail view (MVP-27) and for debugging.

**Acceptance criteria:**
- Can read a real transcript and parse it into entries
- Format output is readable in a terminal or web view

---

## MVP — Phase 5: Scheduler

The heartbeat engine.

### MVP-20 — Heartbeat scheduler core

**Size:** L
**Depends on:** MVP-02, MVP-18
**Files:** `src/daemon/scheduler.ts`

**Description:**
Implement the in-process scheduler that fires heartbeats per project.

Exports a `Scheduler` class with methods:
- `start()` — initializes timers for all active projects based on their `next_check_at`
- `stop()` — clears all timers
- `resetProject(projectId)` — resets the project's heartbeat to 5 min (called when human assigns a ticket or agent finds work)
- `onTicketMoved(ticketId, fromColumn, toColumn)` — if the target column is an agent column, calls `resetProject`
- `onAgentRunFinished(runId)` — re-evaluates the project's heartbeat state
- `getProjectState(projectId): HeartbeatState` — for UI display

Internal:
- `timers: Map<projectId, NodeJS.Timeout>`
- `handleHeartbeat(projectId)` — the heartbeat tick handler (see MVP-21)
- `scheduleNext(projectId)` — reads `next_check_at` from db, sets the timer

On startup:
- Load all active projects
- For each, read heartbeat state from `project_heartbeats`
- If `next_check_at` is in the past, schedule immediately; otherwise schedule at that time
- If no heartbeat row exists, create one with immediate check

**Acceptance criteria:**
- Scheduler starts and schedules timers for all active projects
- `resetProject` clears and reschedules a timer
- Stopping the scheduler clears all timers
- `getProjectState` returns accurate data

---

### MVP-21 — Heartbeat tick handler

**Size:** M
**Depends on:** MVP-20, MVP-18
**Files:** `src/daemon/scheduler.ts` (extend)

**Description:**
The `handleHeartbeat` method that fires when a project's timer ticks.

Logic (from DESIGN.md section 10.3 pseudocode):
1. Load the project and its heartbeat state
2. Get all agent columns for the project type
3. For each agent column, query unclaimed tickets in that column
4. If any tickets found:
   - Mark `found_work = true`
   - For each ticket (up to the concurrency cap), call `agentRunner.runAgent`
   - Update heartbeat: `next_check_at = now + 5 min`, `consecutive_empty_checks = 0`, `last_work_found_at = now`
   - Reset the cascade (all other columns in the project also at 5-min — handled automatically since the whole project heartbeats together)
5. If no tickets found:
   - Increment `consecutive_empty_checks`
   - New interval = `min(base * multiplier^count, max)`
   - `next_check_at = now + new_interval`
6. Reschedule the project's timer

Concurrency note: if multiple tickets are in the same column, they can be processed in parallel up to the cap. Ones over the cap stay in the column and will be picked up on the next heartbeat.

Edge case: if the agent runner is at the global cap, this project's runs are queued — the heartbeat itself still fires and updates state, but runs are deferred. This is unusual and can be handled lazily for V1 (just skip the excess tickets; they'll be found next cycle).

**Acceptance criteria:**
- Heartbeat fires, finds work, spawns an agent, resets heartbeat
- Heartbeat fires, finds nothing, backs off correctly
- Can trigger a manual wake via API and see the heartbeat cycle start immediately
- Backoff caps at 24 hours

---

### MVP-22 — Crash recovery on daemon restart

**Size:** S
**Depends on:** MVP-20, MVP-18
**Files:** `src/daemon/recovery.ts`

**Description:**
When the daemon starts, there may be stale state from a previous crash. Clean it up.

Logic:
1. Find all `agent_runs` with `exit_status = 'running'` — these were orphaned by the crash
2. For each:
   - Set `exit_status = 'crashed'`, `ended_at = now`, `error_message = 'Daemon crashed or was killed during this run'`
   - Find the ticket, clear `claimed_by_run_id` and `claimed_at`
   - Add a `block` comment: "Agent run was interrupted. Please review."
3. Delete stale PID file if present

Run this before the scheduler starts.

**Acceptance criteria:**
- After a simulated crash (kill -9 during a run), restarting cleans up state
- The orphaned ticket is unclaimed and has a block comment
- The agent run is marked crashed

---

## MVP — Phase 6: Web UI

Linode-inspired dark interface. htmx + Tailwind, no build step.

### MVP-23 — UI shell and layout

**Size:** L
**Depends on:** MVP-06
**Files:** `src/ui/routes/shell.ts`, `src/ui/templates/layout.hbs`, `src/ui/static/style.css`

**Description:**
The outer layout of every page: top bar, left sidebar, main content area.

Use Handlebars (or Eta) for templates. Use Tailwind via CDN for MVP (swap to a build step later if needed). Use Alpine.js for small interactivity (dropdowns, collapsible sidebar).

Layout structure:
- Top bar: logo/name, global search (hidden for V1), notification bell (hidden), user menu (hidden)
- Left sidebar: sections (Dashboard, Projects, Agent Types, Settings), each with expandable sub-items
- Main content area: breadcrumbs, title + actions, content panel

Implement the Linode-inspired color palette from DESIGN.md section 12.2. Use CSS variables for theme colors so a future light mode can just swap them.

Active navigation item has a colored left border and slightly lighter background (see Linode screenshots in reference).

Create `src/ui/static/style.css` with a few custom styles on top of Tailwind for anything Tailwind can't easily do (scrollbar styling, focus rings, etc.).

**Acceptance criteria:**
- Navigating to `http://127.0.0.1:5757/` shows a blank page with the shell (sidebar + top bar + empty main area)
- Sidebar items are clickable and navigate to placeholder pages
- The aesthetic matches the Linode reference screenshots

---

### MVP-24 — Inbox view

**Size:** L
**Depends on:** MVP-23, MVP-10
**Files:** `src/ui/routes/inbox.ts`, `src/ui/templates/inbox.hbs`

**Description:**
The primary view. Flat list of all tickets currently in a `human` column across all projects.

Route: `GET /`

Query the API internally (or call the query functions directly to avoid a network hop): list all tickets where `column = 'human'` (or column's order is 0 within its project type), sorted by `updated_at DESC`.

Layout (from DESIGN.md section 12.5):

```
Inbox                                         N waiting   [ + New ticket ]
───────────────────────────────────────────────────────────────────────
Project      Title                                      Age    Priority
───────────────────────────────────────────────────────────────────────
[HMH]        Payment screens — 2 findings to review     3h     ● Normal
[VPS]        Question: OK to upgrade kernel?            1d     ● High
```

Each row is clickable and opens the ticket detail view. Use htmx for the "New ticket" button to open a modal without a full page reload.

Responsive: on narrow windows, columns stack cleanly.

Empty state: when the inbox is empty, show a friendly "All clear!" message with an illustration (can be a simple checkmark SVG).

**Acceptance criteria:**
- Shows all human-column tickets across all projects
- Sortable by priority, age, project
- Clicking a row navigates to the ticket detail
- Empty state is shown when no tickets

---

### MVP-25 — Projects list view

**Size:** M
**Depends on:** MVP-23, MVP-07
**Files:** `src/ui/routes/projects.ts`, `src/ui/templates/projects.hbs`

**Description:**
Table of all projects with status summary.

Route: `GET /projects`

Columns:
- Name (link to project board)
- Type
- Tickets (total count)
- In Progress (count of tickets in non-terminal, non-human columns)
- Heartbeat state (visual indicator: blue dot = active 5min, yellow = backing off, green = dormant 24h, black = no agents)
- Last Activity (relative time)

Actions:
- "Register project" — button at top, opens a modal listing unregistered projects (from auto-discovery) and lets you pick a type for each

An unregistered project shows inline with a "Pick type" button instead of the usual columns.

**Acceptance criteria:**
- All projects listed with status
- Clicking a project opens its board
- Unregistered projects can be registered with a type

---

### MVP-26 — Per-project board view

**Size:** L
**Depends on:** MVP-25, MVP-10
**Files:** `src/ui/routes/project-board.ts`, `src/ui/templates/project-board.hbs`

**Description:**
Full Kanban view for one project.

Route: `GET /projects/:id`

Layout:
- Breadcrumb: Projects > [project name]
- Title: project name, with a subtitle showing type and heartbeat state
- Action buttons: "New ticket", "Wake now", "Settings"
- Board: horizontal scrolling row of columns, each with its tickets as cards

Each ticket card shows:
- Title (truncated if long)
- Priority dot
- Age (relative)
- A small indicator if an agent is actively working on it (`claimed_by_run_id != null`)

Drag-and-drop between columns: use HTML5 drag events + htmx to POST to `/api/tickets/:id/move`. Optimistic UI update, roll back on error.

Columns are distinguished visually: human columns get a neutral background, agent columns get a subtle accent color, the done column gets a success tint.

**Acceptance criteria:**
- Full Kanban for a project is rendered
- Tickets can be dragged between columns
- The heartbeat indicator updates on reload
- Clicking a ticket opens the ticket detail view

---

### MVP-27 — Ticket detail view

**Size:** L
**Depends on:** MVP-26, MVP-10
**Files:** `src/ui/routes/ticket-detail.ts`, `src/ui/templates/ticket-detail.hbs`

**Description:**
Full thread view for a single ticket with action buttons.

Route: `GET /tickets/:id`

Layout:
- Breadcrumb: Projects > [project] > [ticket title]
- Header: priority, status (current column), created-at
- Thread: chronological list of all comments. Each entry shows author, timestamp, type (as a small badge), and body. Findings are highlighted with severity colors. Journal comments have an "info" icon. Chat summaries (post-V1) are collapsible.
- Actions panel at bottom:
  - Text area for a new comment
  - Action buttons: "Send back to [previous column]", "Approve to [next column]", "Override to Done", "Save as draft"
  - Dropdown to move to any other column

Agent runs are linked — clicking a run summary shows a modal with the full transcript.

htmx for the action buttons: POST to the API, refresh the relevant section of the page.

**Acceptance criteria:**
- Full thread is rendered chronologically
- Comments can be added
- Move actions work and refresh the view
- Transcript modal opens from agent run entries

---

### MVP-28 — Agent types editor

**Size:** M
**Depends on:** MVP-23, MVP-09
**Files:** `src/ui/routes/agent-types.ts`, `src/ui/templates/agent-types.hbs`, `src/ui/templates/agent-type-detail.hbs`

**Description:**
View and edit agent types, including their system prompts.

Routes:
- `GET /agent-types` — list
- `GET /agent-types/:id` — detail with prompt editor

The list shows: name, description, model, prompt length (in chars/lines), last edited.

The detail view has:
- Metadata fields (name, description, model, timeout, permission mode) as editable form inputs
- Tool allowlist as a multiselect
- Prompt text as a large textarea (or, if possible, a markdown-aware editor — CodeMirror or similar; for MVP a plain textarea is fine)
- "Save" button that PATCHes the agent type

Changes take effect immediately for new agent runs.

**Acceptance criteria:**
- All agent types are listed
- Editing a prompt saves it to the file and reflects immediately
- Editing model / tools / permission mode saves to the database

---

### MVP-29 — Settings view

**Size:** S
**Depends on:** MVP-23, MVP-11
**Files:** `src/ui/routes/settings.ts`, `src/ui/templates/settings.hbs`

**Description:**
Form-based editor for `config.json`.

Route: `GET /settings`

Expose the config schema as editable form fields, grouped by section (Heartbeat, Agents, UI, Retention, Discovery, Claude CLI). Save button PATCHes `/api/config`.

For V1 this is basic. Just enough to let you adjust heartbeat intervals and concurrency caps without hand-editing JSON.

**Acceptance criteria:**
- Config fields are editable
- Save updates the file and hot-reloads
- Invalid values show Zod errors inline

---

## MVP — Phase 7: CLI

### MVP-30 — CLI skeleton

**Size:** S
**Depends on:** MVP-06
**Files:** `src/cli/index.ts`, `src/cli/api-client.ts`

**Description:**
Set up the `dispatch` CLI using Commander (or yargs). Talks to the daemon over HTTP.

Create `src/cli/api-client.ts`:
- A thin wrapper around `fetch` that talks to `http://127.0.0.1:<port>/api/*`
- Reads the port from `config.json`
- Handles errors consistently (parses JSON error responses, prints them nicely)

Create `src/cli/index.ts` as the CLI entry:
- Parses the command line
- Dispatches to subcommand handlers
- Pretty-prints output (tables, colored text)

Use `commander` for parsing, `cli-table3` for tables, `chalk` for colors.

**Acceptance criteria:**
- Running `dispatch` with no args prints usage
- Running `dispatch --version` prints the package version
- Unknown commands print a helpful error

---

### MVP-31 — CLI: projects and wake

**Size:** S
**Depends on:** MVP-30, MVP-07
**Files:** `src/cli/commands/projects.ts`

**Description:**
Implement the project-related commands:

- `dispatch projects list` — table of all projects
- `dispatch projects show <name>` — details for one project
- `dispatch projects register <path> --type <type-id>` — register a folder
- `dispatch projects archive <name>` — archive
- `dispatch wake [project]` — reset heartbeat (or all projects if no name)

Output is a nicely formatted table for `list`, or a pretty-printed detail block for `show`.

**Acceptance criteria:**
- All commands work against a running daemon
- `wake` with no arg wakes all projects
- `wake HMH` wakes just one

---

### MVP-32 — CLI: tickets

**Size:** M
**Depends on:** MVP-30, MVP-10
**Files:** `src/cli/commands/tickets.ts`

**Description:**
Ticket operations from the terminal.

Commands:
- `dispatch ticket new` — interactive (prompts for project, title, body, column)
- `dispatch ticket new --project X --title "..." --body "..." --column Y` — non-interactive
- `dispatch ticket list [--project X] [--column Y]` — table of tickets
- `dispatch ticket show <id>` — detail view with thread
- `dispatch ticket comment <id> "text"` — add a comment
- `dispatch ticket move <id> <column>` — move to a column
- `dispatch inbox` — shortcut for `ticket list --column human` across all projects

Interactive mode uses `inquirer` or similar. Non-interactive mode is scriptable.

Ticket IDs can be full UUIDs or short prefixes (first 8 chars) for convenience — disambiguate with project + title if multiple match.

**Acceptance criteria:**
- All commands work against a running daemon
- Interactive `ticket new` is usable
- Non-interactive form works for scripting
- `dispatch inbox` shows the inbox as a table

---

### MVP-33 — CLI: daemon management

**Size:** S
**Depends on:** MVP-30
**Files:** `src/cli/commands/daemon.ts`

**Description:**
Commands for managing the daemon process itself.

- `dispatch daemon status` — is it running? uptime? memory?
- `dispatch daemon restart` — restart via launchctl/systemctl/sc
- `dispatch daemon stop` — stop the service
- `dispatch daemon start` — start the service
- `dispatch daemon logs [--follow] [--lines N]` — tail the log file
- `dispatch board [project]` — open `http://127.0.0.1:5757/[projects/:id]` in the default browser (uses `open` on macOS, `xdg-open` on Linux, `start` on Windows)
- `dispatch status` — the fast summary: inbox count, active projects, recent activity

All platform-specific logic (restart, start/stop) delegates to the platform modules (MVP-36/37/38).

**Acceptance criteria:**
- `dispatch daemon status` shows daemon state
- `dispatch board` opens the browser
- `dispatch status` prints a quick summary

---

## MVP — Phase 8: Installation and Platform

### MVP-34 — Install script

**Size:** L
**Depends on:** MVP-02, MVP-03, MVP-07, MVP-30
**Files:** `src/install.ts`, `bin/install.js`

**Description:**
The `npx projectdispatcher install` entry point. This is the first user-facing impression — make it polished.

Flow:
1. Print a banner with the project name and version
2. Confirm the install root (defaults to `~/Development/`, user can override)
3. Check prerequisites:
   - Node.js 20+
   - `claude` CLI available in PATH
   - Write permissions to the install root
   - The `.tasks/` directory doesn't already exist (or is empty) — otherwise ask to upgrade/reinstall
4. Create `~/Development/.tasks/` with subdirectories
5. Initialize the database and run migrations
6. Seed built-in project types and agent types (MVP-03)
7. Write default config.json
8. Copy default prompt markdowns to `~/Development/.tasks/prompts/`
9. Install the daemon service (platform-specific):
   - macOS: LaunchAgent (MVP-35)
   - Linux: systemd user unit (MVP-36)
   - Windows: Windows Service (MVP-37)
10. Add `dispatch` to PATH (via `npm link` or symlink)
11. Wait for the daemon to become healthy (poll `/api/health`)
12. Run auto-discovery to seed projects
13. Open `http://127.0.0.1:5757` in the default browser
14. Print a success message with next steps

On any failure, roll back cleanly: remove the service, delete `.tasks/` (only if we created it), unlink the binary.

Use a nice terminal UI (spinners, colored output). Package `ora`, `chalk`, `prompts`.

**Acceptance criteria:**
- Running `npx projectdispatcher install` on a clean system completes successfully
- Re-running it on an installed system detects the existing install and offers to upgrade
- Failure in any step rolls back cleanly
- The daemon is running and reachable after install

---

### MVP-35 — macOS platform integration

**Size:** M
**Depends on:** MVP-06
**Files:** `src/platform/macos.ts`

**Description:**
Install, start, stop, and uninstall the daemon as a LaunchAgent.

Exports:
- `installService(config): Promise<void>`
- `uninstallService(): Promise<void>`
- `startService(): Promise<void>`
- `stopService(): Promise<void>`
- `getServiceStatus(): Promise<'running' | 'stopped' | 'not-installed'>`

The LaunchAgent plist is written to `~/Library/LaunchAgents/com.projectdispatcher.daemon.plist`. It runs `node <path-to-installed-dispatch>/dist/daemon.js` with the user's environment.

Use `launchctl bootstrap gui/$(id -u)` to load it and `launchctl bootout` to unload.

The plist should include:
- Program arguments (node binary + daemon entry point)
- KeepAlive (restart on exit)
- StandardOutPath and StandardErrorPath pointing to `~/Development/.tasks/logs/daemon-stdout.log`
- WorkingDirectory
- EnvironmentVariables (PATH, HOME)

**Acceptance criteria:**
- `installService` creates the plist and loads it
- `launchctl list | grep projectdispatcher` shows the service
- After install, the daemon auto-starts on login
- `uninstallService` removes everything cleanly

---

### MVP-36 — Linux platform integration

**Size:** M
**Depends on:** MVP-06
**Files:** `src/platform/linux.ts`

**Description:**
Install the daemon as a systemd user unit.

Unit file at `~/.config/systemd/user/projectdispatcher.service`:

```ini
[Unit]
Description=Project Dispatcher Daemon
After=network.target

[Service]
ExecStart=/usr/bin/node /path/to/dispatch/dist/daemon.js
Restart=on-failure
RestartSec=5
StandardOutput=append:%h/Development/.tasks/logs/daemon-stdout.log
StandardError=append:%h/Development/.tasks/logs/daemon-stderr.log
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

Use `systemctl --user enable --now` to start. Use `systemctl --user disable --now` + `rm` to remove.

Same exports as the macOS version.

**Acceptance criteria:**
- Installs on a Linux system with systemd
- Auto-starts on login (may require `loginctl enable-linger`)
- Can be managed via `systemctl --user`

---

### MVP-37 — Windows platform integration

**Size:** L
**Depends on:** MVP-06
**Files:** `src/platform/windows.ts`

**Description:**
Install the daemon as a Windows Service using `node-windows`.

Windows is the trickiest platform. Use the `node-windows` package which wraps `sc.exe` for service management.

Same exports as the macOS/Linux versions.

Service name: `ProjectDispatcher`
Service description: `Async ticket-based communication between human and AI agents`

Stdout/stderr are captured to `%USERPROFILE%\Development\.tasks\logs\` just like on macOS/Linux.

Paths use Windows conventions (`%USERPROFILE%` vs `~`).

This may require running the install as Administrator. Document this clearly.

**Acceptance criteria:**
- Installs on Windows 10/11 with Node 20+
- Service appears in `services.msc`
- Starts on boot
- Can be managed via the `dispatch` CLI

---

### MVP-38 — Update flow

**Size:** S
**Depends on:** MVP-34
**Files:** `src/commands/update.ts`

**Description:**
`dispatch update` — checks npm for a newer version, downloads it, migrates the database if needed, restarts the daemon.

Logic:
1. Query npm registry for the latest version of `projectdispatcher`
2. Compare with the installed version
3. If newer, confirm with the user, run `npm install -g projectdispatcher@latest`
4. Stop the daemon
5. Run migrations (idempotent — new ones will apply, old ones are skipped)
6. Start the daemon
7. Verify health

**Acceptance criteria:**
- Detects newer versions
- Applies new migrations cleanly
- Daemon comes back up after update

---

### MVP-39 — Uninstall flow

**Size:** S
**Depends on:** MVP-34
**Files:** `src/commands/uninstall.ts`

**Description:**
`dispatch uninstall` — removes the daemon service, unlinks the binary, optionally deletes the `.tasks/` directory.

Flow:
1. Confirm intent
2. Stop the daemon
3. Uninstall the service (platform-specific)
4. Unlink the global `dispatch` binary
5. Ask if the user wants to delete `~/Development/.tasks/` (contains their tickets and config)
6. Print goodbye message

**Acceptance criteria:**
- Clean removal on any platform
- Does not delete user data unless confirmed
- Can be re-installed after uninstall

---

## MVP — Phase 9: Testing and Hardening

### MVP-40 — Unit tests for database queries

**Size:** M
**Depends on:** MVP-02, MVP-07, MVP-08, MVP-09, MVP-10
**Files:** `test/unit/db/*.test.ts`

**Description:**
Vitest unit tests for every query function in `src/db/queries/`. Use an in-memory SQLite database for tests (`:memory:`).

Cover:
- Create / read / update / delete for each entity
- Foreign key enforcement (should fail cleanly on bad refs)
- Append-only comments (no update or delete)
- Idempotent seeds
- Edge cases: missing rows, duplicate inserts, null fields

**Acceptance criteria:**
- `npm test` runs all tests
- Each query function has at least 2-3 tests
- Coverage on db layer > 80%

---

### MVP-41 — Integration tests for the HTTP API

**Size:** M
**Depends on:** MVP-06, MVP-07, MVP-08, MVP-09, MVP-10, MVP-11
**Files:** `test/integration/api.test.ts`

**Description:**
Spin up a real daemon (against a temporary database) and make HTTP calls to exercise every endpoint.

Use Fastify's `inject` method for fast testing (no actual port binding required).

Cover:
- Create a project, create a ticket, move it, add comments, see the full thread
- CRUD on project types and agent types
- Config read/write
- Error paths (invalid inputs return 400, not found returns 404, conflicts return 409)

**Acceptance criteria:**
- All tests pass
- Database is cleaned up between tests
- Covers the happy path of every endpoint

---

### MVP-42 — Smoke test for agent round-trip

**Size:** L
**Depends on:** MVP-18, MVP-20
**Files:** `test/integration/agent-round-trip.test.ts`

**Description:**
The critical end-to-end test: file a ticket → agent claims it → agent does something visible → agent moves it → human sees it.

This test uses a mock agent runtime (not a real `claude` process) that just:
1. Calls `read_my_ticket`
2. Calls `claim_ticket`
3. Writes a file `hello.txt` in the project directory
4. Calls `add_comment` with a summary
5. Calls `move_to_column('human')`

Verify:
- The ticket ends up in the human column
- The agent_runs row is `success`
- The file `hello.txt` exists
- The comment is appended to the thread
- The transcript file is written

This test exercises the scheduler, the runner, the MCP tools, and the database together. If it passes, the core loop works.

**Acceptance criteria:**
- Test passes reliably
- Any regression in the core loop breaks this test

---

### MVP-43 — Dogfood on a real project

**Size:** M (time-based, spread over a week)
**Depends on:** all prior MVP tasks
**Files:** none (this is operational, not code)

**Description:**
Install Project Dispatcher on the real `~/Development/` and use it for HandyManagerHub work. File real tickets. Let agents run against real code. Review their output. Find bugs.

Keep a bug log as you go. File tickets in Project Dispatcher for its own fixes.

Success is when you can comfortably complete a real feature (not a toy) using only the ticket flow, without opening Claude Code directly against HMH for manual work.

**Acceptance criteria:**
- One full feature shipped through the ticket flow
- At least 5 rounds of human ↔ agent handoffs completed
- Bug log reviewed and triaged
- Confidence that the tool is ready to be its own project's manager

---

## V1 — Post-MVP Improvements

Things worth doing soon after MVP is stable. These improve the daily experience.

### V1-01 — Synchronous chat in ticket

**Size:** XL
**Depends on:** MVP complete
**Description:**
Add the "Start chat" button to the ticket detail view. When clicked, open a chat pane on the right. Under the hood, spawn an interactive `claude` subprocess (not `-p`) with the ticket context as initial prompt and a pseudo-terminal (`node-pty`) for bidirectional IO.

WebSocket between the browser and the daemon streams input/output. User types, daemon pipes to the pty, output streams back. When the user closes the chat (or a timer fires), the daemon:
1. Sends SIGTERM to the subprocess
2. Asks Claude (via a separate `claude -p` call) to summarize the transcript
3. Appends the summary as a `chat_summary` comment on the ticket
4. Saves the full transcript to `~/Development/.tasks/artifacts/chats/<chat_id>.log`

The chat pane should auto-close after N minutes of inactivity (configurable).

**Acceptance criteria:**
- User can open chat, have a conversation, close chat
- Summary appears as a ticket comment
- Full transcript is preserved
- No orphaned subprocesses after abnormal closure

---

### V1-02 — Keyboard shortcuts in the inbox

**Size:** M
**Depends on:** MVP-24, MVP-27
**Description:**
Gmail-style navigation and actions. Use a lightweight JS key handler (no framework).

Shortcuts:
- `j` / `k` — next/previous ticket in inbox
- `Enter` — open selected ticket
- `c` — compose new ticket (opens modal)
- `m` — move selected ticket (opens column picker)
- `r` — reply (focuses the comment box in ticket detail)
- `a` — approve (move forward in the workflow)
- `b` — send back (move back)
- `/` — focus search (future)
- `?` — show shortcut help
- `Esc` — close modals or detail pane

Add a help modal that shows all shortcuts, triggered by `?`.

**Acceptance criteria:**
- All shortcuts work in the inbox and ticket detail
- Shortcuts don't fire when typing in a text field
- `?` shows the help

---

### V1-03 — Real-time UI updates

**Size:** L
**Depends on:** MVP complete
**Description:**
Replace 10-second polling with WebSocket or Server-Sent Events. When a ticket changes, the daemon publishes an event; the UI subscribes and updates the affected views.

Use SSE (simpler than WebSockets) unless bidirectional comms are needed elsewhere. Each page subscribes to a topic filter:
- Inbox subscribes to `tickets.*.column_changed_to_human`
- Project board subscribes to `projects.<id>.*`
- Ticket detail subscribes to `tickets.<id>.*`

The daemon has an in-memory event bus that publishes on every database write.

**Acceptance criteria:**
- Moving a ticket from one pane updates instantly in another pane
- Multiple browser tabs stay in sync
- Reconnection on daemon restart works

---

### V1-04 — macOS native notifications

**Size:** M
**Depends on:** V1-03
**Description:**
When a ticket lands in a Human column, show a macOS notification (via `node-notifier`).

Configurable:
- Enable/disable per project
- Enable/disable globally
- Quiet hours (no notifications 10pm-7am)

Clicking the notification opens the ticket in the UI.

For Linux and Windows, use platform-specific alternatives (`notify-send` on Linux, Windows toast on Windows).

**Acceptance criteria:**
- Notification fires when a ticket arrives in Human
- Clicking opens the ticket
- Quiet hours respected
- Easily disabled in settings

---

### V1-05 — Recurring tickets (cron-scheduled)

**Size:** M
**Depends on:** MVP complete
**Description:**
Allow users to define recurring tickets that are automatically created on a schedule.

Add a `recurring_tickets` table:
- `id`, `project_id`, `title_template`, `body_template`, `target_column`, `cron_expression`, `priority`, `tags`, `enabled`, `last_created_at`, `next_run_at`

Use `node-cron` or similar to schedule. On each run, create a new ticket from the template and update `next_run_at`.

UI: a "Recurring tickets" section under each project, with a form to define a new one.

Use cases:
- "Every Monday at 9am, create a ticket in VPS-Maintenance: 'Weekly security audit'"
- "First of every month, create a ticket in HMH: 'Reset free tier counters' (for V1 of HMH's own cron gap)"

**Acceptance criteria:**
- Cron expressions are validated
- Tickets are created on schedule
- Disabled recurring tickets don't run
- Missed runs during daemon downtime are optionally caught up (configurable)

---

### V1-06 — Git integration: auto-link commits

**Size:** M
**Depends on:** MVP complete
**Description:**
When an agent commits code during a run, link the commits to the ticket automatically.

Mechanism: the agent runner detects when the project has a git repo (looks for `.git/`) and, after the run ends, diffs the git log against a snapshot from before the run started. Any new commits are associated with the run and the ticket.

Alternative: the agent includes the commit SHAs in its summary comment (current pattern — just parse them out).

Ticket detail view shows a "Linked commits" section with short SHA, message, author, and a click-through to the repo on GitHub (if a remote is configured).

**Acceptance criteria:**
- New commits during an agent run are auto-linked
- Ticket detail shows them
- Works on projects with and without git remotes

---

## V2 — Future Extensions

Nice-to-haves for later. Not needed for daily use but would make the tool more capable.

### V2-01 — Cost tracking and budgets

**Size:** L
**Description:**
Per-agent-run cost estimation based on token counts. Aggregated per project per day / week / month. Optional soft budget enforcement (warn at 80% of monthly budget, block new runs at 100%).

Cost is estimated from the stream-json transcript (count input tokens + output tokens, multiply by model rates). Model rates are in a config file so they can be updated as prices change.

UI: a cost dashboard per project, a cost widget in the header (current day spend).

---

### V2-02 — Plugin agent runtimes

**Size:** XL
**Description:**
Support agent runtimes other than `claude -p`. Define a plugin interface: given a ticket context and agent type config, produce a result (completed, blocked, failed).

Built-in runtimes:
- `claude-cli` (the current one)
- `shell-script` — runs a user-provided script with env vars
- `http-webhook` — POSTs to a URL, waits for a response
- `openai-agents-sdk` — uses OpenAI's agent SDK (requires OpenAI API key)

Agent types gain a `runtime` field specifying which to use.

---

### V2-03 — Custom MCP tools

**Size:** L
**Description:**
Let users define custom MCP tools that agents can use. Example tools:
- `send_slack_message(channel, message)`
- `create_github_pr(repo, branch, title, body)`
- `query_sentry_issue(issue_id)`
- `check_uptime_status(monitor_id)`

Tools are defined via config files. Each tool has: name, description, input schema, output schema, handler (shell command, HTTP endpoint, or JS function).

Agents can only use tools in their type's allowlist, now including custom tools.

---

### V2-04 — Full-text search

**Size:** M
**Description:**
Search across all tickets: titles, bodies, comments. Use SQLite FTS5 (built-in).

Add an `fts` virtual table mirroring the key text fields. Keep it in sync with triggers.

Search UI: a search box in the top bar. Results grouped by project, with snippets.

---

### V2-05 — Ticket templates

**Size:** S
**Description:**
Save a ticket as a template for reuse. Templates have placeholders (`{{customer_name}}`) that are prompted when creating a new ticket from the template.

Useful for routine work: "Create VPS audit ticket," "File new customer onboarding."

---

### V2-06 — Ticket dependencies

**Size:** M
**Description:**
Let tickets depend on other tickets. Ticket A is blocked until ticket B is in Done.

A blocked ticket cannot be claimed by an agent even if it's in an agent column — the scheduler skips it until its dependencies are satisfied.

UI: ticket detail shows dependencies, warns if blocked.

---

### V2-07 — Mobile / responsive UI

**Size:** L
**Description:**
Make the web UI work on phones and tablets. Primarily for inbox triage away from the desk.

Read-only views first: inbox, ticket detail. Replying and moving tickets on mobile is a nice-to-have.

---

### V2-08 — Single-binary distribution

**Size:** L
**Description:**
Package the tool as a single binary using `pkg`, `node-sea`, or `bun build --compile`. Users who don't want to install Node can download and run a standalone binary.

Binaries for macOS (Intel + Apple Silicon), Linux (x64 + arm64), and Windows (x64).

Published on GitHub Releases.

---

### V2-09 — Docker distribution

**Size:** M
**Description:**
Optional Docker image for users who want to run the daemon in a container. Mount the project directories as volumes.

Use case: running Project Dispatcher on a home server to manage remote projects.

---

### V2-10 — Theme customization

**Size:** S
**Description:**
Allow users to override the color palette via a theme config file. Ship a few built-in themes (dark default, light, high-contrast, solarized).

---

### V2-11 — Project archiving with full export

**Size:** S
**Description:**
`dispatch projects archive <name> --export` — archives a project and exports all its tickets and comments to a single JSON file at `~/Development/.tasks/archives/<project_name>-<date>.json`. The archive can be re-imported later.

---

### V2-12 — Webhook triggers for external events

**Size:** M
**Description:**
Expose an authenticated webhook endpoint that external services can POST to in order to create tickets. Useful for:
- GitHub Issues → create a ticket when a new issue is labeled
- Slack reactions → create a ticket from a message
- Sentry alerts → create a ticket when an error fires

The webhook is signed with a shared secret.

---

### V2-13 — Agent learning from past runs

**Size:** XL
**Description:**
Give agents access to their own history. When an agent starts a run, it can query past successful runs in the same project and learn from them. Could be as simple as "here are the last 5 completed tickets in this column and what you wrote for them."

Requires thinking about prompt size and whether this actually helps or just bloats the context.

---

## Summary

**MVP phases:**
- Phase 1 (Foundation) — 5 tasks, ~1 weekend
- Phase 2 (HTTP API + Daemon) — 6 tasks, ~1 weekend
- Phase 3 (Filesystem integration) — 3 tasks, ~1 day
- Phase 4 (Agent runtime) — 5 tasks, ~1 weekend
- Phase 5 (Scheduler) — 3 tasks, ~1 day
- Phase 6 (Web UI) — 7 tasks, ~1-2 weekends
- Phase 7 (CLI) — 4 tasks, ~1 day
- Phase 8 (Installation and platform) — 6 tasks, ~1 weekend
- Phase 9 (Testing and hardening) — 4 tasks, ~few days ongoing

**Total MVP:** 43 tasks, 3-4 focused weekends for a solo dev with AI agent help.

**V1 extensions:** 6 tasks, ~1-2 weekends.

**V2 extensions:** 13 tasks, ongoing as needed.

If you're an agent picking up this document to start work, begin with **MVP-01**. Don't skip phases — later work depends on earlier work. Commit after each task so the history is clear.

---

Last updated: 2026-04-11, before any code was written.
