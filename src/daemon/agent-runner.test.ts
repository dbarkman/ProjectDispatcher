import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { seedBuiltins } from '../db/seed.js';
import { configSchema, type Config } from '../config.schema.js';
import type Database from 'better-sqlite3';

const execFileAsync = promisify(execFile);
const logger = pino({ level: 'silent' });

vi.mock('../services/prompt-builder.js', () => ({
  buildPrompt: vi.fn().mockResolvedValue('test prompt'),
}));

function makeFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    unref: () => void;
    kill: (signal: string) => void;
  };
  child.pid = 99999;
  child.unref = vi.fn();
  child.kill = vi.fn();
  return child;
}

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawn: vi.fn(() => makeFakeChild()),
  };
});

async function gitCmd(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

const TICKET_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const PROJECT_ID = 'pppppppp-1111-2222-3333-444444444444';

function setupDb(projectPath: string): Database.Database {
  const db = openDatabase(':memory:');
  runMigrations(db);
  seedBuiltins(db);

  db.prepare(
    `INSERT INTO projects (id, name, path, project_type_id, status, created_at, updated_at)
     VALUES (?, 'TestProject', ?, 'software-dev', 'active', ?, ?)`,
  ).run(PROJECT_ID, projectPath, Date.now(), Date.now());

  db.prepare(
    `INSERT INTO tickets (id, project_id, title, body, "column", priority, created_by, sequence_number, created_at, updated_at)
     VALUES (?, ?, 'Test ticket', 'body', 'coding-agent', 'normal', 'human', 1, ?, ?)`,
  ).run(TICKET_ID, PROJECT_ID, Date.now(), Date.now());

  return db;
}

function configWith(overrides: Partial<Config['agents']> = {}): Config {
  return configSchema.parse({
    agents: overrides,
    ai: { auth_method: 'api_key', api_key: 'test-key' },
  });
}

describe('runAgent worktree fallback', () => {
  let projectDir: string;
  let db: Database.Database;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });

  afterEach(async () => {
    vi.useRealTimers();
    db?.close();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it('spawns against project root when directory has no .git', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'pd-ar-nogit-'));
    db = setupDb(projectDir);
    const config = configWith({ parallel_coding: true });

    const { runAgent, initActiveRuns } = await import('./agent-runner.js');
    initActiveRuns(db);

    const result = await runAgent(
      { projectId: PROJECT_ID, agentTypeId: 'coding-agent', ticketId: TICKET_ID },
      db, config, logger,
    );

    expect(result.spawned).toBe(true);
    const run = db.prepare('SELECT worktree_path FROM agent_runs WHERE id = ?').get(result.runId) as {
      worktree_path: string | null;
    };
    expect(run.worktree_path).toBeNull();
  });

  it('spawns against project root when .git exists but no commits', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'pd-ar-nohd-'));
    await gitCmd(projectDir, ['init', '--initial-branch', 'main']);
    db = setupDb(projectDir);
    const config = configWith({ parallel_coding: true });

    const { runAgent, initActiveRuns } = await import('./agent-runner.js');
    initActiveRuns(db);

    const result = await runAgent(
      { projectId: PROJECT_ID, agentTypeId: 'coding-agent', ticketId: TICKET_ID },
      db, config, logger,
    );

    expect(result.spawned).toBe(true);
    const run = db.prepare('SELECT worktree_path FROM agent_runs WHERE id = ?').get(result.runId) as {
      worktree_path: string | null;
    };
    expect(run.worktree_path).toBeNull();
  });

  it('creates worktree when repo has commits and parallel_coding is on', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'pd-ar-ready-'));
    await gitCmd(projectDir, ['init', '--initial-branch', 'main']);
    await gitCmd(projectDir, ['config', 'user.email', 'test@test.com']);
    await gitCmd(projectDir, ['config', 'user.name', 'Test']);
    await execFileAsync('touch', ['f.txt'], { cwd: projectDir });
    await gitCmd(projectDir, ['add', '.']);
    await gitCmd(projectDir, ['commit', '-m', 'init']);

    db = setupDb(projectDir);
    const config = configWith({ parallel_coding: true });

    const { runAgent, initActiveRuns } = await import('./agent-runner.js');
    initActiveRuns(db);

    const result = await runAgent(
      { projectId: PROJECT_ID, agentTypeId: 'coding-agent', ticketId: TICKET_ID },
      db, config, logger,
    );

    expect(result.spawned).toBe(true);
    const run = db.prepare('SELECT worktree_path FROM agent_runs WHERE id = ?').get(result.runId) as {
      worktree_path: string | null;
    };
    expect(run.worktree_path).not.toBeNull();
    expect(run.worktree_path).toContain('.worktrees');
  });

  it('creates agent_runs row in the fallback path', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'pd-ar-row-'));
    db = setupDb(projectDir);
    const config = configWith({ parallel_coding: true });

    const { runAgent, initActiveRuns } = await import('./agent-runner.js');
    initActiveRuns(db);

    const result = await runAgent(
      { projectId: PROJECT_ID, agentTypeId: 'coding-agent', ticketId: TICKET_ID },
      db, config, logger,
    );

    const row = db.prepare('SELECT id, exit_status FROM agent_runs WHERE id = ?').get(result.runId) as {
      id: string;
      exit_status: string;
    } | undefined;
    expect(row).toBeDefined();
    expect(row!.exit_status).toBe('running');
  });
});
