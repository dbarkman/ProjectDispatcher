#!/usr/bin/env node
// ticket.cjs — Agent ticket operations via direct DB access.
//
// Replaces the MCP server. Agents call this via Bash instead of using
// MCP tools. Parameterized queries only — no raw SQL from agent input.
// DML only — no DROP, no DELETE tickets, no schema operations.
//
// Usage:
//   node ticket.cjs read <ticket-id>
//   node ticket.cjs thread <ticket-id>
//   node ticket.cjs comment <ticket-id> <type> <body>
//   node ticket.cjs move <ticket-id> <column> [comment]
//   node ticket.cjs claim <ticket-id> <run-id>
//   node ticket.cjs release <ticket-id>
//   node ticket.cjs finding <ticket-id> <severity> <title> <body>
//
// Environment:
//   DISPATCH_DB_PATH     — path to SQLite database (required)
//   DISPATCH_AUTHOR      — author string for comments (required)
//   DISPATCH_PROJECT_ID  — project UUID for scope checks (required)
//   DISPATCH_PORT        — daemon port for wake-after-move (default: 5757)

'use strict';

// Node's require() walks up directories from __dirname (src/cli/) to find
// node_modules/. It reaches ProjectDispatcher/node_modules/ at the project
// root — works regardless of the agent's CWD (which is the project being
// worked on, not ProjectDispatcher).
const Database = require('better-sqlite3');

const dbPath = requireEnv('DISPATCH_DB_PATH');
const author = requireEnv('DISPATCH_AUTHOR');
const projectId = requireEnv('DISPATCH_PROJECT_ID');
const port = process.env.DISPATCH_PORT || '5757';

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const [, , command, ...args] = process.argv;

const commands = {
  read() {
    const [ticketId] = requireArgs(args, 1, 'read <ticket-id>');
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ? AND project_id = ?').get(ticketId, projectId);
    if (!ticket) fail(`Ticket not found: ${ticketId}`);
    const comments = db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at').all(ticketId);
    console.log(JSON.stringify({ ...ticket, comments }, null, 2));
  },

  thread() {
    const [ticketId] = requireArgs(args, 1, 'thread <ticket-id>');
    verifyTicketScope(ticketId);
    const comments = db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at').all(ticketId);
    console.log(JSON.stringify(comments, null, 2));
  },

  comment() {
    const [ticketId, type, body] = requireArgs(args, 3, 'comment <ticket-id> <type> <body>');
    verifyTicketScope(ticketId);
    validateCommentType(type);
    const id = randomId();
    const now = Date.now();
    db.prepare(
      `INSERT INTO ticket_comments (id, ticket_id, type, author, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, ticketId, type, author, body, now);
    console.log(JSON.stringify({ id, type, status: 'created' }));
  },

  finding() {
    const [ticketId, severity, title, body] = requireArgs(args, 4, 'finding <ticket-id> <severity> <title> <body>');
    verifyTicketScope(ticketId);
    const validSeverities = ['critical', 'high', 'medium', 'low'];
    if (!validSeverities.includes(severity)) {
      fail(`Invalid severity: ${severity}. Must be one of: ${validSeverities.join(', ')}`);
    }
    const id = randomId();
    const now = Date.now();
    const fullBody = `**[${severity.toUpperCase()}]** ${title}\n\n${body}`;
    db.prepare(
      `INSERT INTO ticket_comments (id, ticket_id, type, author, body, meta, created_at)
       VALUES (?, ?, 'finding', ?, ?, ?, ?)`
    ).run(id, ticketId, author, fullBody, JSON.stringify({ severity, title }), now);
    console.log(JSON.stringify({ id, severity, status: 'created' }));
  },

  move() {
    const [ticketId, column, comment] = args;
    if (!ticketId || !column) fail('Usage: move <ticket-id> <column> [comment]');

    // Validate column exists for this project
    const project = db.prepare('SELECT project_type_id FROM projects WHERE id = ?').get(projectId);
    if (!project) fail('Project not found');
    const colExists = db.prepare(
      'SELECT 1 FROM project_type_columns WHERE project_type_id = ? AND column_id = ?'
    ).get(project.project_type_id, column);
    if (!colExists) fail(`Column '${column}' does not exist for this project`);

    const now = Date.now();

    db.transaction(() => {
      // Add completion comment if provided
      if (comment) {
        db.prepare(
          `INSERT INTO ticket_comments (id, ticket_id, type, author, body, created_at)
           VALUES (?, ?, 'complete', ?, ?, ?)`
        ).run(randomId(), ticketId, author, comment, now);
      }

      // Move ticket
      db.prepare(
        `INSERT INTO ticket_comments (id, ticket_id, type, author, body, meta, created_at)
         VALUES (?, ?, 'move', ?, ?, ?, ?)`
      ).run(randomId(), ticketId, author, `Moved to ${column}`, JSON.stringify({ to_column: column }), now);

      db.prepare(
        `UPDATE tickets SET "column" = ?, claimed_by_run_id = NULL, claimed_at = NULL, updated_at = ?
         WHERE id = ? AND project_id = ?`
      ).run(column, now, ticketId, projectId);

      // Update heartbeat so scheduler picks up the change
      db.prepare(
        `UPDATE project_heartbeats SET next_check_at = ?, updated_at = ? WHERE project_id = ?`
      ).run(now + 5000, now, projectId);
    })();

    // Best-effort wake the scheduler's in-memory timer via the API
    wakeScheduler();

    console.log(JSON.stringify({ status: 'moved', column }));
  },

  claim() {
    const [ticketId, runId] = requireArgs(args, 2, 'claim <ticket-id> <run-id>');
    const ticket = db.prepare(
      'SELECT claimed_by_run_id FROM tickets WHERE id = ? AND project_id = ?'
    ).get(ticketId, projectId);
    if (!ticket) fail(`Ticket not found: ${ticketId}`);
    if (ticket.claimed_by_run_id && ticket.claimed_by_run_id !== runId) {
      fail(`Ticket already claimed by run ${ticket.claimed_by_run_id}`);
    }
    const now = Date.now();
    db.prepare(
      `UPDATE tickets SET claimed_by_run_id = ?, claimed_at = ?, updated_at = ?
       WHERE id = ? AND project_id = ?`
    ).run(runId, now, now, ticketId, projectId);
    console.log(JSON.stringify({ status: 'claimed' }));
  },

  release() {
    const [ticketId] = requireArgs(args, 1, 'release <ticket-id>');
    const now = Date.now();
    db.prepare(
      `UPDATE tickets SET claimed_by_run_id = NULL, claimed_at = NULL, updated_at = ?
       WHERE id = ? AND project_id = ?`
    ).run(now, ticketId, projectId);
    console.log(JSON.stringify({ status: 'released' }));
  },
};

// Guard: only dispatch to explicitly defined commands. Object.hasOwn
// prevents prototype pollution (e.g. command='__proto__' or 'toString').
if (!command || !Object.hasOwn(commands, command)) {
  console.error(`Usage: ticket.cjs <command> [args]`);
  console.error(`Commands: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}

try {
  commands[command]();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
} finally {
  db.close();
}

// --- helpers ---

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

function requireArgs(arr, count, usage) {
  if (arr.length < count) {
    fail(`Usage: ${usage}`);
  }
  return arr;
}

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function randomId() {
  return require('crypto').randomUUID();
}

function verifyTicketScope(ticketId) {
  const row = db.prepare('SELECT 1 FROM tickets WHERE id = ? AND project_id = ?').get(ticketId, projectId);
  if (!row) fail(`Ticket not found or not in this project: ${ticketId}`);
}

function validateCommentType(type) {
  const valid = ['comment', 'journal', 'block', 'finding', 'complete'];
  if (!valid.includes(type)) {
    fail(`Invalid comment type: ${type}. Must be one of: ${valid.join(', ')}`);
  }
}

function wakeScheduler() {
  // Fire-and-forget. If the daemon isn't running or the fetch fails,
  // the scheduler picks up the DB change on its next heartbeat anyway.
  try {
    fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});
  } catch {
    // fetch not available (Node < 18) or other error — ignore
  }
}
