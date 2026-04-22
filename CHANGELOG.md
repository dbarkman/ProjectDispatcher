# Changelog

All notable changes to Project Dispatcher.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.1] — 2026-04-21

### Fixed

- **`dispatch --version` was reporting 0.1.0.** The CLI had a hardcoded
  version string that never updated through 0.1.1 or 0.2.0. Now reads
  from `package.json` at runtime via `createRequire`, so future
  `npm version <bump>` calls automatically reflect in the CLI output.

## [0.2.0] — 2026-04-21

### Added

- **Merge agent** (pd-47). New agent type that handles both clean merges and
  conflict resolution. Replaces the daemon's direct `git merge` path for
  software-dev and vps-maintenance project types. Tickets flow
  Security Review → Merging → Done. Agent reads conflict markers, consults
  the ticket body + diff context, applies resolution strategies (same-region
  concatenation, placeholder replacement, migration-filename renumbering),
  commits the merge. On genuinely conflicting semantics, aborts and routes
  back to Human after a retry cap with a detailed findings comment.

### Fixed

- **Test suite no longer clobbers the user's live `config.json`**. `createHttpServer`
  now accepts an optional `configPath` that is threaded through to both
  `configRoutes` and `aiConfigRoutes`. A runtime guard throws when the
  server is instantiated under Vitest/`NODE_ENV=test` without an explicit
  `configPath` — fail-loud protection against any future test regression.
  All existing test callsites updated to pass a tmp path. Production
  daemon callsite now passes `DEFAULT_CONFIG_PATH` explicitly.
  Context: previously running `npm test` overwrote
  `~/Development/.tasks/config.json` with `ui.port=9999`,
  `claude_cli.binary_path=/usr/local/bin/claude`, and
  `discovery.root_path=/some/other/path` — the exact values from
  `config-hot-reload.test.ts`.
- **Project settings save navigation**. Settings save uses
  `HX-Redirect` header to route back to project detail on success.

## [0.1.1] — 2026-04-21

First-run UX polish from smoke-testing the 0.1.0 install on a clean machine.

### Fixed

- **OAuth auto-detection in setup wizard.** Step 1 was checking for
  `~/.claude/credentials.json`, which misses valid sessions stored elsewhere.
  Detection now runs the same `claude` subprocess probe the test-connection
  step uses, so wizard state reflects reality. Badge shows "Checking…" while
  the probe runs, then updates and pre-selects OAuth if the session is good.
- **Installer next-steps output.** After `npx projectdispatcher install`, the
  final output referenced the `dispatch` CLI — but `npx` does not install it
  globally, so those commands failed with `command not found`. Next-steps now
  leads with the optional `npm install -g projectdispatcher` line and frames
  the web UI as the primary interface.

### Packaging

- **`npm-shrinkwrap.json` committed.** Locks the full dependency tree for
  reproducible installs. Refresh with `npm update && npm shrinkwrap` when you
  want to pull patches.
- **`*.tgz` gitignored.** `npm pack` output no longer risks being committed.

## [0.1.0] — 2026-04-18

First public release. The daemon is feature-complete against the V1 scope in
`DESIGN.md` and has been self-hosting on its own ticket pipeline for weeks.

### Added

- **Async ticket-based orchestration.** Per-project Kanban boards. Tickets flow
  between columns (Human → Coding Agent → Code Reviewer → Security Reviewer →
  Done) with append-only threaded comments. The security reviewer approves the
  ticket for merge; the daemon merges the branch directly.
- **Per-project heartbeat scheduler** with exponential backoff. Resets to 5 min
  when work is assigned or found; backs off to a 24h ceiling when idle.
- **Detached agent subprocesses.** `claude -p` runs detached with transcripts
  written directly to file descriptors, so agents survive daemon restarts. A
  reaper finalizes orphaned runs.
- **Parallel coding via git worktrees.** Each coding-agent ticket gets its own
  branch `ticket/<id>` in its own worktree. The daemon lands clean merges on
  main directly when the ticket hits Done; conflicts route back to Human with
  a specific error.
- **Concurrency caps** enforced in-process (default 3 per project, 10 global),
  hot-reloadable from the Settings UI. Race-free reservation pattern so
  concurrent heartbeats cannot exceed the cap.
- **Circuit breaker** (default 3 runs without column progress → auto-route to
  Human). Stops token burn when an agent is stuck.
- **Config hot-reload** via a `configRef` container. Most fields (caps,
  circuit breaker, retention, parallel coding, discovery ignore list) take
  effect on the next heartbeat with no daemon restart. Port and claude binary
  path still require a restart and are labeled as such.
- **Nine built-in agent types**: coding agent, code reviewer, security reviewer,
  sysadmin, security auditor, writer, editor, deployer, researcher.
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
