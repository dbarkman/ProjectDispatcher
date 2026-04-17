import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedBuiltins } from '../../src/db/seed.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { Scheduler } from '../../src/daemon/scheduler.js';
import { createHttpServer } from '../../src/daemon/http.js';
import { createProject } from '../../src/db/queries/projects.js';
import { createTicket } from '../../src/db/queries/tickets.js';
import type { ConfigRef } from '../../src/config.schema.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let db: Database;
let tmpDir: string;
let configRef: ConfigRef;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  seedBuiltins(db);

  tmpDir = mkdtempSync(join(tmpdir(), 'pd-hotreload-test-'));
  const config = loadConfig(join(tmpDir, 'nonexistent.json'));
  configRef = { current: config };
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function insertAgentRun(database: Database, ticketId: string, agentTypeId: string): void {
  database.prepare(
    `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status)
     VALUES (?, ?, ?, 'claude-sonnet-4-6', ?, 'success')`,
  ).run(randomUUID(), ticketId, agentTypeId, Date.now());
}

describe('configRef hot-reload: scheduler circuit breaker', () => {
  it('circuit breaker trips at threshold, then stops tripping after threshold is raised', async () => {
    const logger = createLogger(join(tmpDir, 'logs'));
    configRef.current = {
      ...configRef.current,
      agents: { ...configRef.current.agents, circuit_breaker_max_runs: 1 },
    };
    const scheduler = new Scheduler(db, configRef, logger);

    const project = createProject(db, { name: 'HotReload', path: '/hotreload', projectTypeId: 'software-dev' });
    const ticket = createTicket(db, {
      projectId: project.id,
      title: 'Test ticket',
      column: 'coding-agent',
      createdBy: 'human',
    });

    insertAgentRun(db, ticket.id, 'coding-agent');

    // handleHeartbeat is private — access via any for testing
    await (scheduler as unknown as { handleHeartbeat(id: string): Promise<void> }).handleHeartbeat(project.id);

    const afterTrip = db.prepare('SELECT "column" FROM tickets WHERE id = ?').get(ticket.id) as { column: string };
    expect(afterTrip.column).toBe('human');

    // Now create a second ticket with the same run count, raise threshold
    const ticket2 = createTicket(db, {
      projectId: project.id,
      title: 'Test ticket 2',
      column: 'coding-agent',
      createdBy: 'human',
    });
    insertAgentRun(db, ticket2.id, 'coding-agent');

    configRef.current = {
      ...configRef.current,
      agents: { ...configRef.current.agents, circuit_breaker_max_runs: 10 },
    };

    await (scheduler as unknown as { handleHeartbeat(id: string): Promise<void> }).handleHeartbeat(project.id);

    // Ticket should NOT have moved to human — circuit breaker threshold raised
    const afterRaise = db.prepare('SELECT "column" FROM tickets WHERE id = ?').get(ticket2.id) as { column: string };
    expect(afterRaise.column).not.toBe('human');

    scheduler.stop();
  });

  it('scheduler reads updated heartbeat config for backoff calculation', async () => {
    const logger = createLogger(join(tmpDir, 'logs'));
    const scheduler = new Scheduler(db, configRef, logger);

    const project = createProject(db, { name: 'Backoff', path: '/backoff', projectTypeId: 'software-dev' });

    // Trigger a heartbeat with no work → applyBackoff uses configRef.current.heartbeat
    await (scheduler as unknown as { handleHeartbeat(id: string): Promise<void> }).handleHeartbeat(project.id);

    // Change base_interval to something very different
    configRef.current = {
      ...configRef.current,
      heartbeat: { ...configRef.current.heartbeat, base_interval_seconds: 1 },
    };

    // Reset empty checks so both heartbeats are at the same backoff step
    db.prepare('UPDATE project_heartbeats SET consecutive_empty_checks = 0 WHERE project_id = ?')
      .run(project.id);

    const beforeSecond = Date.now();
    await (scheduler as unknown as { handleHeartbeat(id: string): Promise<void> }).handleHeartbeat(project.id);

    const state2 = db.prepare('SELECT next_check_at FROM project_heartbeats WHERE project_id = ?')
      .get(project.id) as { next_check_at: number };

    // With base=1s and multiplier=2, backoff step 1 = 1*2^1 = 2s
    // With base=300s (default), backoff step 1 = 300*2^1 = 600s
    // The new next_check_at should be much closer to now than the first one
    const intervalMs = state2.next_check_at - beforeSecond;
    expect(intervalMs).toBeLessThan(10_000); // 2s backoff, not 600s

    scheduler.stop();
  });
});

describe('PATCH /api/config restart_required', () => {
  let app: FastifyInstance;
  let cfgPath: string;

  beforeEach(async () => {
    cfgPath = join(tmpDir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ ai: { auth_method: 'oauth' } }));
    configRef = { current: loadConfig(cfgPath) };
    const logger = createLogger(join(tmpDir, 'logs'));
    app = await createHttpServer({ configRef, db, logger });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns restart_required: true when patching ui.port', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { ui: { port: 9999 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.restart_required).toBe(true);
  });

  it('returns restart_required: true when patching claude_cli.binary_path', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { claude_cli: { binary_path: '/usr/local/bin/claude' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.restart_required).toBe(true);
  });

  it('returns restart_required: true when patching discovery.root_path', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { discovery: { root_path: '/some/other/path' } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.restart_required).toBe(true);
  });

  it('returns restart_required: false when patching hot-reloadable fields', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { agents: { circuit_breaker_max_runs: 5 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.restart_required).toBe(false);
  });

  it('updates configRef.current atomically on PATCH', async () => {
    const oldMax = configRef.current.agents.circuit_breaker_max_runs;

    await app.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { agents: { circuit_breaker_max_runs: 7 } },
    });

    expect(configRef.current.agents.circuit_breaker_max_runs).toBe(7);
    expect(configRef.current.agents.circuit_breaker_max_runs).not.toBe(oldMax);
  });

  it('GET /api/config reflects hot-reloaded values', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/config',
      payload: { heartbeat: { base_interval_seconds: 120 } },
    });

    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json().heartbeat.base_interval_seconds).toBe(120);
  });
});
