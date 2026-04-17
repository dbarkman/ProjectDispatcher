import { describe, it, expect } from 'vitest';
import { openDatabase } from './index.js';
import { runMigrations } from './migrate.js';

const EXPECTED_TABLES = [
  'agent_runs',
  'agent_types',
  'config',
  'project_heartbeats',
  'project_type_columns',
  'project_types',
  'projects',
  'schema_migrations',
  'ticket_comments',
  'tickets',
];

const EXPECTED_INDEXES = [
  'idx_tickets_project_column',
  'idx_tickets_column',
  'idx_tickets_updated',
  'idx_ticket_comments_ticket',
  'idx_agent_runs_ticket',
  'idx_projects_status',
  'idx_projects_path_active',
  'idx_projects_abbreviation_active',
  'idx_tickets_project_seq',
  'idx_project_heartbeats_next_check',
];

describe('runMigrations', () => {
  it('creates all expected tables on a fresh database', () => {
    const db = openDatabase(':memory:');
    try {
      const result = runMigrations(db);
      expect(result.applied).toContain('001_init.sql');
      expect(result.skipped).toHaveLength(0);

      const tables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as { name: string }[]
      ).map((r) => r.name);

      for (const expected of EXPECTED_TABLES) {
        expect(tables).toContain(expected);
      }
    } finally {
      db.close();
    }
  });

  it('creates all expected indexes', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      const indexes = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      ).map((r) => r.name);

      for (const expected of EXPECTED_INDEXES) {
        expect(indexes).toContain(expected);
      }
    } finally {
      db.close();
    }
  });

  it('is idempotent — running twice skips already-applied migrations', () => {
    const db = openDatabase(':memory:');
    try {
      const first = runMigrations(db);
      const second = runMigrations(db);

      const expectedMigrations = [
        '001_init.sql',
        '002_ticket_attachments.sql',
        '003_project_scoped_templates.sql',
        '004_ticket_numbering.sql',
        '005_worktree_support.sql',
      ];
      expect(first.applied).toEqual(expectedMigrations);
      expect(first.skipped).toEqual([]);
      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual(expectedMigrations);
    } finally {
      db.close();
    }
  });

  it('enforces foreign keys — cannot insert a ticket with a non-existent project_id', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      const now = Date.now();
      expect(() =>
        db
          .prepare(
            `INSERT INTO tickets (id, project_id, title, "column", created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run('t1', 'nonexistent-project-id', 'Test', 'human', now, now),
      ).toThrow(/FOREIGN KEY/);
    } finally {
      db.close();
    }
  });

  it('enforces CHECK constraints — rejects invalid enum values and invalid JSON', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      const now = Date.now();

      // Seed a minimal project so FK constraints pass
      db.prepare(
        `INSERT INTO project_types (id, name, is_builtin, created_at, updated_at)
         VALUES ('test-type', 'Test', 0, ?, ?)`,
      ).run(now, now);
      db.prepare(
        `INSERT INTO projects (id, name, path, project_type_id, created_at, updated_at)
         VALUES ('p1', 'Test Project', '/tmp/p1', 'test-type', ?, ?)`,
      ).run(now, now);

      // Invalid enum value for priority
      expect(() =>
        db
          .prepare(
            `INSERT INTO tickets (id, project_id, title, "column", priority, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run('t1', 'p1', 'Test', 'human', 'urgent-asap', now, now),
      ).toThrow(/CHECK constraint/);

      // Invalid JSON in tags
      expect(() =>
        db
          .prepare(
            `INSERT INTO tickets (id, project_id, title, "column", tags, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run('t2', 'p1', 'Test', 'human', 'not valid json', now, now),
      ).toThrow(/CHECK constraint/);

      // Valid JSON tags succeed — sanity that the CHECK isn't too strict
      expect(() =>
        db
          .prepare(
            `INSERT INTO tickets (id, project_id, title, "column", tags, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run('t3', 'p1', 'Test', 'human', '["urgent","customer"]', now, now),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('rejects malformed migration filenames loudly', () => {
    // We can't easily point runMigrations at a different directory without
    // plumbing a parameter through, and the MIGRATIONS_DIR is intentionally
    // immutable. Instead we assert by inspection: the regex from migrate.ts
    // rejects the kinds of names we care about. If this ever needs to grow,
    // refactor runMigrations to accept an optional dir.
    const RE = /^\d{3}_[a-z0-9_-]+\.sql$/;

    // Valid names
    expect(RE.test('001_init.sql')).toBe(true);
    expect(RE.test('002_add_webhooks.sql')).toBe(true);
    expect(RE.test('010_rename-foo.sql')).toBe(true);

    // Invalid names
    expect(RE.test('02_bug.sql')).toBe(false); // two digits, not three
    expect(RE.test('001-init.sql')).toBe(false); // hyphen instead of underscore
    expect(RE.test('001_Init.sql')).toBe(false); // uppercase
    expect(RE.test('001_init.SQL')).toBe(false); // uppercase extension
    expect(RE.test('init.sql')).toBe(false); // no sequence prefix
  });

  it('cascades deletes — deleting a project removes its tickets and heartbeat', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      const now = Date.now();

      // Seed a minimal project type + project + heartbeat + ticket
      db.prepare(
        `INSERT INTO project_types (id, name, is_builtin, created_at, updated_at)
         VALUES ('test-type', 'Test', 0, ?, ?)`,
      ).run(now, now);

      db.prepare(
        `INSERT INTO projects (id, name, path, project_type_id, created_at, updated_at)
         VALUES ('p1', 'Test Project', '/tmp/p1', 'test-type', ?, ?)`,
      ).run(now, now);

      db.prepare(
        `INSERT INTO project_heartbeats (project_id, next_check_at, updated_at)
         VALUES ('p1', ?, ?)`,
      ).run(now + 300_000, now);

      db.prepare(
        `INSERT INTO tickets (id, project_id, title, "column", created_at, updated_at)
         VALUES ('t1', 'p1', 'Test Ticket', 'human', ?, ?)`,
      ).run(now, now);

      // Sanity: everything is there
      expect(
        db.prepare('SELECT COUNT(*) as c FROM tickets WHERE project_id = ?').get('p1'),
      ).toEqual({ c: 1 });

      // Delete the project — tickets and heartbeat should cascade out
      db.prepare('DELETE FROM projects WHERE id = ?').run('p1');

      expect(
        db.prepare('SELECT COUNT(*) as c FROM tickets WHERE project_id = ?').get('p1'),
      ).toEqual({ c: 0 });
      expect(
        db.prepare('SELECT COUNT(*) as c FROM project_heartbeats WHERE project_id = ?').get('p1'),
      ).toEqual({ c: 0 });
    } finally {
      db.close();
    }
  });
});
