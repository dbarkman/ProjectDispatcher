// MVP-42: Agent round-trip smoke test.
//
// Exercises the core loop: create project → create ticket → seed agent
// run → verify MCP tools work against the DB → verify ticket moves
// through the workflow.
//
// Does NOT spawn a real `claude -p` subprocess — that's MVP-43 (dogfood).
// Instead, exercises the MCP tool functions directly against the DB
// to prove the data flow: claim → comment → move → verify.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedBuiltins } from '../../src/db/seed.js';
import { createProject } from '../../src/db/queries/projects.js';
import {
  createTicket,
  getTicket,
  getTicketWithComments,
  moveTicket,
  addComment,
} from '../../src/db/queries/tickets.js';
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  seedBuiltins(db);
});

afterEach(() => {
  db.close();
});

describe('Agent round-trip smoke test', () => {
  it('full workflow: human → coding-agent → code-reviewer → security-reviewer → merging → done', () => {
    // 1. Create a project
    const project = createProject(db, {
      name: 'Smoke Test Project',
      path: '/tmp/smoke-test',
      projectTypeId: 'software-dev',
    });
    expect(project.status).toBe('active');

    // 2. Human creates a ticket
    const ticket = createTicket(db, {
      projectId: project.id,
      title: 'Implement feature X',
      body: 'Build a new feature for the smoke test',
    });
    expect(ticket.column).toBe('human');

    // 3. Human moves ticket to coding-agent
    moveTicket(db, ticket.id, {
      toColumn: 'coding-agent',
      comment: 'Ready for coding',
      author: 'human',
    });

    // Verify heartbeat was reset for the agent column
    const afterMove = db
      .prepare('SELECT next_check_at, consecutive_empty_checks FROM project_heartbeats WHERE project_id = ?')
      .get(project.id) as { next_check_at: number; consecutive_empty_checks: number };
    expect(afterMove.consecutive_empty_checks).toBe(0);

    // 4. Simulate coding agent: claim → do work → comment → move to code-reviewer
    const codingRunId = randomUUID();

    // Create agent_runs row (like agent-runner.ts does)
    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status)
       VALUES (?, ?, 'coding-agent', 'claude-opus-4-6', ?, 'running')`,
    ).run(codingRunId, ticket.id, Date.now());

    // Agent claims the ticket
    db.prepare(
      'UPDATE tickets SET claimed_by_run_id = ?, claimed_at = ?, updated_at = ? WHERE id = ?',
    ).run(codingRunId, Date.now(), Date.now(), ticket.id);

    const claimed = getTicket(db, ticket.id);
    expect(claimed!.claimed_by_run_id).toBe(codingRunId);

    // Agent adds a journal comment
    addComment(db, ticket.id, {
      type: 'journal',
      author: `agent:coding-agent:${codingRunId}`,
      body: 'Starting implementation of feature X',
    });

    // Agent completes and moves to code-reviewer
    addComment(db, ticket.id, {
      type: 'complete',
      author: `agent:coding-agent:${codingRunId}`,
      body: 'Feature X implemented. Commits: abc123, def456. Tests added.',
    });

    moveTicket(db, ticket.id, {
      toColumn: 'code-reviewer',
      comment: 'Ready for code review',
      author: `agent:coding-agent:${codingRunId}`,
    });

    // Release claim
    db.prepare(
      'UPDATE tickets SET claimed_by_run_id = NULL, claimed_at = NULL WHERE id = ?',
    ).run(ticket.id);

    // Mark run as success
    db.prepare(
      "UPDATE agent_runs SET exit_status = 'success', ended_at = ? WHERE id = ?",
    ).run(Date.now(), codingRunId);

    // 5. Simulate code reviewer: review → move to security-reviewer
    const reviewRunId = randomUUID();
    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status)
       VALUES (?, ?, 'code-reviewer', 'claude-opus-4-6', ?, 'running')`,
    ).run(reviewRunId, ticket.id, Date.now());

    addComment(db, ticket.id, {
      type: 'finding',
      author: `agent:code-reviewer:${reviewRunId}`,
      body: '**[LOW]** Minor naming issue in utils.ts:42',
      meta: { severity: 'low', title: 'Naming issue' },
    });

    addComment(db, ticket.id, {
      type: 'complete',
      author: `agent:code-reviewer:${reviewRunId}`,
      body: 'Code review complete. 1 LOW finding. Clear to proceed.',
    });

    moveTicket(db, ticket.id, {
      toColumn: 'security-reviewer',
      author: `agent:code-reviewer:${reviewRunId}`,
    });

    db.prepare("UPDATE agent_runs SET exit_status = 'success', ended_at = ? WHERE id = ?")
      .run(Date.now(), reviewRunId);

    // 6. Simulate security reviewer: review → move to merging
    const secRunId = randomUUID();
    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status)
       VALUES (?, ?, 'security-reviewer', 'claude-opus-4-6', ?, 'running')`,
    ).run(secRunId, ticket.id, Date.now());

    addComment(db, ticket.id, {
      type: 'complete',
      author: `agent:security-reviewer:${secRunId}`,
      body: 'Security review: clean. No findings.',
    });

    moveTicket(db, ticket.id, {
      toColumn: 'merging',
      author: `agent:security-reviewer:${secRunId}`,
    });

    db.prepare("UPDATE agent_runs SET exit_status = 'success', ended_at = ? WHERE id = ?")
      .run(Date.now(), secRunId);

    // 7. Simulate merge agent: merge → move to done
    const mergeRunId = randomUUID();
    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status)
       VALUES (?, ?, 'merge-agent', 'claude-opus-4-7', ?, 'running')`,
    ).run(mergeRunId, ticket.id, Date.now());

    addComment(db, ticket.id, {
      type: 'complete',
      author: `agent:merge-agent:${mergeRunId}`,
      body: 'Branch merged into main. No conflicts.',
    });

    moveTicket(db, ticket.id, {
      toColumn: 'done',
      author: `agent:merge-agent:${mergeRunId}`,
    });

    db.prepare("UPDATE agent_runs SET exit_status = 'success', ended_at = ? WHERE id = ?")
      .run(Date.now(), mergeRunId);

    // 8. Verify final state
    const finalTicket = getTicketWithComments(db, ticket.id);
    expect(finalTicket).not.toBeNull();
    expect(finalTicket!.column).toBe('done');
    expect(finalTicket!.claimed_by_run_id).toBeNull(); // not claimed

    // Full thread should have all comments in order
    const thread = finalTicket!.comments;
    expect(thread.length).toBeGreaterThanOrEqual(9); // 4 move + 3 complete + 1 journal + 1 finding

    // Verify agent_runs are all successful
    const runs = db
      .prepare("SELECT exit_status FROM agent_runs WHERE ticket_id = ? ORDER BY started_at")
      .all(ticket.id) as Array<{ exit_status: string }>;
    expect(runs).toHaveLength(4);
    expect(runs.every((r) => r.exit_status === 'success')).toBe(true);

    // Verify the complete workflow: human → coding → review → security → merging → done
    const moveComments = thread.filter((c) => c.type === 'move');
    const columnSequence = moveComments.map((c) => {
      const meta = JSON.parse(c.meta!) as { to_column: string };
      return meta.to_column;
    });
    expect(columnSequence).toEqual([
      'coding-agent',
      'code-reviewer',
      'security-reviewer',
      'merging',
      'done',
    ]);
  });

  it('agent failure: crash releases claim and adds block comment', () => {
    const project = createProject(db, {
      name: 'Fail Test',
      path: '/tmp/fail-test',
      projectTypeId: 'software-dev',
    });

    const ticket = createTicket(db, { projectId: project.id, title: 'Will crash' });
    moveTicket(db, ticket.id, { toColumn: 'coding-agent' });

    const runId = randomUUID();
    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status)
       VALUES (?, ?, 'coding-agent', 'claude-opus-4-6', ?, 'running')`,
    ).run(runId, ticket.id, Date.now());

    // Agent claims
    db.prepare(
      'UPDATE tickets SET claimed_by_run_id = ?, claimed_at = ? WHERE id = ?',
    ).run(runId, Date.now(), ticket.id);

    // Simulate crash: mark run as crashed, release claim, add block comment
    db.prepare("UPDATE agent_runs SET exit_status = 'crashed', ended_at = ?, error_message = ? WHERE id = ?")
      .run(Date.now(), 'Exited with code 1', runId);
    db.prepare(
      'UPDATE tickets SET claimed_by_run_id = NULL, claimed_at = NULL WHERE id = ? AND claimed_by_run_id = ?',
    ).run(ticket.id, runId);
    addComment(db, ticket.id, {
      type: 'block',
      author: `agent:coding-agent:${runId}`,
      body: 'Agent crashed. Needs human attention.',
    });

    // Move back to human (like the agent-runner failure path does)
    // Actually the agent-runner doesn't move — it just releases + block comment.
    // The ticket stays in coding-agent column with a block comment.

    // Verify: ticket is unclaimed, has block comment
    const final = getTicketWithComments(db, ticket.id);
    expect(final!.claimed_by_run_id).toBeNull();
    const blockComment = final!.comments.find((c) => c.type === 'block');
    expect(blockComment).toBeDefined();
    expect(blockComment!.body).toContain('crashed');

    // Run is marked crashed
    const run = db.prepare('SELECT exit_status FROM agent_runs WHERE id = ?').get(runId) as { exit_status: string };
    expect(run.exit_status).toBe('crashed');
  });
});
