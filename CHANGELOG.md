# Changelog

All notable changes to Project Dispatcher.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-04-18

First public release. The daemon is feature-complete against the V1 scope in
`DESIGN.md` and has been self-hosting on its own ticket pipeline for weeks.

### Added

- **Async ticket-based orchestration.** Per-project Kanban boards. Tickets flow
  between columns (Human → Coding Agent → Code Reviewer → Security Reviewer →
  Merge Agent → Done) with append-only threaded comments.
- **Per-project heartbeat scheduler** with exponential backoff. Resets to 5 min
  when work is assigned or found; backs off to a 24h ceiling when idle.
- **Detached agent subprocesses.** `claude -p` runs detached with transcripts
  written directly to file descriptors, so agents survive daemon restarts. A
  reaper finalizes orphaned runs.
- **Parallel coding via git worktrees.** Each coding-agent ticket gets its own
  branch `ticket/<id>` in its own worktree. The merge agent lands clean merges
  on main; conflicts route back to Human with a specific error.
- **Concurrency caps** enforced in-process (default 3 per project, 10 global),
  hot-reloadable from the Settings UI. Race-free reservation pattern so
  concurrent heartbeats cannot exceed the cap.
- **Circuit breaker** (default 3 runs without column progress → auto-route to
  Human). Stops token burn when an agent is stuck.
- **Config hot-reload** via a `configRef` container. Most fields (caps,
  circuit breaker, retention, parallel coding, discovery ignore list) take
  effect on the next heartbeat with no daemon restart. Port and claude binary
  path still require a restart and are labeled as such.
- **Ten built-in agent types**: coding agent, code reviewer, security reviewer,
  sysadmin, security auditor, writer, editor, deployer, researcher, merge agent.
- **Five built-in project types**: software-dev, content, vps-maintenance,
  research, personal.
- **Ticket CLI (`ticket.cjs`)** — agents interact with tickets via a small Node
  script running parameterized SQLite queries. No MCP server, no transport
  layer, no protocol drift.
- **Auth provider configuration** — OAuth (via the `claude` CLI session), API
  key, or custom endpoint. Setup wizard on first run.
- **Dark-mode Web UI** at `http://localhost:5757`. Unified inbox across every
  project. Live board polling. Ticket detail with comment thread, transcript
  viewer, per-agent-type edit pages, workflow editor, project settings.
- **Human-readable ticket IDs** — `pd-42`, `hmh-17`. Per-project abbreviation.
- **Ticket attachments** — screenshot upload, filename sanitization to survive
  non-ASCII characters in Content-Disposition.
- **Installer** — `npx projectdispatcher install`. Creates `.tasks/`,
  initializes DB, seeds builtins, copies default prompts, installs platform
  service (LaunchAgent on macOS, systemd user unit on Linux), waits for
  health, runs auto-discovery, opens browser. `--no-browser` flag and
  `DISPATCH_NO_BROWSER=1` env var for automated runs.
- **`dispatch` CLI** — `daemon status/restart/logs`, `projects
  list/register/archive/discover`, `ticket new/list/show/comment/move`,
  `update`, `uninstall`.
- **Process resilience** — PID file lock (prevents duplicate daemons), health
  watchdog (detects scheduler-dead-but-daemon-alive), uncaughtException
  handler (clean exit for init-system restart).
- **DNS rebinding protection** via Host header allowlist on the HTTP server.
- **Database safety** — WAL mode, `PRAGMA foreign_keys=ON`, rolling backup
  retention, migrations run with a separate SQLite handle (DDL isolated from
  runtime queries).

### Known limitations

- **Windows is not supported yet.** Platform module is stubbed; service install
  throws. Use the manual `npm run dev` on Windows until support lands.
- **Synchronous chat inside a ticket** is not implemented. Deferred post-V1.
- **Real-time UI** uses polling (10s board, 5s ticket detail). WebSockets/SSE
  are post-V1.
- **Rollback on mid-install failure** is written into the installer but not yet
  exercised end-to-end; a follow-up ticket tracks a fault-injection test.
