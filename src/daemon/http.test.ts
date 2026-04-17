import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Sqlite from 'better-sqlite3';
import pino from 'pino';
import { configSchema } from '../config.schema.js';
import { createHttpServer } from './http.js';
import type { FastifyInstance } from 'fastify';

function buildTestServer(port = 5757): Promise<FastifyInstance> {
  const db = new Sqlite(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Minimal tables so routes don't blow up during registration.
  db.exec(`
    CREATE TABLE project_types (id TEXT PRIMARY KEY, name TEXT, columns TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE agent_types (id TEXT PRIMARY KEY, name TEXT, slug TEXT UNIQUE, columns TEXT, system_prompt TEXT, timeout_minutes INTEGER DEFAULT 30, max_retries INTEGER DEFAULT 3, model TEXT DEFAULT 'claude-sonnet-4-6', created_at INTEGER, updated_at INTEGER);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, path TEXT UNIQUE, display_path TEXT, project_type_id TEXT, status TEXT DEFAULT 'active', workflow TEXT, created_at INTEGER, updated_at INTEGER, FOREIGN KEY (project_type_id) REFERENCES project_types(id));
    CREATE TABLE tickets (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, body TEXT, "column" TEXT, priority TEXT DEFAULT 'medium', tags TEXT, claimed_by_run_id TEXT, claimed_at INTEGER, created_by TEXT, sequence_number INTEGER, created_at INTEGER, updated_at INTEGER, FOREIGN KEY (project_id) REFERENCES projects(id));
    CREATE TABLE ticket_comments (id TEXT PRIMARY KEY, ticket_id TEXT, type TEXT, author TEXT, body TEXT, meta TEXT, created_at INTEGER, FOREIGN KEY (ticket_id) REFERENCES tickets(id));
    CREATE TABLE ticket_history (id TEXT PRIMARY KEY, ticket_id TEXT, field TEXT, old_value TEXT, new_value TEXT, changed_by TEXT, created_at INTEGER, FOREIGN KEY (ticket_id) REFERENCES tickets(id));
    CREATE TABLE agent_runs (id TEXT PRIMARY KEY, ticket_id TEXT, agent_type_id TEXT, project_id TEXT, status TEXT, started_at INTEGER, finished_at INTEGER, exit_code INTEGER, error TEXT, transcript_path TEXT, created_at INTEGER, FOREIGN KEY (ticket_id) REFERENCES tickets(id));
    CREATE TABLE attachments (id TEXT PRIMARY KEY, ticket_id TEXT, filename TEXT, mime_type TEXT, size_bytes INTEGER, storage_path TEXT, created_at INTEGER, FOREIGN KEY (ticket_id) REFERENCES tickets(id));
  `);

  const config = configSchema.parse({ ui: { port } });
  const logger = pino({ level: 'silent' });
  return createHttpServer({ configRef: { current: config }, db, logger });
}

describe('Host header allowlist (DNS rebinding protection)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer(5757);
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows request with Host: 127.0.0.1:<port>', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:5757' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('allows request with Host: localhost:<port>', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'localhost:5757' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('allows request with Host: [::1]:<port>', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '[::1]:5757' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects request with Host: evil.com', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'evil.com' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Forbidden' });
  });

  it('rejects request with Host: evil.com:5757', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'evil.com:5757' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows localhost on any port (hostname-only check)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'localhost:9999' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('allows default inject Host (localhost:80)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('Security response headers', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestServer(5757);
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets X-Content-Type-Options: nosniff', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:5757' },
    });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets Referrer-Policy: same-origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:5757' },
    });
    expect(res.headers['referrer-policy']).toBe('same-origin');
  });

  it('sets X-Frame-Options: DENY', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:5757' },
    });
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('sets Content-Security-Policy', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: '127.0.0.1:5757' },
    });
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('includes security headers even on 403 responses', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'evil.com' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
  });
});
