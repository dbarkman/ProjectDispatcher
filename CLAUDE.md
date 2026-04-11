# Project Dispatcher

**This project is currently in the design phase — no code exists yet, just documentation.**

If you are an agent or human picking up this project cold, read in this order:

1. This file (CLAUDE.md) — quick orientation
2. [`README.md`](./README.md) — one-page introduction
3. [`DESIGN.md`](./DESIGN.md) — the full design specification (long, thorough, authoritative)

---

## What this project is

An async ticket-based communication layer between a human (David) and AI agents, working across multiple projects in parallel. Agents wake on per-project heartbeat, claim tickets from their column, do work, and route tickets between columns. The human has a unified inbox view across all projects. Columns are defined by project type. Agents are defined by agent type with editable system prompts.

Think of it as: a Kanban board per project, with agents as workers in the columns, and the human as a supervisor who processes an inbox.

It is NOT a personal task manager, a team collaboration tool, a CEO-agent framework, or a project management suite. It is a narrow, opinionated tool for the specific problem of coordinating async human↔AI work.

## Status

- **Design:** complete as of 2026-04-11. Lives in [`DESIGN.md`](./DESIGN.md) — 26 sections, roughly 15k words, MVP scope fully specified.
- **Code:** not yet written.
- **First build plan:** the first prototype will be built in a scratch directory inside HandyManagerHub (`~/Development/HandyManagerHub/`), validated there, then moved to this directory and used to manage its own further development (dogfooding). See DESIGN.md section 25.

## Who's building it

- **Product owner:** David Barkman
- **Primary coder:** An AI agent (Claude Opus 4.6)
- **Working style:** David is the product owner and final reviewer. The coding agent implements from the design doc. Reviews happen through the same review process used on HandyManagerHub (external code reviewer and security reviewer agents).

## Key design decisions already locked in

- **Local-only, single-user.** No cloud, no multi-tenancy, no auth. HTTP bound to 127.0.0.1.
- **SQLite** for the task store. One file, zero ops.
- **Node.js + TypeScript** for cross-platform support.
- **Fastify** for HTTP and MCP servers.
- **htmx + Tailwind** for the UI — no React, no build-step SPA framework.
- **`claude -p`** as the agent runtime. Invoked as a subprocess per agent run.
- **MCP server** for agents to manipulate tickets. Agents don't make HTTP calls directly.
- **npm overrides are not needed here** (unlike HandyManagerHub). This project is server-side only; no React, so no duplicate-React trap.
- **Auto-discovery of projects** from subfolders of `~/Development/`.
- **Exponential backoff heartbeat** per project, reset on explicit work start or on cascade from other agents finding work.
- **Linode-inspired dark UI.** Left sidebar, data tables, dark navy background, subtle borders.
- **Binary name:** `dispatch` (not `projectdispatcher`).
- **Domain:** projectdispatcher.com (David owns it).

## Key design decisions explicitly NOT in V1

- Synchronous chat within a ticket (post-V1, planned)
- Notifications (post-V1)
- Keyboard shortcuts (post-V1, data model supports them)
- Git integration (auto-linking commits) (post-V1)
- Cost tracking (post-V1)
- Plugin runtimes (post-V1)
- Team / multi-user (probably never — this is a solo tool by design)

## Where to find things

- **Design doc:** [`DESIGN.md`](./DESIGN.md) — the bible. Everything is in here.
- **README:** [`README.md`](./README.md) — the public-facing one-pager.
- **Inspiration:** Paperclip (https://paperclip.ing). Project Dispatcher is a narrower, opinionated take on the same idea — learn from what Paperclip did well (one-line install, heartbeat model, cross-platform) and what it did badly (too much metaphor, too much ambition, org-chart framing).

## How this project will be built

### Phase 1: Prototype inside HandyManagerHub (weekend 1-2)

Build a minimal working daemon + HTTP API + SQLite + one agent runner + basic inbox UI. Scope: prove the round-trip (file a ticket → agent claims it → agent writes a file → agent moves ticket → human sees it in inbox). All in a scratch folder inside HMH's dev environment.

### Phase 2: Move to this folder and self-host (weekend 3)

Copy working prototype to `~/Development/ProjectDispatcher/` as a standalone project. Install via its own installer. Register itself as one of its managed projects. From here on, all further development is managed by Project Dispatcher itself — files tickets in its own board, agents build the next features, reviewers review the changes.

### Phase 3: Open source (optional, month 2+)

Publish to npm, put up a landing page at projectdispatcher.com, see if anyone else wants it.

## What to do in a fresh session on this project

1. Read this file (done)
2. Read [`DESIGN.md`](./DESIGN.md) top to bottom
3. Check the project's board in the Project Dispatcher UI (if self-hosting has started)
4. Ask David what the priority is for this session
5. If this is the first build session, start with the daemon skeleton:
   - `npm init`, TypeScript config, Fastify + better-sqlite3 + zod + pino installed
   - Minimal HTTP server that returns `{ status: 'ok' }` at `/api/health`
   - Database schema + migrations from DESIGN.md section 7
   - Seed the built-in project types and agent types

## Constraints and guardrails

- **No speculative features.** Build only what's in DESIGN.md. If something looks missing, add it to a post-V1 list; don't build it.
- **No framework bloat.** htmx + Tailwind + Fastify. No React, no Next.js, no Remix, no Vue, no Svelte.
- **No sync chat in V1.** Resist the urge — it's complex and the rest of the system needs to exist first.
- **Cross-platform from the start.** If you write macOS-only code without a Linux/Windows path, stop and write the abstraction.
- **Follow HandyManagerHub's patterns.** Fastify conventions, Zod validation on every route, structured logging, same code style. Reuse what works.
- **Don't build a UI framework.** htmx-first. If you find yourself writing a lot of client JS, step back.

## Coding Principles & KISS

**Pragmatism and simplicity come first.** Always pick the simple option when there's a choice — it saves you in the long run. Never code something complex for the sake of complexity; that's just dumb. David is a pragmatic, simple programmer — match that style. Three similar lines beats a premature abstraction. No message queues when `setTimeout` works. No Postgres when SQLite is enough. No framework when a plain function does the job. Before reaching for a pattern, ask "is there a simpler way?" and take it.

The rest of these are distilled from three rounds of external code + security reviews on HandyManagerHub. They exist to catch real bugs that real reviewers have flagged in David's codebases — they are not speculative best-practices. All of them apply to Project Dispatcher too.

- **Zod at every boundary, from line one.** Every HTTP route body/params/query, every MCP tool input, every config file read, every subprocess stdout you parse from `claude -p`. Don't defer — retrofitting validation is expensive.
- **Delete dead code, don't gate it.** No `if (DEV_MODE)` bypass paths, no commented-out "future" stubs, no test routes living next to real routes. If you need a dev tool, it lives in a separate file the daemon doesn't load. Gated code ships.
- **Fail loud; route failures somewhere visible.** In PD this is already baked into the design: blocked or errored tickets route to the Human column, never left silently in an agent column. Enforce that in the scheduler from day one — every agent-run error path ends with "ticket moved to human + comment explaining why."
- **`fs/promises`, never sync `fs`, in daemon code paths.** Sync I/O blocks the event loop. With chokidar watching `~/Development/`, agent subprocesses streaming output, and heartbeats ticking — a 50ms sync read can stall the scheduler. Sync is only acceptable during one-shot startup (reading migration files before the server binds).
- **Secrets hygiene from the first commit.** `.gitignore` `.tasks/`, `*.db`, `*.log`, and any config examples before the first `git add`. No `.env.example` with real-looking values. Git history is forever.
- **Cross-platform paths from day one.** `os.homedir()` + `path.join()`, never hardcoded `/Users/david/Development/...`. PD is designed to be installed by others on Linux eventually — don't bake in macOS-only assumptions.
- **Principle of least privilege on the MCP surface.** Expose *only* the specific ticket operations agents need. No generic `execute_sql` tool, no `read_file_anywhere` tool. If an agent later needs something new, add a specific tool — don't broaden an existing one.
- **Startup-time config validation with hard refusal.** Zod-check the config file and env overrides at boot. If something's missing or invalid, refuse to start with a specific error naming the field. Don't limp along and fail when the first request lands.
- **Foreign keys on, and verified at startup.** SQLite's `PRAGMA foreign_keys=ON` is OFF by default. The schema migration sets it, but add a startup check that the pragma is actually on after the connection opens — don't just trust it. FK enforcement catches logic bugs before they become data bugs.
- **Defense in depth on IDs.** Even in a single-user local tool, every ticket lookup should verify the project it belongs to. Cheap insurance against logic bugs now and a clean model when PD eventually needs per-project access rules.
- **Strict TypeScript — no `any`, `noUncheckedIndexedAccess` on.** Second-order bugs from loose types and unchecked array access cost more than the time it takes to type things correctly.
- **Don't batch too much work between reviews.** The natural review points for PD are roughly one phase at a time from DEVELOPMENT.md. Before writing a route, ask "what would the security reviewer flag?" — and preempt it.
- **Push back on wrong review findings, after verifying.** Findings aren't gospel. Verify each one against current code before acting. Over-correcting on a false positive costs more than flagging it back.

## Not in the scope of V1 work

- Mobile apps
- Team collaboration
- Hosted/cloud version
- Plugin marketplace
- Any form of auth or user management
- Billing / subscriptions
- OAuth with external services (GitHub, Linear, etc.)

---

Last updated: 2026-04-11, before any code was written.
