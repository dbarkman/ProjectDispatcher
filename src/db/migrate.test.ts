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

      expect(first.applied).toEqual(['001_init.sql']);
      expect(first.skipped).toEqual([]);
      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual(['001_init.sql']);
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
