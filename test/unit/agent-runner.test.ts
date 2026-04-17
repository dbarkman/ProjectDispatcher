import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import pino from 'pino';
import { openDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedBuiltins } from '../../src/db/seed.js';
import { createProject } from '../../src/db/queries/projects.js';
import { createTicket, moveTicket } from '../../src/db/queries/tickets.js';
import {
  initActiveRuns,
  reapDetachedRuns,
  isProcessAlive,
  getActiveCount,
  getGlobalActiveCount,
} from '../../src/daemon/agent-runner.js';
import { randomUUID } from 'node:crypto';

const silentLogger = pino({ level: 'silent' });
let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  seedBuiltins(db);
});

describe('isProcessAlive', () => {
  it('returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('returns false for a non-existent PID', () => {
    // PID 99999999 almost certainly doesn't exist
    expect(isProcessAlive(99999999)).toBe(false);
  });
});

describe('initActiveRuns', () => {
  it('rebuilds activeRuns map from DB', () => {
    const project = createProject(db, {
      name: 'Test',
      path: '/tmp/init-test',
      projectTypeId: 'software-dev',
    });
    const ticket = createTicket(db, { projectId: project.id, title: 'Init test' });
    moveTicket(db, ticket.id, { toColumn: 'coding-agent' });

    const runId1 = randomUUID();
    const runId2 = randomUUID();
    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status, pid)
       VALUES (?, ?, 'coding-agent', 'claude-opus-4-6', ?, 'running', ?)`,
    ).run(runId1, ticket.id, Date.now(), 12345);

    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status, pid)
       VALUES (?, ?, 'coding-agent', 'claude-opus-4-6', ?, 'success', ?)`,
    ).run(runId2, ticket.id, Date.now(), 12346);

    initActiveRuns(db);

    expect(getActiveCount(project.id)).toBe(1);
    expect(getGlobalActiveCount()).toBe(1);
  });

  it('clears previous state before rebuilding', () => {
    const project = createProject(db, {
      name: 'Test2',
      path: '/tmp/init-test-2',
      projectTypeId: 'software-dev',
    });
    const ticket = createTicket(db, { projectId: project.id, title: 'Clear test' });

    const runId = randomUUID();
    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status, pid)
       VALUES (?, ?, 'coding-agent', 'claude-opus-4-6', ?, 'running', ?)`,
    ).run(runId, ticket.id, Date.now(), 12345);

    initActiveRuns(db);
    expect(getGlobalActiveCount()).toBe(1);

    // Mark run as completed, rebuild — should be 0
    db.prepare("UPDATE agent_runs SET exit_status = 'success' WHERE id = ?").run(runId);
    initActiveRuns(db);
    expect(getGlobalActiveCount()).toBe(0);
  });
});

describe('reapDetachedRuns', () => {
  it('marks dead-PID runs as crashed', () => {
    const project = createProject(db, {
      name: 'Reap',
      path: '/tmp/reap-test',
      projectTypeId: 'software-dev',
    });
    const ticket = createTicket(db, { projectId: project.id, title: 'Reap test' });
    moveTicket(db, ticket.id, { toColumn: 'coding-agent' });

    const runId = randomUUID();
    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status, pid)
       VALUES (?, ?, 'coding-agent', 'claude-opus-4-6', ?, 'running', ?)`,
    ).run(runId, ticket.id, Date.now(), 99999999);

    db.prepare(
      'UPDATE tickets SET claimed_by_run_id = ?, claimed_at = ? WHERE id = ?',
    ).run(runId, Date.now(), ticket.id);

    initActiveRuns(db);
    expect(getActiveCount(project.id)).toBe(1);

    reapDetachedRuns(db, silentLogger);

    const run = db.prepare('SELECT exit_status, error_message FROM agent_runs WHERE id = ?').get(runId) as {
      exit_status: string;
      error_message: string;
    };
    expect(run.exit_status).toBe('crashed');
    expect(run.error_message).toContain('detached');

    // Ticket claim released
    const ticketRow = db.prepare('SELECT claimed_by_run_id FROM tickets WHERE id = ?').get(ticket.id) as {
      claimed_by_run_id: string | null;
    };
    expect(ticketRow.claimed_by_run_id).toBeNull();

    // Active count decremented
    expect(getActiveCount(project.id)).toBe(0);
  });

  it('leaves alive-PID runs as running', () => {
    const project = createProject(db, {
      name: 'Alive',
      path: '/tmp/alive-test',
      projectTypeId: 'software-dev',
    });
    const ticket = createTicket(db, { projectId: project.id, title: 'Alive test' });

    const runId = randomUUID();
    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status, pid)
       VALUES (?, ?, 'coding-agent', 'claude-opus-4-6', ?, 'running', ?)`,
    ).run(runId, ticket.id, Date.now(), process.pid);

    reapDetachedRuns(db, silentLogger);

    const run = db.prepare('SELECT exit_status FROM agent_runs WHERE id = ?').get(runId) as {
      exit_status: string;
    };
    expect(run.exit_status).toBe('running');
  });

  it('skips runs without a PID', () => {
    const project = createProject(db, {
      name: 'NoPid',
      path: '/tmp/nopid-test',
      projectTypeId: 'software-dev',
    });
    const ticket = createTicket(db, { projectId: project.id, title: 'No PID test' });

    const runId = randomUUID();
    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status)
       VALUES (?, ?, 'coding-agent', 'claude-opus-4-6', ?, 'running')`,
    ).run(runId, ticket.id, Date.now());

    reapDetachedRuns(db, silentLogger);

    // Still running — reaper only processes runs with PIDs
    const run = db.prepare('SELECT exit_status FROM agent_runs WHERE id = ?').get(runId) as {
      exit_status: string;
    };
    expect(run.exit_status).toBe('running');
  });

  it('is idempotent — reaping twice does not double-update', () => {
    const project = createProject(db, {
      name: 'Idempotent',
      path: '/tmp/idempotent-test',
      projectTypeId: 'software-dev',
    });
    const ticket = createTicket(db, { projectId: project.id, title: 'Idempotent test' });

    const runId = randomUUID();
    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status, pid)
       VALUES (?, ?, 'coding-agent', 'claude-opus-4-6', ?, 'running', ?)`,
    ).run(runId, ticket.id, Date.now(), 99999999);

    initActiveRuns(db);
    reapDetachedRuns(db, silentLogger);

    const run1 = db.prepare('SELECT exit_status, ended_at FROM agent_runs WHERE id = ?').get(runId) as {
      exit_status: string;
      ended_at: number;
    };
    expect(run1.exit_status).toBe('crashed');
    const firstEndedAt = run1.ended_at;

    // Second reap — no change
    reapDetachedRuns(db, silentLogger);

    const run2 = db.prepare('SELECT ended_at FROM agent_runs WHERE id = ?').get(runId) as {
      ended_at: number;
    };
    expect(run2.ended_at).toBe(firstEndedAt);
  });
});
