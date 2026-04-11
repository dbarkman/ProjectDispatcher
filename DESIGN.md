# Project Dispatcher — Design Document

**Version:** 0.1 (MVP design)
**Date:** 2026-04-11
**Status:** Design — not yet implemented
**Author:** David Barkman (and an AI coding agent — Claude Opus 4.6, which also wrote this document)

---

## Table of Contents

1. [Vision](#1-vision)
2. [Scope](#2-scope)
3. [Non-goals](#3-non-goals)
4. [Core Concepts](#4-core-concepts)
5. [User Workflows](#5-user-workflows)
6. [System Architecture](#6-system-architecture)
7. [Data Model](#7-data-model)
8. [Project Types (built-in library)](#8-project-types-built-in-library)
9. [Agent Types (built-in library)](#9-agent-types-built-in-library)
10. [Heartbeat and Scheduling](#10-heartbeat-and-scheduling)
11. [Agent Runtime](#11-agent-runtime)
12. [UI/UX Specification](#12-uiux-specification)
13. [CLI Specification](#13-cli-specification)
14. [Installation and Packaging](#14-installation-and-packaging)
15. [Security Model](#15-security-model)
16. [Storage and Persistence](#16-storage-and-persistence)
17. [Configuration](#17-configuration)
18. [Extensibility](#18-extensibility)
19. [Error Handling and Resilience](#19-error-handling-and-resilience)
20. [Observability](#20-observability)
21. [Post-V1 Roadmap](#21-post-v1-roadmap)
22. [Tech Stack](#22-tech-stack)
23. [Repository Layout](#23-repository-layout)
24. [Development Workflow](#24-development-workflow)
25. [Dogfooding Plan](#25-dogfooding-plan)
26. [Glossary](#26-glossary)

---

## 1. Vision

Project Dispatcher is an async ticket-based communication layer between a human and AI agents. It abstracts the human-agent interaction from a live conversation (Claude Code session) to a persistent, routable, inspectable set of tickets that move through columns on per-project boards.

The problem it solves:

When a human collaborates with AI agents on multiple projects, the current state of the world requires opening a fresh agent session per project, manually relaying outputs between agents (e.g., "here's what the code reviewer said, please fix"), and losing context every time a session ends. This creates three problems:

1. **Relay bottleneck.** The human becomes the message bus between agents. Code agent finishes, human copies output into code-reviewer session, reviewer produces findings, human copies findings back to code agent, and so on. Every step requires human attention.

2. **Project abandonment.** When you step away from a project for weeks, the session context dies. You come back and have to reconstruct where you were from git log and memory. Many side projects die this way.

3. **Serial context switching.** Even when you're actively working, you can only have one Claude session at a time focused on one project. Switching projects means closing the session, opening another, bringing it up to speed.

Project Dispatcher solves all three:

- **Agents talk to each other through tickets.** The human only appears in the loop when input is actually needed (a question, a sign-off, a block). Between agent handoffs, the human is not involved.

- **Persistent boards per project.** Every project has a persistent Kanban board. Dormant work is one click away. You can abandon a ticket for three weeks, come back, and continue without reconstruction cost.

- **Parallel work across projects.** File tickets across five projects in ten minutes, walk away, come back two hours later, triage the inbox of things that need your attention. Projects run in parallel because agents are ephemeral processes woken by schedules, not persistent sessions.

The mental model: you are a supervisor with a team of AI agents, each of whom handles a specific kind of work. You don't manage them directly. You file tickets into a queue. The agents pick up tickets when their heartbeat fires. They complete work, hand off to the next agent, or escalate questions to you. You process your inbox when you have time. Work gets done while you do other things.

---

## 2. Scope

Project Dispatcher is scoped tightly on purpose. The MVP does one thing well: routes tickets between a human and AI agents across multiple projects.

### In scope for V1

- Local-only, single-user installation
- Auto-discovery of projects under `~/Development/`
- Built-in library of project types (software-dev, vps-maintenance, content, research, personal)
- Built-in library of agent types (coding agent, code reviewer, security reviewer, sysadmin, security auditor, writer, editor, deployer, researcher)
- Editable agent system prompts stored as markdown files
- Persistent ticket store (SQLite)
- Threaded ticket conversations with append-only history
- Column-based routing (Human → agents → Human)
- Unified inbox view across all projects
- Per-project Kanban board view
- Project list view
- Ticket detail view with inline reply and action buttons
- Exponential backoff heartbeat per project
- Daemon process auto-started on boot
- Web UI accessible at `http://localhost:5757`
- CLI for common operations
- Cross-platform install (macOS, Linux, Windows) via `npx`
- Agent runtime that invokes `claude -p` with appropriate context
- MCP server exposing ticket manipulation tools to agents
- Model selection per agent type (Opus / Sonnet / Haiku)
- YOLO mode (`--dangerously-skip-permissions`) per agent type
- Audit trail of every agent run (transcript capture)

### Out of scope for V1 (planned for later)

- Synchronous chat session inside a ticket (launch interactive `claude` session with ticket context, summarize transcript back when done)
- macOS native or menu-bar notifications
- Gmail-style keyboard shortcuts in the inbox
- Real-time UI updates (WebSockets / SSE). V1 uses polling every 10 seconds.
- Git integration (auto-linking commits to tickets)
- Multi-user / auth / team collaboration
- Mobile UI
- Budgets and cost tracking
- Public sharing of tickets
- Plugin system for custom agent runtimes beyond `claude -p`

### Never in scope

- Org charts, CEO agents, hierarchies, delegation
- Multi-tenant cloud hosting
- Enterprise features (SSO, RBAC, audit compliance)
- Replacing Linear, Jira, GitHub Projects as a general-purpose PM tool

---

## 3. Non-goals

It is worth explicitly enumerating what this tool deliberately does not try to be:

- **It is not a personal todo list.** It is for tracking work you plan to do *with AI agents*. A separate todo app is fine for groceries and dentist appointments.

- **It is not a general project management tool.** No milestones, no burndown charts, no velocity tracking, no timelines, no estimates, no dependencies between tickets. If you want those, use Linear.

- **It is not a team tool.** It runs locally, single-user, on your machine. It assumes you are the only human in the loop. If you want to collaborate with other humans, use any of the dozens of excellent team tools that exist.

- **It does not have a hierarchy.** All agents are peers. Agents do not delegate to other agents — the column routing system does that instead. There is no "CEO agent" that assigns work. The human is the only source of ticket creation (or the human-invoked creation of tickets from external triggers like cron).

- **It is not an agent framework.** It does not define how to build agents. It integrates with Claude Code via `claude -p` as the primary agent runtime. Other runtimes can be added later but that is not the goal of V1.

- **It is not a workflow engine.** It does not handle retries, fan-out, conditional branching, or complex orchestration. If you want Temporal or Trigger.dev, use those. Project Dispatcher is a dumb ticket router with a nice UI.

- **It is not ambitious about AI.** It does not try to make agents smarter, more autonomous, or more capable. That is the job of the underlying LLM and the prompts. Project Dispatcher is plumbing.

---

## 4. Core Concepts

### 4.1 Project

A project is a folder under `~/Development/`. Any subfolder automatically qualifies. Projects do not need to be code repositories — they can be documentation folders, research notes, or just empty directories with a `notes.md`. What makes a folder a "project" is that it has been registered with Project Dispatcher (via the first-run auto-discovery) and assigned a type.

Projects are auto-discovered on daemon startup and on filesystem events (a new folder appears → a new project shows up in the UI, marked "unregistered" until you pick a type for it). Deleted folders are detected and marked "missing" (tickets are preserved, but agents cannot run against them).

A project has:

- `id` — stable UUID, survives rename
- `name` — display name (defaults to folder basename)
- `path` — absolute path on disk
- `type` — from the built-in project types library or custom
- `status` — active / dormant / missing / archived
- `heartbeat_state` — see section 10
- `last_activity_at` — most recent ticket change
- `created_at` — when first seen by the daemon

### 4.2 Project type

A project type is a preset that defines which columns and which agent types a project uses. It is a first-class entity in the data model — the built-in library is seeded on install, and users can edit or create their own types through the UI or by editing config files.

A project type has:

- `id` — stable slug (e.g., `software-dev`, `vps-maintenance`)
- `name` — display name
- `description` — one-liner explanation
- `columns` — ordered list of columns for this type. First is always `Human` (inbox), last is always `Done` (archive).
- `default_agents` — map from column → agent type (which agent type staffs which column)
- `icon` — optional icon identifier for the UI

### 4.3 Ticket

A ticket is a unit of work. It has a title, a body, a current column, a priority, tags, and a threaded history of comments and transitions. Tickets are append-only — you never edit the history, you add to it.

A ticket has:

- `id` — stable UUID
- `project_id` — which project it belongs to
- `title` — short, one-line summary
- `body` — the initial description (can be rich markdown)
- `column` — where it is right now (the agent/human responsible)
- `priority` — low / normal / high / urgent
- `tags` — freeform labels for filtering
- `created_at`, `updated_at`
- `created_by` — who filed it (always "human" in V1, later could be "cron", "webhook", etc.)

Tickets do not have assignees in the traditional sense. The column IS the assignment. Whoever is responsible for column X is responsible for tickets in column X.

### 4.4 Column

A column represents a role in the workflow. Columns are defined by the project type. Every project has at minimum two columns: `Human` (inbox) and `Done` (archive). Between them, the project type can define any number of intermediate columns, each staffed by a specific agent type.

A column has:

- `id` — stable slug scoped to the project (e.g., `code-reviewer`, `human`, `done`)
- `name` — display name
- `agent_type` — which agent type staffs this column (null for `Human` and `Done`)
- `order` — left-to-right position on the Kanban board

Columns are immutable once a project is set up. Changing a project's columns requires rebuilding the project's column set (existing tickets stay, but you may need to reroute them manually if their current column is removed).

### 4.5 Comments and history

Every change to a ticket is recorded in a comment or history entry. A ticket's thread is an append-only log of everything that has happened to it.

Comment types:

- `comment` — free-form text from human or agent
- `move` — ticket moved from column A to column B (records the actor)
- `claim` — an agent atomically claimed the ticket to work on it
- `complete` — agent finished work and moved the ticket forward
- `finding` — an agent (usually a reviewer) attached structured findings (severity + body)
- `journal` — an agent noted a reversible decision it made ("I chose approach X because of Y")
- `block` — an agent raised a question and sent the ticket back to Human
- `chat_summary` — (post-V1) the summary of a synchronous chat session

A comment has:

- `id`
- `ticket_id`
- `type`
- `author` — `"human"` or an agent identifier like `"code-reviewer:run-abc123"`
- `body` — markdown
- `meta` — JSON blob for type-specific fields (severity for findings, from/to columns for moves)
- `created_at`

### 4.6 Agent

In Project Dispatcher, an "agent" is a stateless process — a fresh invocation of Claude Code with a specific system prompt, tool allowlist, model, and CWD. Agents are not long-running. When an agent is "staffing" a column, it means that the platform will invoke a new Claude process (with the right prompt and tools for that agent type) whenever a ticket lands in that column and the project's heartbeat fires.

An agent has no persistent state between invocations. Everything it knows about its work is read from the ticket (full thread, including prior comments and findings) and from the project's files on disk (including CLAUDE.md).

An agent run has:

- `id` — UUID for this specific invocation
- `ticket_id` — what it was working on
- `agent_type` — which type of agent
- `model` — which Claude model was used
- `started_at`, `ended_at`
- `exit_status` — success / timeout / crashed / blocked
- `transcript_path` — where the full transcript is saved (for audit)
- `cost_estimate` — approximate tokens used (optional, V2)

### 4.7 Agent type

An agent type is a preset that defines the behavior of an agent. Like project types, it is a first-class entity, seeded with defaults, user-editable.

An agent type has:

- `id` — stable slug (e.g., `coding-agent`, `code-reviewer`)
- `name` — display name
- `description` — what this agent does
- `system_prompt_path` — path to the markdown file containing the system prompt (relative to `~/Development/.tasks/prompts/`)
- `model` — default model (`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`)
- `allowed_tools` — list of tool names (e.g., `Read`, `Edit`, `Write`, `Bash`, `Grep`, `Glob`)
- `permission_mode` — `default`, `acceptEdits`, `bypassPermissions`, `plan`
- `timeout_minutes` — how long an agent run can take before it's killed
- `max_retries` — how many times to retry if the agent crashes (default 0 for V1)

### 4.8 Heartbeat

Per-project, exponential backoff. Details in section 10.

---

## 5. User Workflows

### 5.1 The primary "fire and forget" workflow

The most common pattern. You start your day, open Project Dispatcher, and fire off tickets across multiple projects. Each ticket is a well-scoped piece of work. You assign each one to an agent column (which resets that project's heartbeat to 5 minutes). Then you close the laptop and go do other things.

Two hours later you come back. Your unified inbox has a mix: some tickets are done (they made it through the review cycle and are waiting for your sign-off), some have questions from agents that couldn't make judgment calls, some are still in progress. You rip through the inbox: read the completed work, approve or request revisions, answer the blocking questions. Each action sends the ticket back into the workflow.

You can do a full day's worth of coordination in 30 minutes of triage time. The agents do the execution while you do other things.

### 5.2 Inbox-first triage

You open Project Dispatcher. The landing page is the Inbox — a flat list of every ticket currently in a `Human` column across every project you own, sorted by age (or by project, optionally).

You click a ticket. The right panel shows the full thread: initial description, every prior comment, every status change, every finding. At the bottom: action buttons and a comment box.

Common actions:
- **Reply** — add a comment, leave the ticket in Human
- **Reply and return** — add a comment and move back to the agent that sent it
- **Approve** — send forward (e.g., to Code Reviewer, or to Done)
- **Override** — make a decision the agent couldn't, write a note explaining, send back
- **Reroute** — move to a different column entirely

You rip through the inbox. Each ticket might take 30 seconds to 2 minutes of your attention. When the inbox is empty, you're done.

### 5.3 Deep project dive

Sometimes you want to see the full state of a project, not just what needs your attention. Click a project name anywhere in the UI. You see the full Kanban board for that project: all columns, all tickets in each, with their age, priority, and most recent activity.

Useful for:
- Coming back to a dormant project and remembering where you were
- Understanding why an agent's been stuck on something
- Reorganizing priorities
- Spotting bottlenecks (e.g., "why is everything piling up in Code Reviewer?")

### 5.4 Creating a ticket

Three entry points:

- **From the web UI:** click "New ticket" on the project board or the projects list. Pick a column, fill in title + body, submit.
- **From the CLI:** `dispatch ticket new --project HMH --title "..." --body "..." --column coding-agent`. Fast when you know what you want.
- **From the inbox:** click "New ticket" at the top of the inbox. Pick a project and column from dropdowns.

Tickets always start with a human author. The moment you file a ticket and land it in an agent column, that project's heartbeat resets to 5 minutes.

### 5.5 Synchronous chat (post-V1)

Some conversations are too nuanced for async ticket ping-pong. You want to ask two or three questions, get answers, make a decision, and close the loop quickly. For that, a synchronous chat.

Every ticket detail view has a "Start chat" button. Clicking it opens a chat pane on the right. Under the hood, the platform launches `claude` in interactive mode with the full ticket thread as context. You chat for as long as you need. When you close the chat (or an optional timer fires), the platform summarizes the conversation and appends it to the ticket as a single `chat_summary` entry. The full transcript is preserved in `~/Development/.tasks/artifacts/` for audit.

This gives you an escape valve from the pure-async model when it's warranted, without losing the ticket as the canonical record of what happened.

---

## 6. System Architecture

### 6.1 High-level diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                      User (browser + terminal)                   │
└───────────┬──────────────────────────────────┬───────────────────┘
            │                                  │
            │ HTTP (web UI)                    │ CLI commands
            │                                  │
┌───────────▼──────────────────────────────────▼───────────────────┐
│                    Project Dispatcher Daemon                     │
│                     (long-lived Node.js process)                 │
│                                                                  │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐ │
│  │  HTTP API  │  │ MCP Server │  │  Scheduler │  │   Watcher  │ │
│  │  (Fastify) │  │  (Fastify) │  │ (setTimeout│  │  (chokidar │ │
│  │            │  │            │  │  per proj) │  │   on fs)   │ │
│  └─────┬──────┘  └──────┬─────┘  └──────┬─────┘  └──────┬─────┘ │
│        │                │               │               │       │
│        └────────────────┴───────┬───────┴───────────────┘       │
│                                 │                               │
│                           ┌─────▼─────┐                         │
│                           │  SQLite   │                         │
│                           │  (tasks.db│                         │
│                           └───────────┘                         │
│                                 │                               │
│                        ┌────────▼────────┐                      │
│                        │  Agent Runner   │                      │
│                        │  (spawns claude │                      │
│                        │   subprocesses) │                      │
│                        └─────────────────┘                      │
└──────────────────────────────────┬───────────────────────────────┘
                                   │
                                   │ spawn / IPC
                                   ▼
                     ┌──────────────────────────┐
                     │  claude -p subprocess    │
                     │  (ephemeral, per run)    │
                     │  ─ reads CLAUDE.md       │
                     │  ─ claims ticket via MCP │
                     │  ─ does work             │
                     │  ─ updates ticket        │
                     │  ─ exits                 │
                     └──────────────────────────┘
```

### 6.2 Components

**Daemon** — a single long-lived Node.js process running in the background. Started via LaunchAgent (macOS), systemd user unit (Linux), or Windows Service (Windows). Owns all state, all scheduling, all HTTP endpoints, all agent spawning.

**HTTP API** — Fastify server on `127.0.0.1:5757`. Serves the web UI and exposes a REST-ish API for the CLI. Never bound to non-localhost — this is a single-user local tool.

**MCP server** — also Fastify, but serving MCP protocol on a separate path. Agents connect to this when invoked. Exposes tools like `read_my_ticket`, `add_comment`, `move_to_column`, `attach_finding`.

**Scheduler** — in-process. Uses `setTimeout` per project to wake agents on their heartbeat. No external cron. When a ticket moves or the human interacts with a project, the scheduler's state updates and timers reset.

**Watcher** — uses `chokidar` to watch `~/Development/` for new/deleted subfolders, so auto-discovery is live, not requiring a restart.

**SQLite database** — single file at `~/Development/.tasks/tasks.db`. All state lives here. Accessed via `better-sqlite3` (sync API, no race conditions on a single-process daemon).

**Agent runner** — when a ticket is ready for an agent, the scheduler calls the agent runner with `(ticket_id, agent_type)`. The runner:
1. Builds the system prompt from the agent type's template + ticket context
2. Constructs the `claude -p` command line with appropriate flags
3. Spawns the subprocess with `child_process.spawn`, CWD set to the project directory
4. Captures stdout/stderr to the transcript file
5. Waits for exit
6. Updates the `agent_runs` table with the outcome

### 6.3 Daemon process

The daemon is the single source of truth. It is the only process that writes to the database. It exposes HTTP and MCP endpoints. It spawns agent subprocesses as children.

Lifecycle:
- Started on system boot via init integration (launchd / systemd / Windows Service Manager)
- Can be stopped and restarted via the CLI (`dispatch daemon restart`)
- Logs to `~/Development/.tasks/logs/daemon.log` (rotated daily, capped at 7 days)
- Crashes are restarted automatically by the init system
- PID file at `~/Development/.tasks/daemon.pid`

The daemon is idempotent: on startup, it loads the current project list, replays heartbeat state from the database, and schedules timers for each project based on its `next_heartbeat_at` timestamp. Any agent runs that were in-flight when the daemon crashed are marked `exit_status = crashed` and their tickets are unlocked (returned to the column they were claimed from).

### 6.4 HTTP API

Runs on `http://127.0.0.1:5757`. Endpoints (REST-style):

```
GET    /api/projects                        # list projects
POST   /api/projects                        # create / register (auto-discovered is implicit)
GET    /api/projects/:id                    # project detail
PATCH  /api/projects/:id                    # rename, change type, archive
DELETE /api/projects/:id                    # archive (never deletes data)

GET    /api/tickets                         # flat list, filterable
GET    /api/tickets?column=human             # the inbox query
GET    /api/tickets?project=:id              # per-project tickets
POST   /api/tickets                         # create a new ticket
GET    /api/tickets/:id                     # detail + full thread
PATCH  /api/tickets/:id                     # change title/body/priority/tags
POST   /api/tickets/:id/comments            # add a comment (or move/finding/etc)
POST   /api/tickets/:id/move                # move to another column (resets heartbeat if target is an agent)

GET    /api/project-types                   # list types
POST   /api/project-types                   # create custom
GET    /api/project-types/:id               # detail
PATCH  /api/project-types/:id               # edit columns, agents

GET    /api/agent-types                     # list
GET    /api/agent-types/:id                 # detail (including prompt)
PATCH  /api/agent-types/:id                 # edit prompt, model, tools, etc.

GET    /api/agent-runs                      # recent runs
GET    /api/agent-runs/:id                  # detail + transcript

GET    /api/config                          # daemon config
PATCH  /api/config                          # update heartbeat settings, etc.

GET    /api/health                          # daemon is alive?

POST   /api/projects/:id/wake                # manually reset heartbeat
```

All write operations are transactional in SQLite. Responses are JSON. Errors follow a consistent shape: `{ error: string, details?: object }`.

The UI uses these endpoints via `fetch`. The CLI uses these endpoints via a thin wrapper around `fetch`. No secret keys — it's localhost-only, so no auth is required. (This is explicitly a local tool; if you ever need to expose it to a network, add auth then.)

### 6.5 MCP server

Runs on the same Fastify instance, mounted at `/mcp`. Implements the Model Context Protocol so that `claude -p` can connect and use the tools declaratively instead of having to craft HTTP calls.

Exposed tools:

- `list_my_tickets(agent_type)` — returns tickets currently in the column staffed by the given agent type, for the project the agent is running against
- `read_ticket(ticket_id)` — returns the full ticket object including the complete thread
- `claim_ticket(ticket_id, run_id)` — atomically marks the ticket as `in_progress` by this run. Fails if already claimed by another run.
- `add_comment(ticket_id, type, body, meta?)` — appends a comment to the ticket
- `attach_finding(ticket_id, severity, title, body, file_refs?)` — shorthand for adding a structured finding
- `move_to_column(ticket_id, column_id, comment?)` — moves the ticket, optionally with a comment
- `release_ticket(ticket_id)` — unclaims the ticket (used if the agent can't proceed)

The agent's system prompt tells it to use these MCP tools rather than direct HTTP. The MCP server validates every call: the agent can only touch tickets in the project it was invoked for, and only tickets in its own column (or tickets it has already claimed).

### 6.6 Agent runner

A module inside the daemon. Invoked by the scheduler with `(project_id, agent_type, ticket_id)`. Its job:

1. Load the agent type config (system prompt, model, tools, permission mode, timeout)
2. Build the full system prompt:
   - Header: "You are a [agent_type] working on project [project_name]."
   - Project context: "Your CWD is [project_path]. Read CLAUDE.md in that directory for project-specific guidance."
   - Task context: "You have been assigned a ticket. Use the MCP tool `read_ticket` to see it."
   - Instructions: "Make judgment calls on ambiguity and document them. Only block on irreversible or high-stakes decisions. Blocks go to the Human column with a question comment."
   - Output format: "When done, call `move_to_column` with the appropriate next column and a summary comment."
3. Construct the `claude -p` command:
   ```
   claude -p "$PROMPT" \
     --cwd "$PROJECT_PATH" \
     --model "$MODEL" \
     --allowed-tools "$TOOLS" \
     --permission-mode "$PERMISSION_MODE" \
     --mcp-config "$MCP_CONFIG" \
     --output-format json
   ```
4. Spawn the subprocess with `child_process.spawn`. Pipe stdout/stderr to a transcript file.
5. Start a timeout timer based on the agent type's `timeout_minutes`.
6. When the process exits (or the timeout fires):
   - Update `agent_runs` with the outcome
   - If timed out, kill the subprocess tree
   - If the ticket is still claimed by this run (agent crashed or timed out before moving it), unclaim it and add a `block` comment explaining the crash
7. Notify the scheduler to re-evaluate the project's heartbeat state (since an agent finished)

### 6.7 Web UI

Served by the same Fastify instance at `http://127.0.0.1:5757/` (the root path, not `/api`). The UI is a server-rendered HTML page with htmx for interactivity. Why htmx: no framework bloat, no build step, fast iteration, easy to reason about. The design ethos is "Linode-inspired" — dark theme, sidebar nav, data tables, clean typography, subtle borders.

The UI is covered in detail in section 12.

### 6.8 CLI

Installed globally by the `npx projectdispatcher install` command. The binary is named `dispatch`. Talks to the daemon via HTTP. See section 13 for the full command list.

---

## 7. Data Model

All data lives in `~/Development/.tasks/tasks.db` (a single SQLite file).

### 7.1 Schema

```sql
-- Project types are a first-class entity, seeded on install, editable
CREATE TABLE project_types (
  id TEXT PRIMARY KEY,              -- slug, e.g., 'software-dev'
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Columns belong to project types and define their workflow
CREATE TABLE project_type_columns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_type_id TEXT NOT NULL REFERENCES project_types(id) ON DELETE CASCADE,
  column_id TEXT NOT NULL,          -- e.g., 'human', 'coding-agent', 'done'
  name TEXT NOT NULL,
  agent_type_id TEXT REFERENCES agent_types(id),  -- null for Human and Done
  "order" INTEGER NOT NULL,
  UNIQUE (project_type_id, column_id)
);

-- Agent types define how agents behave
CREATE TABLE agent_types (
  id TEXT PRIMARY KEY,              -- slug, e.g., 'coding-agent'
  name TEXT NOT NULL,
  description TEXT,
  system_prompt_path TEXT NOT NULL, -- relative to ~/Development/.tasks/prompts/
  model TEXT NOT NULL,              -- 'claude-opus-4-6', 'claude-sonnet-4-6', etc.
  allowed_tools TEXT NOT NULL,      -- JSON array of tool names
  permission_mode TEXT NOT NULL,    -- 'default', 'acceptEdits', 'bypassPermissions', 'plan'
  timeout_minutes INTEGER NOT NULL DEFAULT 30,
  max_retries INTEGER NOT NULL DEFAULT 0,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Projects are folders under ~/Development/
CREATE TABLE projects (
  id TEXT PRIMARY KEY,              -- UUID
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,        -- absolute filesystem path
  project_type_id TEXT NOT NULL REFERENCES project_types(id),
  status TEXT NOT NULL DEFAULT 'active',  -- active, dormant, missing, archived
  last_activity_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Heartbeat state per project (separate table for clarity)
CREATE TABLE project_heartbeats (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  next_check_at INTEGER NOT NULL,       -- unix ms timestamp
  consecutive_empty_checks INTEGER NOT NULL DEFAULT 0,
  last_wake_at INTEGER,
  last_work_found_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- Tickets are the unit of work
CREATE TABLE tickets (
  id TEXT PRIMARY KEY,              -- UUID
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT,
  column TEXT NOT NULL,             -- matches a project_type_columns.column_id
  priority TEXT NOT NULL DEFAULT 'normal',  -- low, normal, high, urgent
  tags TEXT,                        -- JSON array
  claimed_by_run_id TEXT,           -- if non-null, an agent is actively working on it
  claimed_at INTEGER,
  created_by TEXT NOT NULL DEFAULT 'human',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Threaded history of everything that has happened to a ticket
CREATE TABLE ticket_comments (
  id TEXT PRIMARY KEY,              -- UUID
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  type TEXT NOT NULL,               -- comment, move, claim, complete, finding, journal, block, chat_summary
  author TEXT NOT NULL,             -- 'human' or 'agent:<agent_type>:<run_id>'
  body TEXT,
  meta TEXT,                        -- JSON, type-specific (severity, from_column, to_column, etc.)
  created_at INTEGER NOT NULL
);

-- Every agent invocation is recorded
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,              -- UUID
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  agent_type_id TEXT NOT NULL REFERENCES agent_types(id),
  model TEXT NOT NULL,              -- snapshot at invocation time
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  exit_status TEXT,                 -- running, success, timeout, crashed, blocked
  transcript_path TEXT,             -- path to captured stdout/stderr
  cost_estimate_cents INTEGER,      -- optional
  error_message TEXT
);

-- Daemon-level config (key-value store)
CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,              -- JSON
  updated_at INTEGER NOT NULL
);
```

### 7.2 Indexes

```sql
CREATE INDEX idx_tickets_project_column ON tickets (project_id, column);
CREATE INDEX idx_tickets_column ON tickets (column);  -- for the inbox query
CREATE INDEX idx_tickets_updated ON tickets (updated_at DESC);
CREATE INDEX idx_ticket_comments_ticket ON ticket_comments (ticket_id, created_at);
CREATE INDEX idx_agent_runs_ticket ON agent_runs (ticket_id);
CREATE INDEX idx_projects_status ON projects (status);
CREATE INDEX idx_project_heartbeats_next_check ON project_heartbeats (next_check_at);
```

### 7.3 Invariants

- A ticket's `column` must match a column defined for its project's type (enforced at write time, not via FK because columns are defined per type and referenced by slug for portability)
- A ticket can only be claimed by one run at a time — `claimed_by_run_id` is either null or the run that owns it. Atomic updates on claim/release.
- `agent_runs.exit_status` starts as `running` and is updated to a terminal state (`success`, `timeout`, `crashed`, `blocked`) when the subprocess exits.
- `ticket_comments` is append-only. Never updated, never deleted.

---

## 8. Project Types (built-in library)

Seeded on install. Users can edit them, add new ones, or delete any that aren't used. Built-in types are marked `is_builtin = 1` in the database as a protection against accidental deletion (user can still override).

### 8.1 `software-dev`

**Description:** Standard software development project with code, reviews, and security audit.

**Columns:**

| Order | Column ID | Name | Agent Type |
|-------|-----------|------|-----------|
| 0 | `human` | Human | — |
| 1 | `coding-agent` | Coding Agent | `coding-agent` |
| 2 | `code-reviewer` | Code Review | `code-reviewer` |
| 3 | `security-reviewer` | Security Review | `security-reviewer` |
| 4 | `done` | Done | — |

**Typical flow:** Human files a feature ticket → Coding Agent builds it → Code Reviewer checks for quality → Security Reviewer checks for vulnerabilities → Human signs off → Done.

### 8.2 `vps-maintenance`

**Description:** Server and infrastructure maintenance with operations and auditing.

**Columns:**

| Order | Column ID | Name | Agent Type |
|-------|-----------|------|-----------|
| 0 | `human` | Human | — |
| 1 | `sysadmin` | Sysadmin | `sysadmin` |
| 2 | `security-auditor` | Security Audit | `security-auditor` |
| 3 | `done` | Done | — |

**Typical flow:** Human files "check disk usage" or "update packages" → Sysadmin SSHes in, runs the checks, reports back → Security Auditor double-checks if the action has security implications → Human signs off → Done.

### 8.3 `content`

**Description:** Writing and editorial workflow for blog posts, documentation, marketing copy.

**Columns:**

| Order | Column ID | Name | Agent Type |
|-------|-----------|------|-----------|
| 0 | `human` | Human | — |
| 1 | `writer` | Writer | `writer` |
| 2 | `editor` | Editor | `editor` |
| 3 | `done` | Done | — |

### 8.4 `research`

**Description:** Information gathering and summarization.

**Columns:**

| Order | Column ID | Name | Agent Type |
|-------|-----------|------|-----------|
| 0 | `human` | Human | — |
| 1 | `researcher` | Researcher | `researcher` |
| 2 | `done` | Done | — |

### 8.5 `personal`

**Description:** No agents — just a personal ticket tracker. For work you plan to do yourself but want to remember.

**Columns:**

| Order | Column ID | Name | Agent Type |
|-------|-----------|------|-----------|
| 0 | `human` | Backlog | — |
| 1 | `in-progress` | In Progress | — |
| 2 | `done` | Done | — |

No agent columns. The human moves tickets manually. Useful for projects where you want to track state but don't want to involve AI.

---

## 9. Agent Types (built-in library)

Each agent type has a default system prompt (editable), default model, tool allowlist, permission mode, and timeout. Seeded on install at `~/Development/.tasks/prompts/<agent-type>.md`.

### 9.1 `coding-agent`

**Purpose:** Writes and modifies code. The primary worker for software-dev projects.

| Field | Default |
|-------|---------|
| Model | `claude-opus-4-6` |
| Tools | `Read, Edit, Write, Bash, Grep, Glob, Task` |
| Permission mode | `bypassPermissions` (YOLO) |
| Timeout | 60 minutes |

**System prompt (abbreviated):**
> You are a coding agent working on a software project. Your CWD is the project root. Read CLAUDE.md first to understand the project's architecture, conventions, and constraints. You have been assigned a ticket via the MCP server. Call `read_ticket` to see it. Complete the work described in the ticket. Commit and push your changes with clear commit messages. When done, add a comment summarizing what you did (including commit SHAs) and move the ticket to the next column (typically `code-reviewer`). Make judgment calls on ambiguity and document them in journal comments. Only block on irreversible decisions, missing secrets, or questions that require human judgment — blocks go to the Human column with a question.

### 9.2 `code-reviewer`

**Purpose:** Reviews code quality, architecture, correctness. Does not write code.

| Field | Default |
|-------|---------|
| Model | `claude-opus-4-6` |
| Tools | `Read, Grep, Glob, Bash` (read-only; Bash for running tests) |
| Permission mode | `default` |
| Timeout | 30 minutes |

**System prompt (abbreviated):**
> You are a senior code reviewer. You read code and produce findings. You do not write code. Read CLAUDE.md to understand the project's standards. Read the ticket to see what changed (usually committed as commits linked in the ticket thread). Review the changes for: correctness, security, maintainability, consistency with project conventions, missing tests, obvious bugs. Produce findings with severity: CRITICAL (must fix before merge), HIGH (should fix soon), MEDIUM (worth addressing), LOW (cosmetic). Attach findings via `attach_finding`. When done: if any CRITICAL or HIGH findings, move the ticket back to `coding-agent`. If all findings are MEDIUM or lower (or none), move forward to `security-reviewer`. Add a summary comment either way.

### 9.3 `security-reviewer`

**Purpose:** Reviews code for security vulnerabilities and server config changes for hardening regressions.

| Field | Default |
|-------|---------|
| Model | `claude-opus-4-6` |
| Tools | `Read, Grep, Glob, Bash` (Bash for SSH audits and running security scans) |
| Permission mode | `default` |
| Timeout | 45 minutes |

**System prompt (abbreviated):**
> You are a security reviewer. You read code and configurations, and produce security findings. Focus areas: authentication, authorization (IDOR, privilege escalation), input validation, SQL injection, XSS, CSRF, secret handling, dependency CVEs, server hardening, exposed surfaces, rate limiting, error message leakage, audit logging. Read CLAUDE.md for the project's security posture. Use severity: CRITICAL (fix before ship), HIGH (fix soon), MEDIUM (should address), LOW (defense-in-depth). When done, move to `done` if clean or back to `coding-agent` for remediation. OWASP Top 10 is the minimum checklist. Always explain your reasoning — don't just flag, explain why it matters.

### 9.4 `sysadmin`

**Purpose:** Executes server administration tasks. Runs commands, makes config changes, deploys.

| Field | Default |
|-------|---------|
| Model | `claude-sonnet-4-6` |
| Tools | `Read, Edit, Write, Bash, Grep, Glob` |
| Permission mode | `bypassPermissions` |
| Timeout | 45 minutes |

**System prompt (abbreviated):**
> You are a sysadmin working on a server maintenance project. Your CWD is a project folder that contains notes, inventory, and perhaps credentials. Read CLAUDE.md to understand the environment — which servers, what roles, what's been changed recently. The ticket tells you what to do. You have Bash with SSH access. Execute the task carefully. Before destructive operations (dropping data, deleting files, restarting critical services), add a journal comment explaining what you're about to do and why. After the work, summarize what changed and attach any relevant output. If you can't complete the task (missing credentials, unclear scope, destructive decision), block to Human. Do not skip hardening steps — if you disable something temporarily, leave a note to re-enable it.

### 9.5 `security-auditor`

**Purpose:** Audits server state for hardening, CVEs, misconfigurations. Read-heavy.

| Field | Default |
|-------|---------|
| Model | `claude-sonnet-4-6` |
| Tools | `Read, Grep, Bash` |
| Permission mode | `default` |
| Timeout | 30 minutes |

**System prompt (abbreviated):**
> You are a security auditor. You inspect server state and configurations, produce findings, and suggest remediations. You do not make changes yourself. Run read-only Bash commands (SSH to the target, run `ss`, `systemctl list-units`, `auditctl -l`, `cat /etc/...`, etc.). Check: open ports, running services, user privileges, file permissions, SSH config, firewall rules, fail2ban status, log rotation, package versions, known CVEs, swap encryption. Produce findings by severity. When done, move the ticket back to Human or to the `sysadmin` column for remediation, depending on the workflow.

### 9.6 `writer`

**Purpose:** Drafts long-form content — blog posts, docs, marketing copy.

| Field | Default |
|-------|---------|
| Model | `claude-sonnet-4-6` |
| Tools | `Read, Write, WebFetch` |
| Permission mode | `acceptEdits` |
| Timeout | 30 minutes |

**System prompt (abbreviated):**
> You are a writer. You draft content based on the ticket's brief. Read CLAUDE.md for voice, style guide, and conventions. Write a first draft to a file in the project directory. Add a comment to the ticket with the file path, a summary of the approach, and any open questions. Move to `editor` when ready. If the brief is unclear, ask questions by blocking to Human.

### 9.7 `editor`

**Purpose:** Edits, proofreads, improves drafts.

| Field | Default |
|-------|---------|
| Model | `claude-sonnet-4-6` |
| Tools | `Read, Edit, WebFetch` |
| Permission mode | `acceptEdits` |
| Timeout | 30 minutes |

**System prompt (abbreviated):**
> You are an editor. You read drafts and improve them: fix grammar, tighten prose, check facts, improve structure, match the voice guide in CLAUDE.md. Edit the file in place. In your summary comment, list the types of changes you made and flag anything you weren't sure about. Move the ticket to Human for final approval.

### 9.8 `deployer`

**Purpose:** Executes deployments. Runs CI, monitors health checks, rolls back on failure.

| Field | Default |
|-------|---------|
| Model | `claude-sonnet-4-6` |
| Tools | `Bash, Read, Grep` |
| Permission mode | `bypassPermissions` |
| Timeout | 30 minutes |

**System prompt (abbreviated):**
> You are a deployer. Your job is to deploy the project's current state to its production environment. Read CLAUDE.md for the deploy procedure. Execute it. Monitor the health check after deploy. If the health check fails, roll back and report the error. If successful, post the deploy confirmation and move to Done. Always capture the deploy log and attach it to the ticket. Do not proceed if the working tree is dirty, if there are uncommitted changes, or if CI has not passed.

### 9.9 `researcher`

**Purpose:** Gathers information, summarizes findings. No writing beyond summary documents.

| Field | Default |
|-------|---------|
| Model | `claude-haiku-4-5-20251001` |
| Tools | `Read, Write, WebFetch, WebSearch` |
| Permission mode | `acceptEdits` |
| Timeout | 20 minutes |

**System prompt (abbreviated):**
> You are a researcher. Given a research question in the ticket, gather information from the web and internal project notes, synthesize a summary, and write it to a file in the project folder. Your output should be: a summary (3-5 paragraphs), a list of sources, and any open questions the user should decide on. Do not make recommendations beyond what the research supports. Move to Human when done.

---

## 10. Heartbeat and Scheduling

### 10.1 The rules

Heartbeat is per-project. It controls when the scheduler wakes up agents in that project to check their columns.

**Base interval:** 5 minutes when a project is active.

**Backoff:** After each wake-up that finds nothing to do (all agent columns empty), the interval doubles. Sequence: 5, 10, 20, 40, 80, 160, 320, 640, 1280, 1440 (capped at 24 hours). After cap is reached, stays at 24-hour interval until reset.

**Reset to 5 minutes triggers:**

1. **Human assigns a ticket to an agent column.** This is an explicit start-work action. The only human interaction that resets the heartbeat.
2. **An agent wakes up and finds work in its column.** When this happens, the project's heartbeat state resets to 5 min and all agents in the project cascade to 5-min intervals. This ensures that once work starts flowing, every agent downstream wakes up quickly.

**Does NOT reset:**

- Human opens the project board (read-only browsing)
- Human creates a ticket but leaves it in `Human` column (not yet started work)
- Human comments on an existing ticket
- Agent wakes up and finds column empty (this is the backoff trigger, not a reset)
- Filesystem events (a file changes in the project folder)

### 10.2 State machine

```
┌─────────────┐
│  5-min      │◄─── Human assigns ticket to agent column
│  active     │◄─── Agent wakes up and finds work
│             │
└──────┬──────┘
       │ heartbeat fires
       │ agents all empty
       ▼
┌─────────────┐
│  10-min     │
└──────┬──────┘
       │ empty again
       ▼
┌─────────────┐
│  20-min     │
└──────┬──────┘
       │ ...
       ▼
   ┌────────┐
   │  24-hr │  (cap — stays here until reset trigger)
   │  dormant│
   └────────┘
```

### 10.3 Implementation

The scheduler maintains an in-memory `Map<ProjectId, NodeJS.Timeout>` of active timers. On daemon startup, it reads `project_heartbeats` from the database and schedules a timer for each project based on `next_check_at`.

Pseudocode for the scheduler:

```typescript
function scheduleProject(projectId: string) {
  const hb = db.getHeartbeat(projectId);
  const delayMs = Math.max(0, hb.nextCheckAt - Date.now());

  const timer = setTimeout(() => {
    handleHeartbeat(projectId);
  }, delayMs);

  timers.set(projectId, timer);
}

function handleHeartbeat(projectId: string) {
  const agentColumns = getAgentColumnsForProject(projectId);
  let foundWork = false;

  for (const col of agentColumns) {
    const tickets = db.getUnclaimedTickets(projectId, col.id);
    if (tickets.length > 0) {
      foundWork = true;
      for (const ticket of tickets) {
        agentRunner.run(projectId, col.agent_type_id, ticket.id);
      }
    }
  }

  if (foundWork) {
    // Cascade: reset to 5-min active
    db.updateHeartbeat(projectId, {
      nextCheckAt: Date.now() + 5 * 60 * 1000,
      consecutiveEmptyChecks: 0,
    });
  } else {
    // Backoff: double the interval (up to the cap)
    const hb = db.getHeartbeat(projectId);
    const newEmptyChecks = hb.consecutiveEmptyChecks + 1;
    const newIntervalMs = Math.min(
      5 * 60 * 1000 * Math.pow(2, newEmptyChecks),
      24 * 60 * 60 * 1000
    );
    db.updateHeartbeat(projectId, {
      nextCheckAt: Date.now() + newIntervalMs,
      consecutiveEmptyChecks: newEmptyChecks,
    });
  }

  scheduleProject(projectId); // reschedule for next heartbeat
}

function onHumanAssignsTicket(projectId: string) {
  // Explicit work start — reset to 5min
  clearTimeout(timers.get(projectId));
  db.updateHeartbeat(projectId, {
    nextCheckAt: Date.now() + 5 * 60 * 1000,
    consecutiveEmptyChecks: 0,
  });
  scheduleProject(projectId);
}
```

Resetting the heartbeat requires clearing the existing timer and rescheduling. All heartbeat operations go through a lock to avoid race conditions if multiple events fire at once.

### 10.4 Edge cases

- **Daemon crashes mid-heartbeat:** on restart, any in-flight agent runs are marked `crashed` and their tickets are released. Heartbeats resume from the `next_check_at` stored in the database.
- **Multiple tickets in a column on wake:** the agent runner spawns one subprocess per ticket (bounded by a concurrency limit, e.g., max 3 concurrent agent runs per project). Tickets are queued if over the limit.
- **Project deleted from disk:** the watcher detects the missing folder, marks the project `missing`. Heartbeats pause. Tickets are preserved; user can either archive the project or restore the folder.
- **Project folder renamed:** watcher can't automatically handle this. The old project becomes `missing` and a new project appears. User resolves by editing the project's `path` in the UI.

---

## 11. Agent Runtime

### 11.1 How `claude -p` is invoked

The agent runner builds a command like:

```bash
claude -p "$FULL_SYSTEM_PROMPT" \
  --cwd "/Users/david/Development/HandyManagerHub" \
  --model "claude-opus-4-6" \
  --allowed-tools "Read,Edit,Write,Bash,Grep,Glob" \
  --permission-mode "bypassPermissions" \
  --mcp-config "/Users/david/Development/.tasks/mcp-config.json" \
  --output-format "stream-json"
```

The subprocess inherits the user's environment (so `claude` finds its own credentials). stdout is captured to the transcript file. stderr is interleaved for debugging.

### 11.2 System prompt construction

The agent runner builds the full prompt by concatenating:

1. **Role prefix:** `"You are a [agent_type.name] working on project [project.name]."`
2. **The agent type's system prompt** from `~/Development/.tasks/prompts/<agent_type_id>.md` (user-editable)
3. **Project context:** `"Your CWD is [project.path]. Read CLAUDE.md first."`
4. **Ticket context:** `"Use the MCP tool `read_ticket` with ticket_id=[ticket.id] to see your assigned work. The ticket is currently in the '[column.name]' column of the '[project.name]' project."`
5. **Output instructions:** `"When done, call `move_to_column` with the appropriate next column slug and attach a summary comment. Blocks go to the 'human' column with a question comment."`

The agent type's prompt is the editable part. The framing prefix and suffix are added by the runner. This keeps the user-editable prompts focused on "what to do" without worrying about "how to report."

### 11.3 Tool allowlists per agent type

Built-in defaults per agent type (see section 9). The user can edit these through the UI's agent type editor. The allowlist is passed to `claude -p` via `--allowed-tools`.

Agents cannot escape their allowlist. If `Bash` is not allowed, `claude -p` will refuse to execute Bash even if the system prompt asks for it.

### 11.4 Permission modes

Claude Code has four permission modes:

- `default` — prompts for each tool use (unusable for headless)
- `acceptEdits` — auto-accepts file edits, prompts for other tools
- `bypassPermissions` — YOLO, auto-accepts everything (use for coding / sysadmin / deploy)
- `plan` — creates a plan but doesn't execute (not useful for agents that need to actually do work)

For Project Dispatcher, the usable modes are `acceptEdits` (for writer / editor / researcher) and `bypassPermissions` (for coding-agent / sysadmin / deployer). Reviewers (code-reviewer, security-reviewer, security-auditor) can use `default` safely because they shouldn't be making changes — if they try to edit, the permission prompt will just reject it and the agent will continue with other work.

### 11.5 Timeouts

Each agent type has a `timeout_minutes`. The runner starts a timer when the subprocess spawns. When the timer fires, it sends SIGTERM to the subprocess. If the process doesn't exit within 10 seconds, SIGKILL. The transcript is flushed, `agent_runs.exit_status` is set to `timeout`, the ticket is unclaimed with a block comment.

Timeouts are intentionally generous (30-60 minutes) because real work takes real time. They exist to catch runaway loops and to prevent a stuck subprocess from holding a ticket forever.

### 11.6 Transcript capture

Every agent run writes its full output (stdout + stderr, with stream-json format) to `~/Development/.tasks/artifacts/runs/<run_id>.log`. This is for audit and debugging — you can replay an agent's reasoning after the fact. For normal operation, the ticket comments are the user-facing record; transcripts are a developer/debug surface.

### 11.7 Failure handling

If the subprocess exits non-zero or crashes:

- `agent_runs.exit_status` = `crashed`
- `agent_runs.error_message` = exit code and last line of stderr
- The ticket is automatically released from the claim
- A `block` comment is added to the ticket with the crash details
- The ticket is moved back to the `Human` column

Retries are not automatic in V1 — a human sees the block and decides whether to retry or adjust. This is intentional: silent retries can mask systemic problems.

### 11.8 Concurrency limits

Max concurrent agent runs per project: 3 (configurable in `config` table).
Max concurrent agent runs globally: 10 (configurable).

This prevents a runaway scenario where 50 tickets in a column spawn 50 parallel Claude processes. Over the limit, tickets queue and are picked up on the next heartbeat.

---

## 12. UI/UX Specification

### 12.1 Design reference

Linode Cloud Manager (cloud.linode.com). Dark theme, left sidebar navigation, clean data tables, subtle borders, generous spacing. The screenshots in this project's reference materials show the aesthetic: dark navy background, slightly lighter panels, status pills with colored dots, sortable columns, right-aligned actions, breadcrumbs, blue primary CTAs.

### 12.2 Color palette

Inspired by Linode and tuned for dark mode:

```
Background (page):        #0E1117   (near-black navy)
Background (panel):       #161B22   (slightly lighter)
Background (elevated):    #1C2128   (cards, modals)
Border (subtle):          #2A303A
Border (strong):          #3A424F

Text (primary):           #F0F6FC   (near-white)
Text (secondary):         #8B949E
Text (tertiary):          #6E7681

Primary (accent):         #3B82F6   (blue — CTAs, links, active nav)
Primary (hover):          #2563EB
Primary (pressed):        #1D4ED8

Success:                  #22C55E   (green — status "running", "done")
Warning:                  #EAB308   (amber — status "pending")
Danger:                   #EF4444   (red — errors, destructive actions)
Info:                     #06B6D4   (cyan — informational)

Priority indicators:
  Urgent:                 #EF4444
  High:                   #F97316
  Normal:                 #6E7681
  Low:                    #4B5563
```

### 12.3 Typography

```
Sans-serif:  "Inter", -apple-system, system-ui, sans-serif
Mono:        "JetBrains Mono", "SF Mono", Consolas, monospace

Font sizes:
  xs:    12px   (labels, metadata)
  sm:    14px   (body text, table rows)
  base:  16px   (default)
  lg:    18px   (section headers)
  xl:    24px   (page titles)
  2xl:   32px   (dashboard stats)

Line height: 1.5 for body, 1.25 for headings
```

### 12.4 Layout

```
┌─────────────────────────────────────────────────────────────┐
│  ┃ Project Dispatcher          [ search ]       🔔 🔍 [👤] │ ← top bar
│  ┃                                                          │
│  ┣─ DASHBOARD     │                                         │
│  ┃   Inbox (3)    │                                         │
│  ┃   Projects     │                                         │
│  ┃                │            MAIN CONTENT                 │
│  ┣─ PROJECTS      │                                         │
│  ┃   HMH          │                                         │
│  ┃   VPS Maint.   │                                         │
│  ┃   Blog         │                                         │
│  ┃                │                                         │
│  ┣─ AGENT TYPES   │                                         │
│  ┃   Coding Agent │                                         │
│  ┃   Code Reviewer│                                         │
│  ┃   ...          │                                         │
│  ┃                │                                         │
│  ┗─ SETTINGS      │                                         │
└─────────────────────────────────────────────────────────────┘
```

Left sidebar is fixed-width (~240px), collapsible to icon-only (~64px). Sidebar sections: Dashboard (Inbox, Projects), Projects (list of individual projects, expanded), Agent Types (editable prompt library), Settings. Active item has a colored bar on the left and a lighter background.

Main content area respects breadcrumbs at top, title with optional action buttons aligned right, then the primary content (inbox table, project board, ticket detail, etc.).

### 12.5 Primary view: Inbox

The landing page. Flat list of every ticket currently in a `Human` column across all projects.

```
Inbox                                         3 waiting   [ + New ticket ]
────────────────────────────────────────────────────────────────────────
Project        Title                                           Age   Priority
────────────────────────────────────────────────────────────────────────
[HMH]          Payment screens — 2 findings to review          3h    ● Normal
[VPS]          Question: OK to upgrade Rocky Linux kernel?     1d    ● High
[HMH]          Quote send flow deployed, ready for signoff     2d    ● Normal
```

Clicking a row expands a detail pane on the right (or navigates to the ticket detail view). Columns are sortable. Filter bar supports: project, priority, tag, age.

### 12.6 Secondary view: Projects list

List of all projects (cards or rows) with status summary.

```
Projects                                              [ + Register project ]
─────────────────────────────────────────────────────────────────────────
Name              Type             Tickets   In Prog.  Heartbeat  Last Activity
─────────────────────────────────────────────────────────────────────────
HandyManagerHub   software-dev       8          3      🔵 5min    2h ago
VPS Maintenance   vps-maintenance    2          0      🟡 20min   1d ago
Blog              content            5          1      🟢 dormant  1w ago
Kitchen Reno      personal           3          0      ⚫ n/a     3w ago
```

Heartbeat icon shows the current state (blue = active 5min, yellow = backing off, green = dormant 24h, black = no agents). Clicking a project opens its board.

### 12.7 Per-project board

Full Kanban for one project.

```
HandyManagerHub  ▸ Board                                  [ + New ticket ]
software-dev  ·  heartbeat: 5min  ·  [ wake ] [ settings ]
────────────────────────────────────────────────────────────────────────
 Human (2)       Coding Agent    Code Review     Sec Review    Done
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────┐ ┌──────┐
│ Payment fail │ │ Reminder     │ │              │ │          │ │ ...  │
│ ● High 3h    │ │ settings     │ │              │ │          │ │      │
└──────────────┘ │ ● Normal 1h  │ │              │ │          │ └──────┘
┌──────────────┐ └──────────────┘                                        
│ Review design│                                                          
│ ● Normal 2d  │                                                          
└──────────────┘                                                          
```

Drag-and-drop between columns. Columns are colored subtly to distinguish agent columns from human columns. Each ticket card shows title, priority dot, age, and a tiny indicator if an agent is actively working on it.

### 12.8 Ticket detail

A single ticket with the full thread.

```
HandyManagerHub  ▸  HMH-427  ▸  Payment screens — 2 findings to review
● High priority    Code Review → Human    Created 3 days ago
────────────────────────────────────────────────────────────────────────
You • 3 days ago                                               [edit]
Build the payment collection screens per HAN-9-payment.md.
Stripe code is server-side, just need the UI.

→ assigned to Coding Agent

Coding Agent • 2 days ago                   [run-abc123, opus-4-6, 45m]
Built Tap to Pay, Send Payment Link, and Manual flows.
Files changed:
- apps/mobile/app/payment/tap-to-pay.tsx (new)
- apps/mobile/app/payment/send-link.tsx (new)
- apps/mobile/app/payment/manual.tsx (new)
Commits: a1b2c3d, e4f5g6h
Tested locally with stub keys. Ready for review.

→ moved to Code Reviewer

Code Reviewer • 1 day ago                   [run-def456, opus-4-6, 12m]
FINDINGS:
- HIGH: Payment amount in cents not validated client-side
  (apps/mobile/app/payment/tap-to-pay.tsx:42)
- MEDIUM: Loading state missing on Tap to Pay button
  (apps/mobile/app/payment/tap-to-pay.tsx:89)
Otherwise well-structured. Recommend addressing HIGH before merge.

→ moved to Human

────────────────────────────────────────────────────────────────────────
YOU
[  Send back to Coding Agent with these comments?                     ]
[                                                                     ]
[                                                                     ]

[Send to Coding Agent] [Approve to Security] [Override to Done] [Save]
```

The thread is scrollable. Each entry has the author, timestamp, run metadata (if applicable), and body. The human always has action buttons at the bottom: quick-reply, move-to-column, or save-as-draft.

### 12.9 Navigation patterns

- Click project name anywhere → opens that project's board
- Click ticket title anywhere → opens that ticket's detail
- Click agent type in sidebar → opens the agent type editor (prompt, model, tools)
- Breadcrumbs at the top of every page show the hierarchy (Project > Ticket > thread entry)
- Back button in the browser works as expected

### 12.10 Keyboard shortcuts (post-V1)

```
j / k        next / prev ticket (inbox)
Enter        open selected ticket
c            new ticket
m            move ticket (opens column picker)
r            reply
a            approve (move to next column)
b            send back (move to previous column)
/            focus search
?            show shortcut help
esc          close detail pane
```

Not MVP but the data model supports it without changes.

---

## 13. CLI Specification

The CLI is named `dispatch`. Installed to `/usr/local/bin/dispatch` (or wherever `npm` puts global bins). Talks to the daemon over HTTP.

### 13.1 Install and setup

```bash
npx projectdispatcher install
  # Interactive: asks for confirmation, creates ~/.tasks/, installs daemon,
  # opens UI in browser.

dispatch daemon status
  # Shows whether the daemon is running, its uptime, its memory.

dispatch daemon restart
  # Restart the daemon (via launchctl / systemctl / sc).

dispatch daemon logs [--follow] [--lines N]
  # Stream the daemon log file.
```

### 13.2 Projects

```bash
dispatch projects list
  # List all projects with status.

dispatch projects show <name>
  # Show details and the board for a specific project.

dispatch projects register <path> --type <type-id>
  # Explicitly register a folder as a project (normally auto-discovered).

dispatch projects archive <name>
  # Archive a project (tickets preserved, no more heartbeats).

dispatch wake [project]
  # Reset heartbeat to 5 min for a specific project (or all projects).
```

### 13.3 Tickets

```bash
dispatch ticket new
  # Interactive: prompts for project, title, body, column.

dispatch ticket new --project HMH --title "Add payment screens" \
  --body "Build the payment collection UI" --column coding-agent
  # Non-interactive, scriptable.

dispatch ticket list [--project X] [--column Y]
  # List tickets, filterable.

dispatch ticket show <id>
  # Show full thread for a ticket.

dispatch ticket comment <id> "<text>"
  # Add a comment to a ticket.

dispatch ticket move <id> <column>
  # Move a ticket to another column.
```

### 13.4 Status

```bash
dispatch status
  # Quick summary: inbox count, active projects, recent activity.

dispatch inbox
  # Print the inbox as a table.
```

### 13.5 Configuration

```bash
dispatch config show
dispatch config set <key> <value>
dispatch config edit
  # Opens the config file in $EDITOR.

dispatch agent-type list
dispatch agent-type show <id>
dispatch agent-type edit <id>
  # Opens the prompt file in $EDITOR.
```

### 13.6 Web UI

```bash
dispatch board [project]
  # Opens http://localhost:5757/ in the default browser,
  # optionally deep-linked to a specific project.
```

---

## 14. Installation and Packaging

### 14.1 The one-line install

```bash
cd ~/Development && npx projectdispatcher install
```

This command:

1. Detects the operating system (macOS, Linux, Windows)
2. Verifies `~/Development/` exists and is writable
3. Creates `~/Development/.tasks/` with subdirectories: `prompts/`, `logs/`, `artifacts/`
4. Initializes the SQLite database with the schema
5. Seeds the built-in project types and agent types
6. Writes default agent prompt files to `~/Development/.tasks/prompts/`
7. Installs the daemon as an auto-start service:
   - **macOS:** writes `~/Library/LaunchAgents/com.projectdispatcher.daemon.plist`, runs `launchctl load`
   - **Linux:** writes `~/.config/systemd/user/projectdispatcher.service`, runs `systemctl --user enable --now`
   - **Windows:** installs via `nssm` or Windows Service Manager
8. Adds `dispatch` to the user's PATH (creates a global npm link)
9. Waits for the daemon to become healthy
10. Auto-discovers projects under `~/Development/` and seeds them as `unregistered` (user picks a type in the UI)
11. Opens `http://localhost:5757` in the default browser

If anything fails, the installer rolls back cleanly: removes the service, deletes `~/Development/.tasks/`, unlinks the binary.

### 14.2 Platform support

**macOS:** primary platform, fully supported. LaunchAgent for daemon auto-start. Tested on macOS 14+.

**Linux:** systemd user units. Tested on Ubuntu 22.04+, Fedora 40+, Rocky 9+. Requires `systemd --user` to be available (it usually is on modern distros).

**Windows:** supported but second-priority. Daemon runs as a Windows Service via `node-windows` or `nssm`. Paths use `%USERPROFILE%\Development\` instead of `~/Development/`.

All three platforms run the same Node.js codebase. Node 20+ required.

### 14.3 Updates

```bash
dispatch update
  # Checks npm for a newer version. If found, downloads, stops daemon,
  # migrates database (if needed), restarts daemon.
```

Updates are append-only for the database: new migrations never delete columns. Downgrade is manual (restore from a backup of `tasks.db`).

### 14.4 Uninstall

```bash
dispatch uninstall
  # Confirms, then:
  # - Stops and removes the daemon service
  # - Unlinks the `dispatch` binary
  # - Optionally deletes ~/Development/.tasks/ (asks first)
```

`npx projectdispatcher uninstall` as a fallback if the `dispatch` CLI is already gone.

---

## 15. Security Model

### 15.1 Local-only

Project Dispatcher is a single-user, single-machine tool. The HTTP server binds to `127.0.0.1`, not `0.0.0.0`. There is no authentication because there is no remote access. If you want to use it remotely, set up an SSH tunnel; do not bind it to a network interface.

### 15.2 Credential handling

The daemon does not store any credentials. It relies entirely on the `claude` CLI having its own credentials configured (the user has already logged in via `claude login` before using Project Dispatcher). Agent subprocesses inherit the user's environment and home directory, so they can find and use the Claude credentials natively.

Project-specific credentials (e.g., SSH keys for a VPS maintenance project) live in the user's `~/.ssh/` and are available to agents through the environment. The platform does not manage them.

### 15.3 YOLO mode boundaries

Agents running with `bypassPermissions` (YOLO mode) can read, write, and execute anything the user can. This is intentional — it's how coding agents, sysadmins, and deployers get their work done. The safeguards are:

- **Scoped CWD.** Every agent runs with its project directory as CWD. The agent can navigate outside via `cd ..`, but the system prompt tells it not to.
- **Tool allowlist.** An agent that doesn't have `Bash` in its allowlist cannot execute shell commands. An agent without `Write` cannot modify files.
- **Timeouts.** Runaway loops are bounded by the timeout.
- **Audit trail.** Every action is captured in the transcript.
- **Reviewers don't YOLO.** Code reviewers and security reviewers run in `default` mode — they can read but not write.
- **Human in the loop on criticals.** The default agent prompts say "block on irreversible decisions" — deletes, drops, deploys without CI, etc. These come back to Human.

If an agent misbehaves, the worst case is damage to a single project directory plus anything the user could damage themselves. Blast radius is limited to the user's own machine.

### 15.4 Audit trail

Every agent run produces:

- A row in `agent_runs` (start time, end time, exit status, model, cost)
- A transcript file at `~/Development/.tasks/artifacts/runs/<run_id>.log`
- Comments on the ticket that the agent worked on

For any action an agent took, you can find: which run did it, when, which model, with what prompt, and what the full Claude output was. This is enough for debugging and for trust.

Transcripts are kept for 30 days by default (configurable). Old transcripts are deleted by a nightly cleanup job. The `agent_runs` row is kept indefinitely.

### 15.5 What Project Dispatcher does NOT protect against

- **A malicious prompt in a project's CLAUDE.md.** If you clone a repo with a CLAUDE.md that tells agents to do malicious things, agents will read it and potentially act on it. Treat CLAUDE.md as executable code. Only register projects whose source you trust.
- **A compromised `claude` binary.** Project Dispatcher trusts the `claude` CLI. If you install a malicious version, the platform can't help.
- **Physical access to the machine.** Tickets are stored in cleartext in SQLite. Credentials are wherever they normally live (`~/.ssh/`, keychain, etc.). If someone has root on your machine, they have everything.
- **Side-channel attacks** via shared CPU / network. Not in scope for a local dev tool.

---

## 16. Storage and Persistence

### 16.1 File layout

```
~/Development/                         # install root
└── .tasks/                            # orchestrator data (hidden)
    ├── tasks.db                       # SQLite, all state
    ├── tasks.db-shm                   # SQLite shared memory (transient)
    ├── tasks.db-wal                   # SQLite write-ahead log
    ├── config.json                    # daemon config (loaded at startup)
    ├── mcp-config.json                # MCP server config for agents
    ├── daemon.pid                     # PID of the running daemon
    ├── daemon.sock                    # Unix socket for local IPC (macOS/Linux)
    ├── prompts/                       # agent system prompts (user-editable)
    │   ├── coding-agent.md
    │   ├── code-reviewer.md
    │   ├── security-reviewer.md
    │   ├── sysadmin.md
    │   ├── security-auditor.md
    │   ├── writer.md
    │   ├── editor.md
    │   ├── deployer.md
    │   └── researcher.md
    ├── logs/
    │   ├── daemon.log                 # current log
    │   ├── daemon.log.1
    │   └── ...                        # rotated daily, kept 7 days
    └── artifacts/
        ├── runs/                      # agent run transcripts
        │   ├── <run_id>.log
        │   └── ...
        └── chats/                     # (post-V1) sync chat transcripts
            └── ...
```

### 16.2 Database file

SQLite is chosen for:

- **Single file** — easy to back up, inspect, move
- **No daemon** — no MySQL/Postgres server to manage
- **Good performance** for this scale (thousands of tickets, millions of comments — no problem)
- **Sync API** via `better-sqlite3` — simpler code, no async complexity on a single-process daemon
- **Well-understood** — millions of deployments, rock solid

WAL mode is enabled for better concurrency (multiple readers + one writer). Auto-vacuum is enabled to keep file size manageable.

Backups: SQLite's `VACUUM INTO` is called nightly to produce a copy at `~/Development/.tasks/backups/tasks-YYYYMMDD.db`. Last 14 backups are kept. Users can also trigger a backup via `dispatch backup create`.

### 16.3 Artifacts

Agent run transcripts are large (can be megabytes). Storing them in SQLite would bloat the database. Instead they live as plain files under `~/Development/.tasks/artifacts/runs/`, and the database just stores the path.

Retention: 30 days by default. A nightly cleanup job deletes old transcripts and updates the corresponding `agent_runs.transcript_path` to NULL.

### 16.4 Logs

Daemon logs rotate daily, kept for 7 days. Written in structured JSON (one entry per line) for easy grepping and parsing. Level: INFO by default, DEBUG available via config.

---

## 17. Configuration

### 17.1 Config file

`~/Development/.tasks/config.json`:

```json
{
  "heartbeat": {
    "base_interval_seconds": 300,
    "max_interval_seconds": 86400,
    "backoff_multiplier": 2
  },
  "agents": {
    "max_concurrent_per_project": 3,
    "max_concurrent_global": 10,
    "default_timeout_minutes": 30
  },
  "ui": {
    "port": 5757,
    "auto_open_on_install": true,
    "theme": "dark"
  },
  "retention": {
    "transcript_days": 30,
    "log_days": 7,
    "backup_count": 14
  },
  "discovery": {
    "root_path": "~/Development",
    "ignore": [".tasks", "Archive", "tmp"]
  },
  "claude_cli": {
    "binary_path": "claude",
    "default_model": "claude-sonnet-4-6"
  }
}
```

Config is loaded on daemon startup and reloaded on file change (via filesystem watcher). Changes take effect immediately; agent runs that are already in progress use the config snapshot from when they started.

### 17.2 Env var overrides

Any config value can be overridden via environment variables with the prefix `DISPATCH_`:

```
DISPATCH_UI_PORT=5858                      # override the UI port
DISPATCH_HEARTBEAT_BASE_INTERVAL=60        # 1-minute base for debugging
DISPATCH_CLAUDE_CLI_BINARY_PATH=/usr/local/bin/claude
```

---

## 18. Extensibility

### 18.1 Custom project types

Users can create their own project types via the UI or by editing the database directly. A custom project type defines its own columns and which agent types staff them. There is no limit on how many custom types exist.

### 18.2 Custom agent types

Users can duplicate a built-in agent type and modify:

- The system prompt (edit `~/Development/.tasks/prompts/<id>.md`)
- The model
- The tool allowlist
- The permission mode
- The timeout

For example: copy `coding-agent` to `golang-coding-agent`, edit the prompt to include Go-specific guidance, assign it to a new `golang-project` type.

### 18.3 Custom agent runtimes (post-V1)

V1 only supports `claude -p` as an agent runtime. V2 will allow custom runtimes: a shell script, an HTTP webhook, an OpenAI Agents SDK process, etc. The interface is: given a ticket context and an agent type config, produce a result (completed work, block, or failure). This plugs into the existing scheduler and MCP server.

### 18.4 MCP tool extensions (post-V1)

V1 exposes a fixed set of MCP tools to agents. V2 can allow users to add custom tools — e.g., `send_slack_message`, `create_github_pr`, `query_sentry_issue` — via MCP config files. Agents that have those tools in their allowlist can use them.

---

## 19. Error Handling and Resilience

### 19.1 Agent crashes

If a `claude -p` subprocess exits with non-zero status:

- The runner captures exit code and last N lines of stderr
- `agent_runs.exit_status` = `crashed`
- The ticket is released from its claim
- A `block` comment is added: "Agent crashed: <error message>. Ticket released."
- The ticket moves to the `Human` column so the user sees it in the inbox

### 19.2 Daemon crashes

The init system (launchd / systemd / Windows Service Manager) automatically restarts the daemon. On restart:

- The daemon reads its PID file to check if another instance is running (stale PID file means a previous crash)
- Any `agent_runs` with `exit_status = running` are marked `crashed` (they were orphaned by the crash)
- Their tickets are released from claims
- Heartbeats are resumed from the database state
- The UI and API come back up

### 19.3 Database corruption

SQLite in WAL mode is very crash-resistant. In the worst case (disk corruption, filesystem failure), the nightly backup can be restored manually.

### 19.4 MCP server errors

If an agent calls an MCP tool with invalid arguments, the tool returns an error. The agent sees the error and can retry or adjust. This is normal operation, not a failure mode.

If the MCP server itself is unreachable (e.g., daemon is down), the agent fails to claim the ticket and exits. The daemon will retry on the next heartbeat.

### 19.5 Network issues

The daemon uses only localhost HTTP, no network calls. Agents use whatever network access Claude Code has. Network issues during an agent run (e.g., Claude API unreachable) result in a timeout or crash, handled as above.

### 19.6 Disk space exhaustion

A nightly check ensures `~/Development/.tasks/` has < 1GB of data. If it exceeds that, the cleanup job aggressively prunes old transcripts and logs. If the disk is genuinely full, agent runs will fail and the user is notified via the UI.

---

## 20. Observability

### 20.1 Logs

Structured JSON logs per daemon event:

```json
{"level":"INFO","time":"2026-04-11T10:00:00Z","msg":"heartbeat fired","project":"HMH","found_work":true,"tickets":2}
{"level":"INFO","time":"2026-04-11T10:00:05Z","msg":"agent run started","run_id":"abc123","agent_type":"coding-agent","ticket_id":"t-456"}
```

Logs are browsable in the UI under "System" → "Logs" with filters by level, project, and time range.

### 20.2 Metrics

Dashboard shows:

- Tickets created / completed today
- Active agent runs (count + running time)
- Project heartbeat states
- Inbox size
- Average agent run duration per agent type
- Failure rate per agent type (in past 7 days)

These are computed from SQL queries on demand, not stored as time-series.

### 20.3 Transcript viewer

In the ticket detail view, each agent run has a "View transcript" link. Clicking it opens a modal with the full stream-json output, parsed and rendered as a readable conversation (user message → assistant message → tool call → tool result → ...).

### 20.4 Health check

`GET /api/health` returns:

```json
{
  "status": "ok",
  "uptime_seconds": 12345,
  "database": "connected",
  "projects": 5,
  "active_runs": 2,
  "queued_runs": 0
}
```

Used by launchd/systemd health checks and by the UI's daemon status widget.

---

## 21. Post-V1 Roadmap

In priority order:

### 21.1 Synchronous chat (high priority)

Open an interactive `claude` session scoped to a single ticket's context. Pane in the web UI with terminal-like input. When the chat ends, summarize the transcript and append as a `chat_summary` comment. Full transcript preserved in artifacts.

### 21.2 Keyboard shortcuts

Gmail-style navigation in the inbox (j/k, r, a, c, m, etc.). Power-user affordance.

### 21.3 Notifications

macOS native notifications (via `node-notifier` or `osx-notifier`) when a ticket lands in the Human column. Menu bar app with badge count. Opt-in.

### 21.4 Real-time UI

Replace 10-second polling with WebSocket or SSE push. Ticket changes appear in the UI instantly.

### 21.5 Git integration

When an agent mentions a commit SHA in its summary, auto-link it to the ticket. Agent can also tag commits with a ticket ID in the commit message (`Closes #HMH-427`). A ticket-detail-view "Linked commits" section shows all commits associated with the ticket.

### 21.6 Cost tracking

Per-agent-run cost estimate, aggregated per project per day/week/month. Soft budget enforcement (warn at 80%, block at 100%).

### 21.7 Plugin runtimes

Support agent runtimes other than `claude -p`: shell scripts, HTTP webhooks, OpenAI Agents SDK, custom Python processes. Same scheduler, same ticket model.

### 21.8 Team features (possible V3)

If demand exists, add multi-user support: shared daemon (bound to non-localhost with auth), user attribution on tickets, notification routing. But this is a big commitment and explicitly not the V1/V2 goal.

### 21.9 Mobile / tablet UI

A responsive version of the web UI that works on phones. Primarily for triaging the inbox from a phone when you're not at your desk. No editor / no agent runs, just read and reply.

### 21.10 Recurring tickets

Cron-style scheduled tickets: "Every Sunday at 9am, file a ticket in VPS-Maintenance to check disk usage and uptime." The ticket is filed automatically and routed to the sysadmin column.

---

## 22. Tech Stack

### 22.1 Core

- **Node.js 20+** — runtime. Chosen for cross-platform support, npm ecosystem, and alignment with Claude Code CLI.
- **TypeScript** — all source code. Strict mode.
- **Fastify 5** — HTTP server + MCP server. Same stack as HandyManagerHub (the proving-ground project), so patterns transfer.
- **better-sqlite3** — synchronous SQLite client. No async complexity, great performance.
- **zod** — runtime validation on every API input.

### 22.2 Frontend

- **htmx** — server-rendered HTML with interactivity. No React, Vue, or Svelte. Zero build step.
- **Tailwind CSS** (via CDN or compiled) — utility-first styling matching the Linode aesthetic.
- **Alpine.js** — small dollops of client-side state (e.g., collapsible sidebar, dropdowns). Optional.

### 22.3 Daemon orchestration

- **chokidar** — filesystem watching for auto-discovery.
- **pino** — structured logging.
- **node-pty** (post-V1, for sync chat) — pseudo-terminal for interactive claude sessions.
- **node-windows** (Windows) — service installation.

### 22.4 Agent integration

- **Claude Code CLI** — the agent runtime. Invoked via `child_process.spawn`.
- **@modelcontextprotocol/sdk** — for building the MCP server that agents connect to.

### 22.5 Packaging

- **npm** — the `projectdispatcher` package published to npm.
- **pkg** or **single-file binaries** (post-V1) — optional single-binary distribution for users who don't want to install Node.

---

## 23. Repository Layout

```
projectdispatcher/
├── package.json
├── tsconfig.json
├── README.md
├── DESIGN.md                     # this file
├── CLAUDE.md                     # project handoff doc (for agents working on Project Dispatcher itself)
├── LICENSE                       # MIT
├── src/
│   ├── index.ts                  # daemon entry point
│   ├── install.ts                # install script invoked via npx
│   ├── cli.ts                    # dispatch CLI entry point
│   ├── daemon/
│   │   ├── index.ts              # daemon main loop
│   │   ├── http.ts               # Fastify HTTP API
│   │   ├── mcp.ts                # MCP server
│   │   ├── scheduler.ts          # heartbeat scheduler
│   │   ├── watcher.ts            # chokidar project watcher
│   │   ├── agent-runner.ts       # spawns claude -p subprocesses
│   │   └── cleanup.ts            # nightly cleanup jobs
│   ├── db/
│   │   ├── index.ts              # better-sqlite3 connection
│   │   ├── migrations/           # schema migrations
│   │   │   ├── 001_init.sql
│   │   │   └── ...
│   │   ├── queries/              # typed query functions
│   │   │   ├── projects.ts
│   │   │   ├── tickets.ts
│   │   │   ├── comments.ts
│   │   │   ├── agent-runs.ts
│   │   │   ├── project-types.ts
│   │   │   └── agent-types.ts
│   │   └── seed.ts               # seeds built-in types
│   ├── services/
│   │   ├── prompt-builder.ts     # assembles agent system prompts
│   │   ├── transcript.ts         # writes and reads run transcripts
│   │   └── backup.ts             # database backup / restore
│   ├── ui/
│   │   ├── routes/               # Fastify routes serving HTML
│   │   │   ├── inbox.ts
│   │   │   ├── projects.ts
│   │   │   ├── project-board.ts
│   │   │   ├── ticket-detail.ts
│   │   │   ├── agent-types.ts
│   │   │   └── settings.ts
│   │   ├── templates/            # HTML templates (handlebars or similar)
│   │   │   ├── layout.hbs
│   │   │   ├── inbox.hbs
│   │   │   ├── project-board.hbs
│   │   │   └── ...
│   │   └── static/               # CSS, images, small JS helpers
│   │       ├── style.css
│   │       ├── favicon.svg
│   │       └── alpine.min.js
│   ├── platform/
│   │   ├── macos.ts              # LaunchAgent install/uninstall
│   │   ├── linux.ts              # systemd user unit install/uninstall
│   │   └── windows.ts            # Windows Service install/uninstall
│   └── prompts/
│       └── defaults/             # bundled default agent prompts
│           ├── coding-agent.md
│           ├── code-reviewer.md
│           └── ...
├── test/                         # integration and unit tests
├── scripts/
│   ├── release.sh                # npm publish workflow
│   └── dev.sh                    # local dev setup
└── docs/
    ├── getting-started.md
    ├── writing-agent-prompts.md
    └── troubleshooting.md
```

Source lives in `src/`. Compiled output goes to `dist/`. The published npm package includes `dist/`, `prompts/defaults/`, and the static UI assets.

---

## 24. Development Workflow

### 24.1 Prerequisites

- Node.js 20+
- `claude` CLI installed and logged in
- A POSIX-compliant shell for local scripts (macOS/Linux)

### 24.2 Setup

```bash
git clone git@github.com:<user>/projectdispatcher.git
cd projectdispatcher
npm install
```

### 24.3 Local dev

```bash
npm run dev
  # Starts the daemon in foreground mode with hot-reload,
  # on port 5758 (so it doesn't conflict with a production install on 5757).
  # Uses a throwaway database at ./dev.db.
```

### 24.4 Building

```bash
npm run build
  # Compiles TypeScript to dist/
  # Bundles the UI assets
```

### 24.5 Testing

```bash
npm test
  # Runs Vitest unit tests
npm run test:integration
  # Runs integration tests that spawn a real daemon and make API calls
```

### 24.6 Linting

```bash
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm run format     # prettier
```

### 24.7 Publishing

Publishing to npm is a separate step from development:

```bash
npm version patch|minor|major
npm run build
npm publish
```

The published package exposes `projectdispatcher` as the package name and `dispatch` as the binary.

---

## 25. Dogfooding Plan

Project Dispatcher will be built in two phases:

### Phase 1: Scratch prototype inside HandyManagerHub

Build a minimal working version as a subdirectory of `~/Development/HandyManagerHub/` (or a scratch folder), using HandyManagerHub's existing dev loop. The prototype uses the manual Claude Code workflow (not yet self-hosting). Goal: validate the architecture and shake out unknowns in a weekend.

### Phase 2: Move to its own project and self-host

Once the prototype is working, copy it to `~/Development/ProjectDispatcher/` as its own standalone project. Install it using its own installer. Register itself as one of its managed projects (type: `software-dev`). From that point on, all further development of Project Dispatcher is managed *by* Project Dispatcher: you file tickets in the Project Dispatcher project's board, agents build the next features, reviewers review the changes, and you sign off through the inbox.

This is dogfooding with a twist: the tool supervises its own development. Any bug or friction in the tool directly affects your ability to ship improvements to the tool, which creates a natural pressure to fix them fast.

Phase 2 is the real test. If the tool is good enough to manage its own development, it's good enough for general use.

### Phase 3: Open source

Once the tool has been in Phase 2 for a month or two and feels stable, publish to npm and GitHub. Write a landing page at projectdispatcher.com. See if anyone else wants to use it.

---

## 26. Glossary

- **Agent** — a stateless process (typically `claude -p`) invoked by the daemon to work on a ticket. Each invocation is a fresh session.
- **Agent run** — a single invocation of an agent on a specific ticket. Has a start time, end time, exit status, transcript, and cost estimate.
- **Agent type** — a preset that defines an agent's system prompt, model, tool allowlist, permission mode, and timeout. First-class entity in the data model.
- **Backoff** — the exponential increase in heartbeat interval when an agent wakes up and finds nothing to do.
- **Cascade** — when one agent in a project finds work, all agents in that project reset to 5-minute heartbeats. Ensures downstream agents wake up quickly after upstream ones finish.
- **Claim** — an agent atomically marks a ticket as `in_progress` by its run so other agents don't pick up the same work.
- **Column** — a workflow stage. Every ticket is in exactly one column at a time. Columns are defined by the project type.
- **Daemon** — the long-lived Node.js process that runs the HTTP API, MCP server, scheduler, and agent runner. Auto-starts on boot.
- **Dispatch** — the CLI binary name.
- **Dormant** — a project whose heartbeat has backed off to the max interval (24 hours).
- **Heartbeat** — the periodic wake-up of agents in a project to check for work.
- **Inbox** — the flat list of every ticket currently in a `Human` column, across all projects. Primary UI view.
- **MCP** — Model Context Protocol. The interface agents use to manipulate tickets.
- **Project** — a folder under `~/Development/` registered with Project Dispatcher. Has a type.
- **Project type** — a preset that defines a project's columns and default agents. First-class entity.
- **Scheduler** — the daemon component that fires heartbeats and spawns agents.
- **Ticket** — a unit of work. Has a title, body, current column, priority, tags, and a threaded history of comments.
- **YOLO mode** — shorthand for `--permission-mode bypassPermissions` in `claude -p`. Agents run without asking for permission on tool use.

---

## End

This document is the authoritative design for V1 of Project Dispatcher. It should be enough to start building. If you're an agent or human picking this up to begin implementation, read top to bottom, then start with the daemon skeleton, then the database schema, then a minimal HTTP API, then one working agent runner, then the UI.

First working demo target: inbox view with one project, one ticket, one agent (coding-agent), the agent wakes up, claims the ticket, writes a `hello world` file, adds a comment, moves the ticket to Human. If that round-trip works, the rest is scaffolding.
