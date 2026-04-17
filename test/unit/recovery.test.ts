// Tests for crash recovery — verifies that orphaned agent runs are
// cleaned up and their tickets are moved to the human column.

import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import pino from 'pino';
import { openDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedBuiltins } from '../../src/db/seed.js';
import { createProject } from '../../src/db/queries/projects.js';
import { createTicket, moveTicket, getTicketWithComments } from '../../src/db/queries/tickets.js';
import { recoverFromCrash } from '../../src/daemon/recovery.js';
import { randomUUID } from 'node:crypto';

const silentLogger = pino({ level: 'silent' });
let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  seedBuiltins(db);
});

describe('recoverFromCrash', () => {
  it('returns zeros on a clean database with no orphaned runs', async () => {
    const result = await recoverFromCrash(db, silentLogger);
    expect(result.orphanedRuns).toBe(0);
    expect(result.releasedTickets).toBe(0);
    expect(result.movedToHuman).toBe(0);
  });

  it('marks orphaned runs as crashed and releases ticket claims', async () => {
    const project = createProject(db, {
      name: 'Test',
      path: '/tmp/recovery-test',
      projectTypeId: 'software-dev',
    });
    const ticket = createTicket(db, { projectId: project.id, title: 'Recovery test' });
    moveTicket(db, ticket.id, { toColumn: 'coding-agent' });

    // Simulate an in-progress agent run
    const runId = randomUUID();
    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status)
       VALUES (?, ?, 'coding-agent', 'claude-opus-4-6', ?, 'running')`,
    ).run(runId, ticket.id, Date.now());

    // Simulate the agent claiming the ticket
    db.prepare(
      'UPDATE tickets SET claimed_by_run_id = ?, claimed_at = ? WHERE id = ?',
    ).run(runId, Date.now(), ticket.id);

    // Now simulate a daemon crash — run recovery
    const result = await recoverFromCrash(db, silentLogger);

    expect(result.orphanedRuns).toBe(1);
    expect(result.releasedTickets).toBe(1);
    expect(result.movedToHuman).toBe(1);

    // Verify the run is marked as crashed
    const run = db.prepare('SELECT exit_status, error_message FROM agent_runs WHERE id = ?').get(runId) as {
      exit_status: string;
      error_message: string;
    };
    expect(run.exit_status).toBe('crashed');
    expect(run.error_message).toContain('Daemon crashed');

    // Verify the ticket is unclaimed and in the human column
    const recovered = getTicketWithComments(db, ticket.id);
    expect(recovered).not.toBeNull();
    expect(recovered!.column).toBe('human');
    expect(recovered!.claimed_by_run_id).toBeNull();

    // Verify the thread has a move comment and a block comment
    const moveComment = recovered!.comments.find(
      (c) => c.type === 'move' && c.author === 'system:recovery',
    );
    expect(moveComment).toBeDefined();
    expect(moveComment!.body).toContain("Moved from 'coding-agent' to 'human'");

    const blockComment = recovered!.comments.find(
      (c) => c.type === 'block' && c.author === 'system:recovery',
    );
    expect(blockComment).toBeDefined();
    expect(blockComment!.body).toContain('interrupted by a daemon crash');
  });

  it('does not move a ticket that is already in the human column', async () => {
    const project = createProject(db, {
      name: 'Test2',
      path: '/tmp/recovery-test-2',
      projectTypeId: 'software-dev',
    });
    const ticket = createTicket(db, { projectId: project.id, title: 'Already human' });
    // Ticket starts in 'human' column by default

    // Simulate an orphaned run (edge case — shouldn't happen in practice)
    const runId = randomUUID();
    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status)
       VALUES (?, ?, 'coding-agent', 'claude-opus-4-6', ?, 'running')`,
    ).run(runId, ticket.id, Date.now());
    db.prepare(
      'UPDATE tickets SET claimed_by_run_id = ? WHERE id = ?',
    ).run(runId, ticket.id);

    const result = await recoverFromCrash(db, silentLogger);

    expect(result.orphanedRuns).toBe(1);
    expect(result.movedToHuman).toBe(0); // Already in human — no move

    const recovered = getTicketWithComments(db, ticket.id);
    expect(recovered!.column).toBe('human');
    // Should have a block comment but no move comment
    const moveComments = recovered!.comments.filter(
      (c) => c.type === 'move' && c.author === 'system:recovery',
    );
    expect(moveComments).toHaveLength(0);
  });

  it('is idempotent — running twice does not double-recover', async () => {
    const project = createProject(db, {
      name: 'Test3',
      path: '/tmp/recovery-test-3',
      projectTypeId: 'software-dev',
    });
    const ticket = createTicket(db, { projectId: project.id, title: 'Idempotent' });
    moveTicket(db, ticket.id, { toColumn: 'coding-agent' });

    const runId = randomUUID();
    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status)
       VALUES (?, ?, 'coding-agent', 'claude-opus-4-6', ?, 'running')`,
    ).run(runId, ticket.id, Date.now());

    const first = await recoverFromCrash(db, silentLogger);
    expect(first.orphanedRuns).toBe(1);

    const second = await recoverFromCrash(db, silentLogger);
    expect(second.orphanedRuns).toBe(0); // Already recovered
  });

  it('leaves detached agents with alive PIDs running', async () => {
    const project = createProject(db, {
      name: 'Detached',
      path: '/tmp/recovery-detached',
      projectTypeId: 'software-dev',
    });
    const ticket = createTicket(db, { projectId: project.id, title: 'Detached alive' });
    moveTicket(db, ticket.id, { toColumn: 'coding-agent' });

    const runId = randomUUID();
    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status, pid)
       VALUES (?, ?, 'coding-agent', 'claude-opus-4-6', ?, 'running', ?)`,
    ).run(runId, ticket.id, Date.now(), process.pid); // current PID = alive

    db.prepare(
      'UPDATE tickets SET claimed_by_run_id = ?, claimed_at = ? WHERE id = ?',
    ).run(runId, Date.now(), ticket.id);

    const result = await recoverFromCrash(db, silentLogger);

    expect(result.orphanedRuns).toBe(0);
    expect(result.movedToHuman).toBe(0);

    const run = db.prepare('SELECT exit_status FROM agent_runs WHERE id = ?').get(runId) as {
      exit_status: string;
    };
    expect(run.exit_status).toBe('running');

    const ticketRow = db.prepare('SELECT claimed_by_run_id FROM tickets WHERE id = ?').get(ticket.id) as {
      claimed_by_run_id: string | null;
    };
    expect(ticketRow.claimed_by_run_id).toBe(runId);
  });

  it('recovers runs with dead PIDs (process no longer exists)', async () => {
    const project = createProject(db, {
      name: 'DeadPid',
      path: '/tmp/recovery-dead-pid',
      projectTypeId: 'software-dev',
    });
    const ticket = createTicket(db, { projectId: project.id, title: 'Dead PID' });
    moveTicket(db, ticket.id, { toColumn: 'coding-agent' });

    const runId = randomUUID();
    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status, pid)
       VALUES (?, ?, 'coding-agent', 'claude-opus-4-6', ?, 'running', ?)`,
    ).run(runId, ticket.id, Date.now(), 99999999); // dead PID

    const result = await recoverFromCrash(db, silentLogger);

    expect(result.orphanedRuns).toBe(1);
    expect(result.movedToHuman).toBe(1);

    const run = db.prepare('SELECT exit_status FROM agent_runs WHERE id = ?').get(runId) as {
      exit_status: string;
    };
    expect(run.exit_status).toBe('crashed');
  });

  it('recovers runs without a PID (legacy pre-detach rows)', async () => {
    const project = createProject(db, {
      name: 'NoPid',
      path: '/tmp/recovery-no-pid',
      projectTypeId: 'software-dev',
    });
    const ticket = createTicket(db, { projectId: project.id, title: 'No PID legacy' });
    moveTicket(db, ticket.id, { toColumn: 'coding-agent' });

    const runId = randomUUID();
    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status)
       VALUES (?, ?, 'coding-agent', 'claude-opus-4-6', ?, 'running')`,
    ).run(runId, ticket.id, Date.now()); // no PID column value

    const result = await recoverFromCrash(db, silentLogger);

    expect(result.orphanedRuns).toBe(1);

    const run = db.prepare('SELECT exit_status FROM agent_runs WHERE id = ?').get(runId) as {
      exit_status: string;
    };
    expect(run.exit_status).toBe('crashed');
  });
});
