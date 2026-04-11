# Project Dispatcher

Async ticket-based communication layer between a human and AI agents, working across many projects in parallel.

**Status:** Design phase — MVP scoped, not yet built. See `DESIGN.md` for the full specification.

## What it is

You have many projects. Software in progress, VPS maintenance, a blog, research tasks, side projects. Each project has work you want AI agents to do. Instead of opening a new Claude session per project and manually relaying between you, a code reviewer, a security reviewer, and so on, you file tickets, and agents pick up the work on a heartbeat. You sign off when it matters. Everything flows through a unified inbox.

## What it is not

- Not a personal task manager for non-agent work
- Not a team collaboration tool (solo use, local-only)
- Not a project tracker (no Gantt, roadmaps, estimates)
- Not a CEO agent framework (no org chart, no delegation hierarchy)

## Install (planned)

```bash
cd ~/Development && npx projectdispatcher install
```

That's the whole install. Afterward, any subfolder of `~/Development/` becomes a discoverable project. Open `http://localhost:5757` for the web UI.

## Core idea

1. **Projects** are folders under `~/Development/`. Each has a type.
2. **Tickets** flow between columns (Human, Coding Agent, Code Reviewer, Security Reviewer, etc.).
3. **Agents** wake on per-project heartbeat, check their column, do work, route tickets.
4. **Heartbeats back off** when idle, reset to 5 min when you assign work or an agent finds work.
5. **The inbox** is the primary UI — one unified view of every ticket needing your attention across every project.

## Design document

The full spec is in [`DESIGN.md`](./DESIGN.md). Read it top to bottom if you're picking up this project cold.

## License

MIT (planned).

## Author

David Barkman — with an AI coding agent as the primary contributor.
