// MVP-41: Integration tests for the HTTP API.
// Uses Fastify's inject() method — no port binding, fast and isolated.
// Each test gets a fresh in-memory DB.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedBuiltins } from '../../src/db/seed.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createHttpServer } from '../../src/daemon/http.js';
import type { Database } from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app: FastifyInstance;
let db: Database;
let tmpDir: string;

beforeEach(async () => {
  db = openDatabase(':memory:');
  runMigrations(db);
  seedBuiltins(db);

  tmpDir = mkdtempSync(join(tmpdir(), 'pd-api-test-'));
  const config = loadConfig(join(tmpDir, 'nonexistent.json'));
  const logger = createLogger(join(tmpDir, 'logs'));

  app = await createHttpServer({ config, db, logger });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Health API', () => {
  it('GET /api/health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.database).toBe('connected');
  });
});

describe('Projects API', () => {
  it('creates, lists, and archives a project', async () => {
    // Create
    const create = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Test', path: '/tmp/test-api', project_type_id: 'software-dev' },
    });
    expect(create.statusCode).toBe(201);
    const project = create.json();
    expect(project.name).toBe('Test');

    // List
    const list = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(list.json()).toHaveLength(1);

    // Archive
    const archive = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}` });
    expect(archive.statusCode).toBe(200);

    // List after archive — should be empty (default excludes archived)
    const listAfter = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(listAfter.json()).toHaveLength(0);
  });

  it('rejects duplicate path with 409', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'A', path: '/dup', project_type_id: 'software-dev' },
    });
    const dup = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'B', path: '/dup', project_type_id: 'software-dev' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('rejects invalid input with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Validation failed');
  });
});

describe('Tickets API', () => {
  let projectId: string;

  beforeEach(async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'TP', path: '/tp-api', project_type_id: 'software-dev' },
    });
    projectId = res.json().id;
  });

  it('full ticket lifecycle: create → move → comment → show thread', async () => {
    // Create
    const create = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      payload: { project_id: projectId, title: 'Lifecycle test' },
    });
    expect(create.statusCode).toBe(201);
    const ticket = create.json();
    expect(ticket.column).toBe('human');

    // Move to coding-agent
    const move = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/move`,
      payload: { to_column: 'coding-agent', comment: 'Start coding' },
    });
    expect(move.statusCode).toBe(200);
    expect(move.json().column).toBe('coding-agent');

    // Add a comment
    await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/comments`,
      payload: { type: 'journal', author: 'agent:coding:r1', body: 'Working...' },
    });

    // Show with thread
    const show = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticket.id}`,
    });
    expect(show.statusCode).toBe(200);
    const full = show.json();
    expect(full.comments).toHaveLength(2); // move comment + journal
    expect(full.comments[0].type).toBe('move');
    expect(full.comments[1].type).toBe('journal');
  });

  it('inbox query returns only human-column tickets', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/tickets',
      payload: { project_id: projectId, title: 'In inbox' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/tickets',
      payload: { project_id: projectId, title: 'Not in inbox', column: 'coding-agent' },
    });

    const inbox = await app.inject({ method: 'GET', url: '/api/tickets?column=human' });
    expect(inbox.json()).toHaveLength(1);
    expect(inbox.json()[0].title).toBe('In inbox');
  });

  it('rejects move to invalid column with 400', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      payload: { project_id: projectId, title: 'Bad move' },
    });
    const ticket = create.json();

    const move = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/move`,
      payload: { to_column: 'nonexistent-column' },
    });
    expect(move.statusCode).toBe(400);
  });

  it('returns 404 for nonexistent ticket', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/tickets/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Config API', () => {
  it('GET /api/config returns defaults', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ui.port).toBe(5757);
  });
});

describe('Project Types API', () => {
  it('lists seeded project types', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/project-types' });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThanOrEqual(5);
  });

  it('rejects deletion of built-in type with 409', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/project-types/software-dev' });
    expect(res.statusCode).toBe(409);
  });
});

describe('Agent Types API', () => {
  it('lists seeded agent types', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agent-types' });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(9);
  });
});
