import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './index.js';
import { runMigrations } from './migrate.js';
import { seedBuiltins } from './seed.js';

const PROMPTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'prompts',
  'defaults',
);

describe('seedBuiltins', () => {
  it('populates all built-in types and columns on a fresh database', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      const result = seedBuiltins(db);

      expect(result.projectTypesInserted).toBe(5);
      expect(result.agentTypesInserted).toBe(9);
      expect(result.projectTypeColumnsInserted).toBe(19);

      expect(db.prepare('SELECT COUNT(*) AS c FROM project_types').get()).toEqual({ c: 5 });
      expect(db.prepare('SELECT COUNT(*) AS c FROM agent_types').get()).toEqual({ c: 9 });
      expect(db.prepare('SELECT COUNT(*) AS c FROM project_type_columns').get()).toEqual({
        c: 19,
      });
    } finally {
      db.close();
    }
  });

  it('marks every built-in row with is_builtin = 1', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      seedBuiltins(db);

      expect(
        db.prepare('SELECT COUNT(*) AS c FROM project_types WHERE is_builtin = 1').get(),
      ).toEqual({ c: 5 });
      expect(
        db.prepare('SELECT COUNT(*) AS c FROM agent_types WHERE is_builtin = 1').get(),
      ).toEqual({ c: 9 });
    } finally {
      db.close();
    }
  });

  it('is idempotent — re-running inserts nothing and changes no counts', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      seedBuiltins(db);
      const second = seedBuiltins(db);

      expect(second.projectTypesInserted).toBe(0);
      expect(second.agentTypesInserted).toBe(0);
      expect(second.projectTypeColumnsInserted).toBe(0);

      expect(db.prepare('SELECT COUNT(*) AS c FROM project_types').get()).toEqual({ c: 5 });
      expect(db.prepare('SELECT COUNT(*) AS c FROM agent_types').get()).toEqual({ c: 9 });
      expect(db.prepare('SELECT COUNT(*) AS c FROM project_type_columns').get()).toEqual({
        c: 19,
      });
    } finally {
      db.close();
    }
  });

  it('preserves user edits to built-in rows across a re-seed', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      seedBuiltins(db);

      // Simulate a user edit: bump a built-in agent's timeout
      db.prepare('UPDATE agent_types SET timeout_minutes = 999 WHERE id = ?').run('coding-agent');
      db.prepare('UPDATE project_types SET name = ? WHERE id = ?').run(
        'My Custom Software Dev',
        'software-dev',
      );

      seedBuiltins(db);

      const agent = db
        .prepare('SELECT timeout_minutes FROM agent_types WHERE id = ?')
        .get('coding-agent') as { timeout_minutes: number };
      expect(agent.timeout_minutes).toBe(999);

      const pt = db.prepare('SELECT name FROM project_types WHERE id = ?').get('software-dev') as {
        name: string;
      };
      expect(pt.name).toBe('My Custom Software Dev');
    } finally {
      db.close();
    }
  });

  it('stores allowed_tools as valid JSON that parses back to a string array', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      seedBuiltins(db);

      const row = db
        .prepare('SELECT allowed_tools FROM agent_types WHERE id = ?')
        .get('coding-agent') as { allowed_tools: string };

      const tools = JSON.parse(row.allowed_tools) as unknown;
      expect(Array.isArray(tools)).toBe(true);
      expect(tools).toContain('Read');
      expect(tools).toContain('Write');
      expect(tools).toContain('Bash');
    } finally {
      db.close();
    }
  });

  it('inserts project type columns in the right order for each type', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      seedBuiltins(db);

      const softwareDevCols = (
        db
          .prepare(
            'SELECT column_id FROM project_type_columns WHERE project_type_id = ? ORDER BY "order"',
          )
          .all('software-dev') as { column_id: string }[]
      ).map((c) => c.column_id);
      expect(softwareDevCols).toEqual([
        'human',
        'coding-agent',
        'code-reviewer',
        'security-reviewer',
        'done',
      ]);

      const personalCols = (
        db
          .prepare(
            'SELECT column_id FROM project_type_columns WHERE project_type_id = ? ORDER BY "order"',
          )
          .all('personal') as { column_id: string }[]
      ).map((c) => c.column_id);
      expect(personalCols).toEqual(['human', 'in-progress', 'done']);
    } finally {
      db.close();
    }
  });

  it('every project_type_columns.agent_type_id references an existing agent_type or is null', () => {
    // The FK constraint enforces this on insert, but we assert it as a
    // post-condition to catch an accidental future mis-ordering of the seed.
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      seedBuiltins(db);

      const orphans = db
        .prepare(
          `SELECT ptc.project_type_id, ptc.column_id, ptc.agent_type_id
           FROM project_type_columns ptc
           LEFT JOIN agent_types at ON ptc.agent_type_id = at.id
           WHERE ptc.agent_type_id IS NOT NULL AND at.id IS NULL`,
        )
        .all();
      expect(orphans).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('every seeded agent_type system_prompt_path points at a real file in src/prompts/defaults/', () => {
    const db = openDatabase(':memory:');
    try {
      runMigrations(db);
      seedBuiltins(db);

      const paths = (
        db.prepare('SELECT system_prompt_path FROM agent_types').all() as {
          system_prompt_path: string;
        }[]
      ).map((r) => r.system_prompt_path);

      expect(paths).toHaveLength(9);
      for (const p of paths) {
        expect(existsSync(join(PROMPTS_DIR, p))).toBe(true);
      }
    } finally {
      db.close();
    }
  });
});
