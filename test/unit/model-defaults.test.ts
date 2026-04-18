import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedBuiltins } from '../../src/db/seed.js';
import { CLAUDE_MODELS } from '../../src/types.js';
import { configSchema } from '../../src/config.schema.js';

describe('CLAUDE_MODELS', () => {
  it('contains opus-4-7 as first entry and all expected models', () => {
    expect(CLAUDE_MODELS).toEqual([
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5-20251001',
    ]);
  });

  it('includes claude-opus-4-7', () => {
    expect(CLAUDE_MODELS).toContain('claude-opus-4-7');
  });
});

describe('config default model', () => {
  it('defaults to claude-opus-4-7', () => {
    const config = configSchema.parse({});
    expect(config.ai.default_model).toBe('claude-opus-4-7');
  });
});

describe('seed agent-type model mapping', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    seedBuiltins(db);
  });

  const expectedModels: Record<string, string> = {
    'coding-agent': 'claude-opus-4-7',
    'code-reviewer': 'claude-opus-4-7',
    'security-reviewer': 'claude-opus-4-7',
    'sysadmin': 'claude-sonnet-4-6',
    'security-auditor': 'claude-sonnet-4-6',
    'writer': 'claude-sonnet-4-6',
    'editor': 'claude-sonnet-4-6',
    'deployer': 'claude-sonnet-4-6',
    'researcher': 'claude-haiku-4-5-20251001',
  };

  for (const [agentId, expectedModel] of Object.entries(expectedModels)) {
    it(`seeds ${agentId} with ${expectedModel}`, () => {
      const row = db.prepare('SELECT model FROM agent_types WHERE id = ?').get(agentId) as
        | { model: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row!.model).toBe(expectedModel);
    });
  }
});
