import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyView from '@fastify/view';
import Handlebars from 'handlebars';
import Sqlite, { type Database } from 'better-sqlite3';
import { displayPath } from '../../display-path.js';
import { projectTypeUiRoutes } from './project-types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function seedDb(): Database {
  const db = new Sqlite(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE project_types (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      icon TEXT, is_builtin INTEGER NOT NULL DEFAULT 0,
      owner_project_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE project_type_columns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_type_id TEXT NOT NULL REFERENCES project_types(id) ON DELETE CASCADE,
      column_id TEXT NOT NULL, name TEXT NOT NULL,
      agent_type_id TEXT, "order" INTEGER NOT NULL,
      UNIQUE (project_type_id, column_id)
    );
    CREATE TABLE agent_types (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      system_prompt_path TEXT NOT NULL, model TEXT NOT NULL,
      allowed_tools TEXT NOT NULL, permission_mode TEXT NOT NULL,
      timeout_minutes INTEGER NOT NULL DEFAULT 30, max_retries INTEGER NOT NULL DEFAULT 0,
      is_builtin INTEGER NOT NULL DEFAULT 0, owner_project_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT, path TEXT UNIQUE, display_path TEXT,
      project_type_id TEXT, status TEXT DEFAULT 'active',
      created_at INTEGER, updated_at INTEGER,
      FOREIGN KEY (project_type_id) REFERENCES project_types(id)
    );
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY, project_id TEXT, title TEXT, body TEXT,
      "column" TEXT, priority TEXT DEFAULT 'medium', tags TEXT,
      claimed_by_run_id TEXT, claimed_at INTEGER, created_by TEXT,
      sequence_number INTEGER, created_at INTEGER, updated_at INTEGER,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );
  `);

  const now = Date.now();
  db.prepare(
    `INSERT INTO project_types (id, name, description, is_builtin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('software-dev', 'Software Dev', 'Standard workflow', 1, now, now);

  db.prepare(
    `INSERT INTO project_type_columns (project_type_id, column_id, name, "order")
     VALUES (?, ?, ?, ?)`,
  ).run('software-dev', 'human', 'Human', 0);
  db.prepare(
    `INSERT INTO project_type_columns (project_type_id, column_id, name, "order")
     VALUES (?, ?, ?, ?)`,
  ).run('software-dev', 'done', 'Done', 1);

  db.prepare(
    `INSERT INTO agent_types (id, name, system_prompt_path, model, allowed_tools, permission_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('coding-agent', 'Coding Agent', 'coding-agent.md', 'claude-sonnet-4-6', '[]', 'default', now, now);

  return db;
}

async function buildApp(db: Database): Promise<FastifyInstance> {
  const app = Fastify();

  const templatesDir = join(__dirname, '..', 'templates');

  Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);
  Handlebars.registerHelper('displayPath', (path: string) => displayPath(path));

  const projectTypeEditFormSrc = await readFile(join(templatesDir, 'project-type-edit-form.hbs'), 'utf8');
  Handlebars.registerPartial('projectTypeEditForm', projectTypeEditFormSrc);

  await app.register(fastifyView, {
    engine: { handlebars: Handlebars },
    root: templatesDir,
    layout: 'layout.hbs',
  });

  await projectTypeUiRoutes(app, db);
  return app;
}

describe('project-type UI routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const db = seedDb();
    app = await buildApp(db);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /ui/project-types', () => {
    it('returns 200 with HTML', async () => {
      const res = await app.inject({ method: 'GET', url: '/ui/project-types' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain('Software Dev');
    });
  });

  describe('GET /ui/project-types/:id', () => {
    it('returns 200 with edit form for existing type', async () => {
      const res = await app.inject({ method: 'GET', url: '/ui/project-types/software-dev' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('pt-columns-list');
      expect(res.body).toContain('Software Dev');
    });

    it('returns 404 for non-existent project type', async () => {
      const res = await app.inject({ method: 'GET', url: '/ui/project-types/nonexistent' });
      expect(res.statusCode).toBe(404);
    });
  });
});
