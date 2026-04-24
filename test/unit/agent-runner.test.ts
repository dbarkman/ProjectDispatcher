import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  runAgent,
  getActiveCount,
  getGlobalActiveCount,
} from '../../src/daemon/agent-runner.js';
import { configSchema } from '../../src/config.schema.js';
import { randomUUID } from 'node:crypto';

vi.mock('../../src/daemon/worktree.js', () => ({
  createWorktree: vi.fn(),
  isGitReady: vi.fn().mockResolvedValue(true),
  mergeAndCleanup: vi.fn(),
  removeWorktree: vi.fn(),
  worktreePath: vi.fn(),
  worktreeBranch: vi.fn(),
}));

import { createWorktree, isGitReady } from '../../src/daemon/worktree.js';

const silentLogger = pino({ level: 'silent' });
let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  seedBuiltins(db);
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

  it('finalizes timed-out detached agent as timeout, not crashed', async () => {
    const now = Date.now();
    vi.useFakeTimers({ now });

    const project = createProject(db, {
      name: 'Timeout',
      path: '/tmp/timeout-test',
      projectTypeId: 'software-dev',
    });
    const ticket = createTicket(db, { projectId: project.id, title: 'Timeout test' });
    moveTicket(db, ticket.id, { toColumn: 'coding-agent' });

    const runId = randomUUID();
    // PID 1 (launchd/init) — always alive via EPERM, SIGTERM/SIGKILL throw EPERM (caught)
    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status, pid)
       VALUES (?, ?, 'coding-agent', 'claude-opus-4-6', ?, 'running', ?)`,
    ).run(runId, ticket.id, now - 2 * 60 * 60 * 1000, 1);

    db.prepare(
      'UPDATE tickets SET claimed_by_run_id = ?, claimed_at = ? WHERE id = ?',
    ).run(runId, now, ticket.id);

    initActiveRuns(db);
    reapDetachedRuns(db, silentLogger);

    // Before grace period — still running (finalizeRun deferred to setTimeout)
    const runBefore = db.prepare('SELECT exit_status FROM agent_runs WHERE id = ?').get(runId) as {
      exit_status: string;
    };
    expect(runBefore.exit_status).toBe('running');

    // Advance past 10s SIGKILL grace period
    await vi.advanceTimersByTimeAsync(10_000);

    const runAfter = db.prepare('SELECT exit_status, error_message FROM agent_runs WHERE id = ?').get(runId) as {
      exit_status: string;
      error_message: string;
    };
    expect(runAfter.exit_status).toBe('timeout');
    expect(runAfter.error_message).toContain('Timed out');

    vi.useRealTimers();
  });
});

describe('runAgent concurrency reservation', () => {
  // Without the sync reservation, two concurrent runAgent calls (e.g. two
  // projects' heartbeats firing on the same tick) could both pass the cap
  // check before either reached trackRun, because createWorktree is async
  // and yields the event loop. Regression test for that race.

  const baseConfig = configSchema.parse({
    agents: { max_concurrent_per_project: 1, max_concurrent_global: 10, parallel_coding: true },
    ai: { auth_method: 'oauth' },
  });

  it('reserves the slot synchronously, before the first await', async () => {
    const project = createProject(db, {
      name: 'RaceProject',
      path: '/tmp/race-project',
      projectTypeId: 'software-dev',
    });
    const ticket = createTicket(db, { projectId: project.id, title: 'Race test' });
    moveTicket(db, ticket.id, { toColumn: 'coding-agent' });

    const codingAgentType = { id: 'coding-agent' };

    // Make isGitReady throw so runAgent rejects without spawning —
    // simulates any pre-spawn failure after the slot has been reserved.
    // (createWorktree failures are now caught by the fallback path, so
    // we use isGitReady — the first await after slot reservation.)
    vi.mocked(isGitReady).mockRejectedValueOnce(new Error('mocked git check failure'));

    // Kick off runAgent without awaiting. Everything up to the first await
    // (isGitReady) runs synchronously in the executor, including the
    // sync cap checks and the reservation. If the reservation is AFTER the
    // first await (the bug), getActiveCount would still be 0 at this point.
    const promise = runAgent(
      { projectId: project.id, agentTypeId: codingAgentType.id, ticketId: ticket.id },
      db,
      baseConfig,
      silentLogger,
    );

    expect(getActiveCount(project.id)).toBe(1);

    // Propagates the mocked failure; catch path must release the slot.
    await expect(promise).rejects.toThrow('mocked git check failure');
    expect(getActiveCount(project.id)).toBe(0);
  });

  it('rejects a second concurrent call when per-project cap is already held', async () => {
    const project = createProject(db, {
      name: 'CapProject',
      path: '/tmp/cap-project',
      projectTypeId: 'software-dev',
    });
    const ticketA = createTicket(db, { projectId: project.id, title: 'A' });
    const ticketB = createTicket(db, { projectId: project.id, title: 'B' });
    moveTicket(db, ticketA.id, { toColumn: 'coding-agent' });
    moveTicket(db, ticketB.id, { toColumn: 'coding-agent' });

    const codingAgentType = { id: 'coding-agent' };

    // First call: never resolves (suspended inside createWorktree await).
    // This is the critical window during which the race would fire in the
    // old code — trackRun would not have happened yet, so the second call
    // would also pass the cap check.
    let releaseFirstWorktree: () => void = () => undefined;
    const firstWorktreeGate = new Promise<string>((resolve) => {
      releaseFirstWorktree = () => resolve('/tmp/cap-project/.worktrees/a');
    });
    vi.mocked(createWorktree).mockImplementationOnce(() => firstWorktreeGate);

    const firstPromise = runAgent(
      { projectId: project.id, agentTypeId: codingAgentType.id, ticketId: ticketA.id },
      db,
      baseConfig,
      silentLogger,
    );

    // Yield once so the executor reaches the createWorktree await.
    await Promise.resolve();

    // Second call must reject immediately on the cap check — slot A is held.
    await expect(
      runAgent(
        { projectId: project.id, agentTypeId: codingAgentType.id, ticketId: ticketB.id },
        db,
        baseConfig,
        silentLogger,
      ),
    ).rejects.toThrow('Concurrency limit reached');

    // Release A's worktree so the first promise can settle. We swallow
    // whatever outcome it reaches (most likely a spawn failure on the real
    // claude binary path under the test environment) — this test only
    // asserts the cap-check behavior for the second call.
    releaseFirstWorktree();
    await firstPromise.catch(() => undefined);
  });
});
