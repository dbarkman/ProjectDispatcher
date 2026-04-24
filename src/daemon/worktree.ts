import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import type { Logger } from 'pino';

const execFileAsync = promisify(execFile);

const WORKTREES_DIR = '.worktrees';

export function worktreePath(projectPath: string, ticketId: string): string {
  return join(projectPath, WORKTREES_DIR, ticketId);
}

export function worktreeBranch(ticketId: string): string {
  return `ticket/${ticketId}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function git(projectPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', projectPath, ...args]);
  return stdout.trim();
}

async function branchExists(projectPath: string, branch: string): Promise<boolean> {
  try {
    await git(projectPath, ['rev-parse', '--verify', branch]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a directory is a git repo with at least one commit.
 * Returns false for: no .git, .git but no commits (empty HEAD).
 */
export async function isGitReady(projectPath: string): Promise<boolean> {
  try {
    await git(projectPath, ['rev-parse', '--verify', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a git worktree for a ticket. Idempotent — if the worktree
 * already exists at the expected path, returns it without modification.
 *
 * Creates branch `ticket/<ticketId>` off the current HEAD of the main
 * working copy. If the branch already exists (crash retry), reuses it.
 */
export async function createWorktree(
  projectPath: string,
  ticketId: string,
  logger: Logger,
): Promise<string> {
  const wtPath = worktreePath(projectPath, ticketId);
  const branch = worktreeBranch(ticketId);

  if (await pathExists(wtPath)) {
    logger.debug({ wtPath, branch }, 'Worktree already exists — reusing');
    return wtPath;
  }

  const hasBranch = await branchExists(projectPath, branch);

  if (hasBranch) {
    await git(projectPath, ['worktree', 'add', wtPath, branch]);
    logger.info({ wtPath, branch }, 'Worktree created (existing branch)');
  } else {
    await git(projectPath, ['worktree', 'add', '-b', branch, wtPath]);
    logger.info({ wtPath, branch }, 'Worktree created (new branch)');
  }

  return wtPath;
}

/**
 * Remove a worktree and optionally delete the branch.
 * Safe to call even if the worktree doesn't exist.
 */
export async function removeWorktree(
  projectPath: string,
  ticketId: string,
  logger: Logger,
  deleteBranch = true,
): Promise<void> {
  const wtPath = worktreePath(projectPath, ticketId);
  const branch = worktreeBranch(ticketId);

  if (await pathExists(wtPath)) {
    try {
      await git(projectPath, ['worktree', 'remove', wtPath, '--force']);
      logger.info({ wtPath }, 'Worktree removed');
    } catch (err) {
      logger.warn({ err, wtPath }, 'Failed to remove worktree');
    }
  }

  if (deleteBranch && await branchExists(projectPath, branch)) {
    try {
      await git(projectPath, ['branch', '-d', branch]);
      logger.info({ branch }, 'Branch deleted');
    } catch (err) {
      logger.warn({ err, branch }, 'Failed to delete branch (may have unmerged changes)');
    }
  }
}

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string;
  bare: boolean;
}

/**
 * List all worktrees for a project. Returns parsed porcelain output.
 */
export async function listWorktrees(projectPath: string): Promise<WorktreeEntry[]> {
  let output: string;
  try {
    output = await git(projectPath, ['worktree', 'list', '--porcelain']);
  } catch {
    return [];
  }

  if (!output) return [];

  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push(current as WorktreeEntry);
      current = { path: line.slice(9), branch: null, head: '', bare: false };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7);
    } else if (line === 'bare') {
      current.bare = true;
    }
  }
  if (current.path) entries.push(current as WorktreeEntry);

  return entries;
}

export interface MergeResult {
  merged: boolean;
  conflicted: boolean;
  error: string | null;
}

async function getCurrentBranch(projectPath: string): Promise<string | null> {
  try {
    return await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    return null;
  }
}

const MAIN_BRANCH_NAMES = new Set(['main', 'master']);

/**
 * Merge a ticket branch into main of the main working copy.
 *
 * Verifies the working copy is on main/master before merging.
 * On conflict: aborts the merge and returns { conflicted: true }.
 * Caller is responsible for moving the ticket to human.
 */
export async function mergeWorktreeBranch(
  projectPath: string,
  ticketId: string,
  logger: Logger,
): Promise<MergeResult> {
  const branch = worktreeBranch(ticketId);

  if (!await branchExists(projectPath, branch)) {
    return { merged: false, conflicted: false, error: `Branch ${branch} does not exist` };
  }

  const currentBranch = await getCurrentBranch(projectPath);
  if (!currentBranch || !MAIN_BRANCH_NAMES.has(currentBranch)) {
    return {
      merged: false,
      conflicted: false,
      error: `Refusing to merge: working copy is on '${currentBranch ?? 'detached HEAD'}', expected main or master`,
    };
  }

  try {
    await git(projectPath, ['merge', branch, '--no-edit']);
    logger.info({ branch, projectPath }, 'Branch merged successfully');
    return { merged: true, conflicted: false, error: null };
  } catch (err) {
    // execFile rejects with an Error that has stdout/stderr as properties
    const errObj = err as { stdout?: string; stderr?: string; message?: string };
    const combined = [errObj.stdout, errObj.stderr, errObj.message].filter(Boolean).join('\n');

    if (combined.includes('CONFLICT') || combined.includes('Merge conflict')) {
      try {
        await git(projectPath, ['merge', '--abort']);
      } catch {
        // merge --abort can fail if there's nothing to abort
      }
      logger.warn({ branch, projectPath }, 'Merge conflict — aborted');
      return { merged: false, conflicted: true, error: `Merge conflict on branch ${branch}` };
    }

    logger.error({ err, branch, projectPath }, 'Merge failed');
    return { merged: false, conflicted: false, error: combined || String(err) };
  }
}

/**
 * Full merge-and-cleanup lifecycle for a done ticket.
 * Merges the branch, removes the worktree, deletes the branch.
 */
export async function mergeAndCleanup(
  projectPath: string,
  ticketId: string,
  logger: Logger,
): Promise<MergeResult> {
  const result = await mergeWorktreeBranch(projectPath, ticketId, logger);

  if (result.merged) {
    await removeWorktree(projectPath, ticketId, logger, true);
  }

  return result;
}

/**
 * Clean up orphaned worktrees. Called during crash recovery.
 *
 * A worktree is orphaned if:
 *   - Its ticket is in 'done' or 'human' (not actively being worked)
 *   - Its ticket no longer exists
 *
 * The `isOrphaned` callback lets the caller decide based on DB state.
 */
export async function cleanupOrphanedWorktrees(
  projectPath: string,
  isOrphaned: (ticketId: string) => boolean,
  logger: Logger,
): Promise<number> {
  const worktrees = await listWorktrees(projectPath);
  let cleaned = 0;

  for (const wt of worktrees) {
    if (!wt.branch) continue;

    // Extract ticket ID from branch name: refs/heads/ticket/<uuid>
    const branchName = wt.branch.replace('refs/heads/', '');
    if (!branchName.startsWith('ticket/')) continue;
    const ticketId = branchName.slice(7);

    if (isOrphaned(ticketId)) {
      await removeWorktree(projectPath, ticketId, logger, false);
      cleaned++;
    }
  }

  return cleaned;
}
