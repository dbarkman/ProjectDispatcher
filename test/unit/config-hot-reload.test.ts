import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedBuiltins } from '../../src/db/seed.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { Scheduler } from '../../src/daemon/scheduler.js';
import { createHttpServer } from '../../src/daemon/http.js';
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

describe('configRef hot-reload', () => {
  it('scheduler picks up changed circuit_breaker_max_runs without restart', () => {
    const logger = createLogger(join(tmpDir, 'logs'));
    const scheduler = new Scheduler(db, configRef, logger);

    expect(configRef.current.agents.circuit_breaker_max_runs).toBe(3);

    configRef.current = {
      ...configRef.current,
      agents: { ...configRef.current.agents, circuit_breaker_max_runs: 10 },
    };

    expect(configRef.current.agents.circuit_breaker_max_runs).toBe(10);

    scheduler.stop();
  });

  it('scheduler reads updated heartbeat config on next tick', () => {
    const logger = createLogger(join(tmpDir, 'logs'));
    const scheduler = new Scheduler(db, configRef, logger);
    scheduler.start();

    expect(configRef.current.heartbeat.base_interval_seconds).toBe(300);

    configRef.current = {
      ...configRef.current,
      heartbeat: { ...configRef.current.heartbeat, base_interval_seconds: 60 },
    };

    expect(configRef.current.heartbeat.base_interval_seconds).toBe(60);

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
