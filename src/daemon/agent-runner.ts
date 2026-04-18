import { spawn } from 'node:child_process';
import { mkdir, open as fsOpen } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Config } from '../config.schema.js';
import { DEFAULT_DB_PATH, DEFAULT_TASKS_DIR } from '../db/index.js';
import { addComment } from '../db/queries/tickets.js';
import { buildPrompt } from '../services/prompt-builder.js';
import { createWorktree } from './worktree.js';
import { isProcessAlive } from './pidfile.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ARTIFACTS_DIR = join(DEFAULT_TASKS_DIR, 'artifacts', 'runs');

const allowedToolsSchema = z.array(z.string().min(1));

const TICKET_CLI_PATH = resolve(join(__dirname, '..', 'cli', 'ticket.cjs'));

export interface AgentSpawnResult {
  runId: string;
  pid: number | null;
  spawned: boolean;
}

interface AgentRunInput {
  projectId: string;
  agentTypeId: string;
  ticketId: string;
}

interface AgentTypeRow {
  id: string;
  model: string;
  allowed_tools: string;
  permission_mode: string;
  timeout_minutes: number;
}

/** Track active runs for concurrency enforcement. */
const activeRuns = new Map<string, Set<string>>(); // projectId → Set<runId>

export function getActiveCount(projectId: string): number {
  return activeRuns.get(projectId)?.size ?? 0;
}

export function getGlobalActiveCount(): number {
  let total = 0;
  for (const runs of activeRuns.values()) total += runs.size;
  return total;
}

function trackRun(projectId: string, runId: string): void {
  if (!activeRuns.has(projectId)) activeRuns.set(projectId, new Set());
  activeRuns.get(projectId)!.add(runId);
}

function untrackRun(projectId: string, runId: string): void {
  activeRuns.get(projectId)?.delete(runId);
  if (activeRuns.get(projectId)?.size === 0) activeRuns.delete(projectId);
}

/**
 * Rebuild the in-memory activeRuns map from the database.
 * Called after crash recovery and before the scheduler starts, so the
 * concurrency limits account for detached agents that survived a restart.
 */
export function initActiveRuns(db: Database): void {
  const running = db
    .prepare(
      `SELECT ar.id, t.project_id
       FROM agent_runs ar
       JOIN tickets t ON t.id = ar.ticket_id
       WHERE ar.exit_status = 'running'`,
    )
    .all() as Array<{ id: string; project_id: string }>;

  activeRuns.clear();
  for (const row of running) {
    trackRun(row.project_id, row.id);
  }
}


/**
 * Finalize a run that has ended — update DB, release ticket claim on failure,
 * add block comment. Used by both the in-process close handler and the reaper.
 *
 * Idempotent: only updates if exit_status is still 'running' (CAS pattern).
 * Returns true if this call performed the finalization.
 */
function finalizeRun(
  db: Database,
  runId: string,
  ticketId: string,
  agentTypeId: string,
  projectId: string,
  exitStatus: 'success' | 'timeout' | 'crashed',
  errorMessage: string | null,
  logger: Logger,
): boolean {
  const now = Date.now();

  const updated = db
    .prepare(
      `UPDATE agent_runs
       SET exit_status = ?, ended_at = ?, error_message = ?
       WHERE id = ? AND exit_status = 'running'`,
    )
    .run(exitStatus, now, errorMessage, runId);

  if (updated.changes === 0) return false;

  untrackRun(projectId, runId);

  if (exitStatus !== 'success') {
    logger.warn({ runId, exitStatus, errorMessage }, 'Agent run failed');

    db.transaction(() => {
      db.prepare(
        'UPDATE tickets SET claimed_by_run_id = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND claimed_by_run_id = ?',
      ).run(now, ticketId, runId);

      addComment(db, ticketId, {
        type: 'block',
        author: `agent:${agentTypeId}:${runId}`,
        body: `Agent run failed: ${errorMessage ?? exitStatus}. Releasing claim. This ticket needs human attention.`,
        meta: {
          run_id: runId,
          exit_status: exitStatus,
        },
      });
    })();
  } else {
    logger.info({ runId }, 'Agent run completed successfully');
  }

  return true;
}

/**
 * Reap detached agent processes that have died or exceeded their timeout.
 * Runs periodically from the daemon's main loop. Handles:
 *   - Processes that died while the daemon was down (or between reaper ticks)
 *   - Processes that have exceeded their timeout_minutes
 */
export function reapDetachedRuns(db: Database, logger: Logger): void {
  const runningRuns = db
    .prepare(
      `SELECT ar.id, ar.ticket_id, ar.agent_type_id, ar.pid, ar.started_at,
              at.timeout_minutes, t.project_id
       FROM agent_runs ar
       JOIN agent_types at ON at.id = ar.agent_type_id
       JOIN tickets t ON t.id = ar.ticket_id
       WHERE ar.exit_status = 'running' AND ar.pid IS NOT NULL`,
    )
    .all() as Array<{
    id: string;
    ticket_id: string;
    agent_type_id: string;
    pid: number;
    started_at: number;
    timeout_minutes: number;
    project_id: string;
  }>;

  for (const run of runningRuns) {
    const alive = isProcessAlive(run.pid);

    if (!alive) {
      finalizeRun(
        db,
        run.id,
        run.ticket_id,
        run.agent_type_id,
        run.project_id,
        'crashed',
        'Agent process exited while detached from daemon',
        logger,
      );
    } else {
      const timeoutMs = run.timeout_minutes * 60 * 1000;
      if (Date.now() - run.started_at > timeoutMs) {
        logger.warn({ runId: run.id, pid: run.pid, timeoutMinutes: run.timeout_minutes }, 'Detached agent exceeded timeout — sending SIGTERM');
        try {
          process.kill(run.pid, 'SIGTERM');
        } catch {
          // Already dead — next tick will finalize
        }
        setTimeout(() => {
          if (isProcessAlive(run.pid)) {
            logger.warn({ runId: run.id, pid: run.pid }, 'Detached agent did not exit after SIGTERM — sending SIGKILL');
            try {
              process.kill(run.pid, 'SIGKILL');
            } catch {
              // Already dead
            }
          }
          finalizeRun(db, run.id, run.ticket_id, run.agent_type_id, run.project_id, 'timeout',
            `Timed out after ${run.timeout_minutes} minutes (detached)`, logger);
        }, 10_000);
      }
    }
  }
}

/**
 * Spawn an agent subprocess to work on a ticket.
 *
 * Lifecycle:
 *   1. Load agent type, validate concurrency limits.
 *   2. Create agent_runs DB row (exit_status = 'running', pid stored).
 *   3. Build the system prompt via prompt-builder.
 *   4. Spawn `claude -p` detached with stdio writing directly to transcript file.
 *   5. Set up async close/timeout handlers (fire while daemon is alive).
 *   6. Unref the child so daemon can exit without waiting.
 *   7. Return immediately — completion handled by close handler or reaper.
 */
export async function runAgent(
  input: AgentRunInput,
  db: Database,
  config: Config,
  logger: Logger,
): Promise<AgentSpawnResult> {
  const { projectId, agentTypeId, ticketId } = input;
  const runId = randomUUID();

  const agentType = db
    .prepare('SELECT id, model, allowed_tools, permission_mode, timeout_minutes FROM agent_types WHERE id = ?')
    .get(agentTypeId) as AgentTypeRow | undefined;
  if (!agentType) throw new Error(`Agent type not found: ${agentTypeId}`);

  const project = db
    .prepare('SELECT path FROM projects WHERE id = ?')
    .get(projectId) as { path: string } | undefined;
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const childLogger = logger.child({ runId, agentType: agentTypeId, project: projectId });

  // Refuse to spawn if AI provider not configured. Intentionally before
  // the cap check + reservation so a misconfigured daemon does not even
  // touch the concurrency accounting or create a zombie agent_runs row
  // that would then need a CAS-guarded cleanup dance.
  if (!config.ai.auth_method) {
    childLogger.error('AI provider not configured — refusing to spawn agent');
    return { runId, pid: null, spawned: false };
  }

  if (getActiveCount(projectId) >= config.agents.max_concurrent_per_project) {
    throw new Error(
      `Concurrency limit reached for project ${projectId}: ${getActiveCount(projectId)}/${config.agents.max_concurrent_per_project}`,
    );
  }
  if (getGlobalActiveCount() >= config.agents.max_concurrent_global) {
    throw new Error(
      `Global concurrency limit reached: ${getGlobalActiveCount()}/${config.agents.max_concurrent_global}`,
    );
  }

  // Reserve the concurrency slot synchronously, BEFORE any await. Without
  // this, two concurrent handleHeartbeat runs (e.g. two projects' timers
  // firing on the same tick) could both pass the cap checks above before
  // either reached trackRun, because createWorktree is async and yields
  // the event loop. Slot is released on pre-spawn failure via the outer
  // catch below; after spawn, the child lifecycle handler owns cleanup
  // (close/error → finalizeRun → untrackRun).
  trackRun(projectId, runId);
  let insertedRow = false;

  try {
    let agentCwd = project.path;
    let agentWorktreePath: string | null = null;

    if (config.agents.parallel_coding) {
      agentCwd = await createWorktree(project.path, ticketId, logger);
      agentWorktreePath = agentCwd;
    }

    const startedAt = Date.now();
    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status, worktree_path)
       VALUES (?, ?, ?, ?, ?, 'running', ?)`,
    ).run(runId, ticketId, agentTypeId, agentType.model, startedAt, agentWorktreePath);
    insertedRow = true;

    childLogger.info({ ticketId, cwd: agentCwd, worktree: !!agentWorktreePath }, 'Agent run starting');

    const prompt = await buildPrompt({
      agentTypeId,
      projectId,
      ticketId,
      runId,
      db,
      worktreePath: agentWorktreePath,
    });

    await mkdir(ARTIFACTS_DIR, { recursive: true });

    const transcriptPath = join(ARTIFACTS_DIR, `${runId}.log`);

    // Store transcript path now — the close handler or reaper will read it
    db.prepare('UPDATE agent_runs SET transcript_path = ? WHERE id = ?').run(transcriptPath, runId);

    const tools = allowedToolsSchema.parse(JSON.parse(agentType.allowed_tools));

    const claudeArgs = [
      '-p', prompt,
      '--model', agentType.model,
      '--permission-mode', agentType.permission_mode,
      '--allowedTools', tools.join(','),
      '--output-format', 'text',
    ];

    childLogger.info({ cwd: agentCwd }, 'Spawning claude subprocess (detached)');

    const authorString = `agent:${agentTypeId}:${runId}`;

    const subprocessEnv: Record<string, string | undefined> = {
      ...process.env,
      NODE_ENV: 'production',
      DISPATCH_DB_PATH: DEFAULT_DB_PATH,
      DISPATCH_TICKET_ID: ticketId,
      DISPATCH_PROJECT_ID: projectId,
      DISPATCH_AGENT_TYPE: agentTypeId,
      DISPATCH_RUN_ID: runId,
      DISPATCH_AUTHOR: authorString,
      DISPATCH_PORT: String(config.ui.port),
      DISPATCH_TICKET_BIN: TICKET_CLI_PATH,
    };

    if (config.ai.auth_method === 'api_key' && config.ai.api_key) {
      subprocessEnv.ANTHROPIC_API_KEY = config.ai.api_key;
    } else if (config.ai.auth_method === 'custom') {
      if (config.ai.api_key) subprocessEnv.ANTHROPIC_API_KEY = config.ai.api_key;
      if (config.ai.base_url) subprocessEnv.ANTHROPIC_BASE_URL = config.ai.base_url;
    }

    // Open transcript file as fd — child inherits and writes directly.
    // Survives daemon restart (no pipe dependency on parent process).
    const fileHandle = await fsOpen(transcriptPath, 'a');

    try {
      const child = spawn(config.claude_cli.binary_path, claudeArgs, {
        cwd: agentCwd,
        detached: true,
        stdio: ['ignore', fileHandle.fd, fileHandle.fd],
        env: subprocessEnv,
      });

      const pid = child.pid ?? null;

      if (pid !== null) {
        db.prepare('UPDATE agent_runs SET pid = ? WHERE id = ?').run(pid, runId);
      }

      // Timeout enforcement — same-lifecycle only. Cross-restart handled by reaper.
      let exited = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const timeoutMs = agentType.timeout_minutes * 60 * 1000;

      const timer = setTimeout(() => {
        if (exited) return;
        childLogger.warn({ timeoutMs }, 'Agent timed out — sending SIGTERM');
        child.kill('SIGTERM');
        killTimer = setTimeout(() => {
          if (!exited) {
            childLogger.warn('Agent did not exit after SIGTERM — sending SIGKILL');
            child.kill('SIGKILL');
          }
        }, 10_000);
      }, timeoutMs);

      let exitCode: number | null = null;
      let exitSignal: string | null = null;

      child.on('exit', (code, signal) => {
        exited = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        exitCode = code;
        exitSignal = signal;
      });

      child.on('close', () => {
        let exitStatus: 'success' | 'timeout' | 'crashed';
        let errorMessage: string | null = null;

        if (exitSignal === 'SIGTERM' || exitSignal === 'SIGKILL') {
          exitStatus = 'timeout';
          errorMessage = `Timed out after ${agentType.timeout_minutes} minutes`;
        } else if (exitCode !== 0) {
          exitStatus = 'crashed';
          errorMessage = `Exited with code ${exitCode ?? 'unknown'}`;
        } else {
          exitStatus = 'success';
        }

        finalizeRun(db, runId, ticketId, agentTypeId, projectId, exitStatus, errorMessage, childLogger);
      });

      child.on('error', (err) => {
        exited = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        finalizeRun(db, runId, ticketId, agentTypeId, projectId, 'crashed', `Spawn error: ${err.message}`, childLogger);
      });

      // Detach: daemon can exit without waiting for this child.
      child.unref();

      childLogger.info({ pid }, 'Agent subprocess spawned (detached)');

      return { runId, pid, spawned: true };
    } finally {
      // Close parent's copy of the fd — child has inherited its own copy.
      await fileHandle.close();
    }
  } catch (err) {
    // Pre-spawn failure: release the reserved slot before propagating. After
    // a successful spawn, this catch is unreachable (handlers are attached
    // and the function has already returned); cleanup in that path is owned
    // by the child lifecycle via finalizeRun.
    //
    // If the INSERT already executed, the agent_runs row is left in
    // exit_status='running' with no PID. The reaper (`reapDetachedRuns`)
    // filters on `pid IS NOT NULL`, so it would never clean this row up.
    // Close it here so the ticket claim is released and the row is not
    // orphaned forever.
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (insertedRow) {
      finalizeRun(db, runId, ticketId, agentTypeId, projectId, 'crashed', errorMessage, childLogger);
    } else {
      untrackRun(projectId, runId);
    }
    throw err;
  }
}
