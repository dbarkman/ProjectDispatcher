# Project Dispatcher

Async ticket-based orchestration between a human and AI coding agents. Local, single-user, runs on your own machine. One daemon across every project.

Project Dispatcher is the missing middle tier: you file a ticket ("add payment collection to the invoice flow"), it lands in a Kanban board, and agents pick it up on a heartbeat. A coding agent does the work on its own branch. A code reviewer reviews it. A security reviewer reviews it. When the security reviewer approves, the daemon merges the branch onto main. You sign off on what actually needs human judgment; the rest flows through while you sleep.

It is the tool you want between "Claude can do this for me" and "I have to babysit every session." You file the work, you walk away, you come back to an inbox of completed or blocked tickets across every project you own.

## Install

```bash
npx projectdispatcher install
```

That is the full install. The installer:

- Creates `~/Development/.tasks/` with seeded SQLite, default agent prompts, and default config
- Installs a platform service (LaunchAgent on macOS, systemd user unit on Linux)
- Waits for the daemon to become healthy
- Auto-discovers projects under `~/Development/` and seeds them as unregistered
- Opens `http://localhost:5757` in your browser

Requirements:

- Node.js 22 or newer
- [`claude` CLI](https://docs.claude.com/en/docs/claude-code/overview) installed and on `PATH`
- macOS 14+ or Linux with `systemd --user` (Windows: see Platform support below)

## Quick tour

After install, open `http://localhost:5757`.

1. **Projects** lists every folder under `~/Development/` the installer found. Click Register on the ones you want PD to manage and pick a project type (software-dev, content, vps-maintenance, research, or personal).
2. **Settings** is where you configure the AI auth method (OAuth via the `claude` CLI session is the easiest; API key and custom endpoints also supported), tune concurrency caps, and enable parallel coding.
3. **New ticket** from a project's board. Title, body, priority, starting column. If you put it in Coding Agent, the next heartbeat picks it up.
4. **The inbox** is your unified view across every project — any ticket parked in the Human column, wherever it lives, shows up here.

## How it works

Four moving parts:

- **Daemon** — Fastify over SQLite (better-sqlite3, WAL mode). Bound to `127.0.0.1:5757`. Runs as a LaunchAgent/systemd service, restarts on crash.
- **Scheduler** — per-project heartbeat timers. When a project's timer fires, the scheduler scans every agent column for unclaimed tickets and spawns agents up to the concurrency cap. Empty ticks back off exponentially (5 min → 10 min → 20 min → ... → 24 hr cap) so a quiet machine does not burn.
- **Agents** — `claude -p` subprocesses. Each runs detached, writes its transcript directly to a file, survives daemon restarts. A reaper finalizes any agent that died while the daemon was down.
- **Ticket CLI (`ticket.cjs`)** — how agents read and mutate tickets. A small Node script with parameterized SQLite queries. No MCP server, no HTTP transport between agent and daemon. Simpler and more reliable than a protocol server; one failure mode instead of four.

Agents work in **git worktrees** when `parallel_coding` is on (Settings → Agents → Parallel coding). Each coding-agent ticket gets its own branch `ticket/<id>` in its own worktree directory. When the ticket hits Done, the daemon merges the branch cleanly onto main via a direct `git merge`; merge conflicts route the ticket back to Human with a specific error.

A **circuit breaker** (configurable, default 3 runs) auto-routes a ticket to Human if an agent runs that many times on the same ticket without moving it to a new column. This stops run-away token burn when an agent is stuck and does not know it.

Config lives at `~/Development/.tasks/config.json`. Most fields hot-reload — edit via `http://localhost:5757/ui/settings` and the running daemon picks them up without a restart. A few (port, binary path) need a restart and are labeled as such.

## Agents and models

Nine built-in agent types ship:

| Agent | Role | Model |
| --- | --- | --- |
| Coding Agent | Does the work on a ticket branch | Claude Opus |
| Code Reviewer | Reviews the coding agent's diff | Claude Opus |
| Security Reviewer | Reviews for security issues, approves for merge | Claude Opus |
| Sysadmin | VPS / host ops | Claude Sonnet |
| Security Auditor | Deeper security audits (hosts, configs) | Claude Sonnet |
| Writer | Drafts written content | Claude Sonnet |
| Editor | Edits the writer's drafts | Claude Sonnet |
| Deployer | Packages and deploys | Claude Sonnet |
| Researcher | Web research + summaries | Claude Haiku |

Merging the ticket branch onto main is not done by an agent — when a ticket reaches Done, the daemon runs a direct `git merge` via its worktree helper, and a merge conflict routes the ticket back to Human with a specific error.

Each agent type is a markdown system prompt at `~/Development/.tasks/prompts/<agent>.md`. Edit it in place. User edits are preserved across upgrades — the installer only copies a default when the file does not already exist.

Each agent type also has `allowed_tools`, `permission_mode`, `timeout_minutes`, and `max_retries` stored in the database. Edit them at `http://localhost:5757` under a given agent type's page.

## CLI

The `dispatch` command installs alongside the daemon. Common operations:

```bash
dispatch daemon status          # is the daemon up?
dispatch daemon restart         # restart via launchctl / systemctl
dispatch daemon logs --follow   # tail the daemon log

dispatch projects list          # every project and its status
dispatch projects register <path> --type software-dev

dispatch ticket new --project pd --title "..." --body "..." --column coding-agent
dispatch ticket list --project pd
dispatch ticket show pd-42
dispatch ticket comment pd-42 "..."
dispatch ticket move pd-42 code-reviewer

dispatch update                 # check npm for a newer version
dispatch uninstall              # stop daemon, unlink bin, optionally delete .tasks/
```

## Platform support

| Platform | Status |
| --- | --- |
| macOS 14+ (Apple Silicon + Intel) | Supported. LaunchAgent for daemon auto-start. Primary development target. |
| Linux (systemd user units) | Supported. Tested on Ubuntu 22.04+, Fedora 40+, Rocky 9+. Requires `systemd --user`. |
| Windows | Not yet. Platform module is stubbed; daemon runs manually. |

## Safety and control

Project Dispatcher spawns `claude -p` subprocesses that can write to your codebase. A few things keep it bounded:

- **Per-project and global concurrency caps** (default 3 per project, 10 global). Hot-reloadable from Settings.
- **Circuit breaker** on stuck tickets (default 3 runs without progress → auto-route to Human).
- **Worktree isolation** when `parallel_coding` is on — each agent's changes land on its own branch, never directly on main.
- **Merge conflicts route to Human**, not "force push to resolve".
- **Subprocess env scrubbing** — agents run with a minimal environment, not the daemon's full env.
- **Transcript capture** of every run at `~/Development/.tasks/artifacts/runs/<run-id>.log`. Nothing an agent does is invisible.

## Data and storage

Everything lives under `~/Development/.tasks/`:

```
.tasks/
├── tasks.db                # SQLite, WAL mode
├── config.json             # daemon config
├── prompts/                # agent system prompts (markdown, editable)
├── artifacts/runs/         # agent transcripts
├── logs/                   # daemon logs (age-based cleanup, retention configurable)
├── backups/                # rolling DB snapshots
└── daemon.pid              # PID file
```

Uninstall removes the service and the binary. It asks before deleting `~/Development/.tasks/`.

## Development

```bash
git clone https://github.com/dbarkman/ProjectDispatcher.git
cd ProjectDispatcher
npm install
npm run typecheck
npm test
npm run dev        # starts the daemon via tsx, no auto-start service
```

The test suite covers daemon internals, agent runtime, scheduler, config hot-reload, and the platform modules. Vitest for everything.

## License

MIT. See [LICENSE](./LICENSE).

## Author

David Barkman. Most of Project Dispatcher is written by Project Dispatcher — the coding-agent pipeline self-hosts on the same repo it is building.
