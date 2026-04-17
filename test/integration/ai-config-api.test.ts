import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedBuiltins } from '../../src/db/seed.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createHttpServer } from '../../src/daemon/http.js';
import type { Database } from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app: FastifyInstance;
let db: Database;
let tmpDir: string;
let configPath: string;

beforeEach(async () => {
  db = openDatabase(':memory:');
  runMigrations(db);
  seedBuiltins(db);

  tmpDir = mkdtempSync(join(tmpdir(), 'pd-ai-test-'));
  configPath = join(tmpDir, 'config.json');
  const config = loadConfig(configPath);
  const logger = createLogger(join(tmpDir, 'logs'));

  app = await createHttpServer({ config, db, logger });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Setup wizard redirect', () => {
  it('redirects / to /ui/setup when ai.auth_method not configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/ui/setup');
  });

  it('redirects /ui/projects to /ui/setup when unconfigured', async () => {
    const res = await app.inject({ method: 'GET', url: '/ui/projects' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/ui/setup');
  });

  it('does NOT redirect /api/ routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });

  it('does NOT redirect /ui/setup itself', async () => {
    const res = await app.inject({ method: 'GET', url: '/ui/setup' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });

  it('does NOT redirect /static/ assets', async () => {
    const res = await app.inject({ method: 'GET', url: '/static/style.css' });
    expect(res.statusCode).toBe(200);
  });
});

describe('Setup wizard redirect with configured auth', () => {
  let configuredApp: FastifyInstance;
  let configuredDb: Database;
  let configuredTmpDir: string;

  beforeEach(async () => {
    configuredDb = openDatabase(':memory:');
    runMigrations(configuredDb);
    seedBuiltins(configuredDb);

    configuredTmpDir = mkdtempSync(join(tmpdir(), 'pd-ai-configured-'));
    const cfgPath = join(configuredTmpDir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ ai: { auth_method: 'oauth' } }));
    const config = loadConfig(cfgPath);
    const logger = createLogger(join(configuredTmpDir, 'logs'));

    configuredApp = await createHttpServer({ config, db: configuredDb, logger });
    await configuredApp.ready();
  });

  afterEach(async () => {
    await configuredApp.close();
    configuredDb.close();
    rmSync(configuredTmpDir, { recursive: true, force: true });
  });

  it('does NOT redirect when auth_method is configured', async () => {
    const res = await configuredApp.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });
});

describe('AI config detect-oauth endpoint', () => {
  it('GET /api/config/ai/detect-oauth returns detected status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config/ai/detect-oauth' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.detected).toBe('boolean');
  });
});

describe('AI config test endpoint', () => {
  it('rejects api_key method without key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/ai/test',
      payload: { auth_method: 'api_key' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/API key required/);
  });

  it('rejects custom method without base_url', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/ai/test',
      payload: { auth_method: 'custom', api_key: 'sk-test' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/base URL required/);
  });

  it('rejects invalid auth_method', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/ai/test',
      payload: { auth_method: 'magic' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('AI config save endpoint', () => {
  it('rejects api_key method without key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/ai',
      payload: { auth_method: 'api_key' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/API key required/);
  });

  it('rejects custom method without base_url', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/ai',
      payload: { auth_method: 'custom', api_key: 'sk-test' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/base URL required/);
  });
});

describe('Setup wizard page', () => {
  it('renders the setup wizard HTML', async () => {
    const res = await app.inject({ method: 'GET', url: '/ui/setup' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.body).toContain('Welcome to Project Dispatcher');
    expect(res.body).toContain('Authentication Method');
  });
});

describe('Settings page AI provider section', () => {
  let configuredApp: FastifyInstance;
  let configuredDb: Database;
  let configuredTmpDir: string;

  beforeEach(async () => {
    configuredDb = openDatabase(':memory:');
    runMigrations(configuredDb);
    seedBuiltins(configuredDb);

    configuredTmpDir = mkdtempSync(join(tmpdir(), 'pd-settings-ai-'));
    const cfgPath = join(configuredTmpDir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ ai: { auth_method: 'oauth' } }));
    const config = loadConfig(cfgPath);
    const logger = createLogger(join(configuredTmpDir, 'logs'));

    configuredApp = await createHttpServer({ config, db: configuredDb, logger });
    await configuredApp.ready();
  });

  afterEach(async () => {
    await configuredApp.close();
    configuredDb.close();
    rmSync(configuredTmpDir, { recursive: true, force: true });
  });

  it('settings page shows AI Provider section', async () => {
    const res = await configuredApp.inject({ method: 'GET', url: '/ui/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('AI Provider');
    expect(res.body).toContain('settings-auth-method');
    expect(res.body).toContain('Test Connection');
  });
});
