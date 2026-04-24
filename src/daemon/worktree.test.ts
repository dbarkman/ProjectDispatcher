import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pino } from 'pino';
import {
  worktreePath,
  worktreeBranch,
  createWorktree,
  removeWorktree,
  listWorktrees,
  mergeWorktreeBranch,
  mergeAndCleanup,
  isGitReady,
} from './worktree.js';

const execFileAsync = promisify(execFile);
const logger = pino({ level: 'silent' });

const TICKET_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

async function initBareTestRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pd-wt-test-'));
  await git(dir, ['init', '--initial-branch', 'main']);
  await git(dir, ['config', 'user.email', 'test@test.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await execFileAsync('touch', ['initial.txt'], { cwd: dir });
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-m', 'initial']);
  return dir;
}

describe('worktreePath', () => {
  it('returns deterministic path', () => {
    expect(worktreePath('/projects/foo', TICKET_ID)).toBe(
      `/projects/foo/.worktrees/${TICKET_ID}`,
    );
  });
});

describe('worktreeBranch', () => {
  it('returns ticket/<id> format', () => {
    expect(worktreeBranch(TICKET_ID)).toBe(`ticket/${TICKET_ID}`);
  });
});

describe('git worktree operations', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await initBareTestRepo();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  describe('createWorktree', () => {
    it('creates a worktree with a new branch', async () => {
      const wtPath = await createWorktree(repoDir, TICKET_ID, logger);

      expect(wtPath).toBe(join(repoDir, '.worktrees', TICKET_ID));

      const branch = await git(wtPath, ['branch', '--show-current']);
      expect(branch).toBe(`ticket/${TICKET_ID}`);
    });

    it('is idempotent — returns existing path on second call', async () => {
      const first = await createWorktree(repoDir, TICKET_ID, logger);
      const second = await createWorktree(repoDir, TICKET_ID, logger);
      expect(first).toBe(second);
    });

    it('reuses an existing branch if the worktree was removed but branch persists', async () => {
      await createWorktree(repoDir, TICKET_ID, logger);
      await removeWorktree(repoDir, TICKET_ID, logger, false);

      const wtPath = await createWorktree(repoDir, TICKET_ID, logger);
      const branch = await git(wtPath, ['branch', '--show-current']);
      expect(branch).toBe(`ticket/${TICKET_ID}`);
    });
  });

  describe('removeWorktree', () => {
    it('removes worktree and branch', async () => {
      await createWorktree(repoDir, TICKET_ID, logger);
      await removeWorktree(repoDir, TICKET_ID, logger, true);

      const worktrees = await listWorktrees(repoDir);
      const ticketWorktrees = worktrees.filter(
        (wt) => wt.branch?.includes(TICKET_ID),
      );
      expect(ticketWorktrees).toHaveLength(0);

      const branches = await git(repoDir, ['branch', '--list']);
      expect(branches).not.toContain(`ticket/${TICKET_ID}`);
    });

    it('safe to call on nonexistent worktree', async () => {
      await expect(
        removeWorktree(repoDir, 'nonexistent', logger),
      ).resolves.not.toThrow();
    });
  });

  describe('listWorktrees', () => {
    it('lists the main worktree and created worktrees', async () => {
      await createWorktree(repoDir, TICKET_ID, logger);
      const worktrees = await listWorktrees(repoDir);

      expect(worktrees.length).toBeGreaterThanOrEqual(2);

      const ticketWt = worktrees.find((wt) =>
        wt.branch?.includes(TICKET_ID),
      );
      expect(ticketWt).toBeDefined();
    });
  });

  describe('mergeWorktreeBranch', () => {
    it('merges a clean branch into main', async () => {
      const wtPath = await createWorktree(repoDir, TICKET_ID, logger);

      await execFileAsync('touch', ['new-file.txt'], { cwd: wtPath });
      await git(wtPath, ['add', '.']);
      await git(wtPath, ['commit', '-m', 'add new file']);

      const result = await mergeWorktreeBranch(repoDir, TICKET_ID, logger);
      expect(result.merged).toBe(true);
      expect(result.conflicted).toBe(false);
      expect(result.error).toBeNull();

      const log = await git(repoDir, ['log', '--oneline', '-5']);
      expect(log).toContain('add new file');
    });

    it('detects and aborts merge conflicts', async () => {
      const wtPath = await createWorktree(repoDir, TICKET_ID, logger);

      // Create conflicting changes
      await execFileAsync('sh', ['-c', 'echo "main content" > conflict.txt'], { cwd: repoDir });
      await git(repoDir, ['add', '.']);
      await git(repoDir, ['commit', '-m', 'main change']);

      await execFileAsync('sh', ['-c', 'echo "branch content" > conflict.txt'], { cwd: wtPath });
      await git(wtPath, ['add', '.']);
      await git(wtPath, ['commit', '-m', 'branch change']);

      const result = await mergeWorktreeBranch(repoDir, TICKET_ID, logger);
      expect(result.merged).toBe(false);
      expect(result.conflicted).toBe(true);
    });

    it('returns error for nonexistent branch', async () => {
      const result = await mergeWorktreeBranch(repoDir, 'nonexistent', logger);
      expect(result.merged).toBe(false);
      expect(result.error).toContain('does not exist');
    });

    it('refuses to merge when not on main branch', async () => {
      const wtPath = await createWorktree(repoDir, TICKET_ID, logger);
      await execFileAsync('touch', ['feature.txt'], { cwd: wtPath });
      await git(wtPath, ['add', '.']);
      await git(wtPath, ['commit', '-m', 'feature work']);

      await git(repoDir, ['checkout', '-b', 'some-other-branch']);

      const result = await mergeWorktreeBranch(repoDir, TICKET_ID, logger);
      expect(result.merged).toBe(false);
      expect(result.conflicted).toBe(false);
      expect(result.error).toContain('some-other-branch');
      expect(result.error).toContain('expected main or master');

      await git(repoDir, ['checkout', 'main']);
    });
  });

  describe('mergeAndCleanup', () => {
    it('merges, removes worktree, and deletes branch', async () => {
      const wtPath = await createWorktree(repoDir, TICKET_ID, logger);

      await execFileAsync('touch', ['feature.txt'], { cwd: wtPath });
      await git(wtPath, ['add', '.']);
      await git(wtPath, ['commit', '-m', 'add feature']);

      const result = await mergeAndCleanup(repoDir, TICKET_ID, logger);
      expect(result.merged).toBe(true);

      const worktrees = await listWorktrees(repoDir);
      const ticketWt = worktrees.find((wt) => wt.branch?.includes(TICKET_ID));
      expect(ticketWt).toBeUndefined();
    });

    it('does not remove worktree on merge conflict', async () => {
      const wtPath = await createWorktree(repoDir, TICKET_ID, logger);

      await execFileAsync('sh', ['-c', 'echo "main" > conflict.txt'], { cwd: repoDir });
      await git(repoDir, ['add', '.']);
      await git(repoDir, ['commit', '-m', 'main change']);

      await execFileAsync('sh', ['-c', 'echo "branch" > conflict.txt'], { cwd: wtPath });
      await git(wtPath, ['add', '.']);
      await git(wtPath, ['commit', '-m', 'branch change']);

      const result = await mergeAndCleanup(repoDir, TICKET_ID, logger);
      expect(result.merged).toBe(false);
      expect(result.conflicted).toBe(true);

      // Worktree should still exist
      const worktrees = await listWorktrees(repoDir);
      const ticketWt = worktrees.find((wt) => wt.branch?.includes(TICKET_ID));
      expect(ticketWt).toBeDefined();
    });
  });
});

describe('isGitReady', () => {
  it('returns false for empty directory (no .git)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pd-nogit-'));
    try {
      expect(await isGitReady(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns false for git-init with no commits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pd-nohd-'));
    try {
      await git(dir, ['init', '--initial-branch', 'main']);
      expect(await isGitReady(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns true for repo with at least one commit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pd-ready-'));
    try {
      await git(dir, ['init', '--initial-branch', 'main']);
      await git(dir, ['config', 'user.email', 'test@test.com']);
      await git(dir, ['config', 'user.name', 'Test']);
      await execFileAsync('touch', ['f.txt'], { cwd: dir });
      await git(dir, ['add', '.']);
      await git(dir, ['commit', '-m', 'init']);
      expect(await isGitReady(dir)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
