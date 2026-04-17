import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
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
import { createWorktree, worktreePath } from './worktree.js';

// Portable __dirname for ESM (Review #6 L4 — import.meta.dirname requires Node 21.2)
const __dirname = dirname(fileURLToPath(import.meta.url));

const ARTIFACTS_DIR = join(DEFAULT_TASKS_DIR, 'artifacts', 'runs');

const allowedToolsSchema = z.array(z.string().min(1));

/** Path to the ticket CLI script that agents call via Bash to read/comment/move tickets. */
const TICKET_CLI_PATH = resolve(join(__dirname, '..', 'cli', 'ticket.cjs'));

export interface AgentRunResult {
  runId: string;
  exitStatus: 'success' | 'timeout' | 'crashed' | 'blocked';
  exitCode: number | null;
  errorMessage: string | null;
  durationMs: number;
}

interface AgentRunInput {
  projectId: string;
  agentTypeId: string;
  ticketId: string;
}

interface AgentTypeRow {
  id: string;
  model: string;
  allowed_tools: string; // JSON array
  permission_mode: string;
  timeout_minutes: number;
}

/** Track active runs for concurrency enforcement. */
const activeRuns = new Map<string, Set<string>>(); // projectId → Set<runId>

function getActiveCount(projectId: string): number {
  return activeRuns.get(projectId)?.size ?? 0;
}

function getGlobalActiveCount(): number {
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
 * Spawn an agent subprocess to work on a ticket.
 *
 * Lifecycle:
 *   1. Load agent type, validate concurrency limits.
 *   2. Create agent_runs DB row (exit_status = 'running').
 *   3. Build the system prompt via prompt-builder.
 *   4. Spawn `claude -p` with ticket CLI env vars.
 *   5. Pipe stdout/stderr to a transcript file.
 *   6. Enforce timeout: SIGTERM → 10s grace → SIGKILL.
 *   7. On exit: update agent_runs, release claim on failure, add block comment.
 */
export async function runAgent(
  input: AgentRunInput,
  db: Database,
  config: Config,
  logger: Logger,
): Promise<AgentRunResult> {
  const { projectId, agentTypeId, ticketId } = input;
  const runId = randomUUID();

  // Load agent type
  const agentType = db
    .prepare('SELECT id, model, allowed_tools, permission_mode, timeout_minutes FROM agent_types WHERE id = ?')
    .get(agentTypeId) as AgentTypeRow | undefined;
  if (!agentType) throw new Error(`Agent type not found: ${agentTypeId}`);

  // Load project for CWD
  const project = db
    .prepare('SELECT path FROM projects WHERE id = ?')
    .get(projectId) as { path: string } | undefined;
  if (!project) throw new Error(`Project not found: ${projectId}`);

  // Concurrency checks
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

  // Resolve the agent's working directory. When parallel_coding is enabled,
  // each ticket gets its own git worktree so multiple agents can work on the
  // same project without file conflicts.
  let agentCwd = project.path;
  let agentWorktreePath: string | null = null;

  if (config.agents.parallel_coding) {
    try {
      const expectedPath = worktreePath(project.path, ticketId);
      try {
        await access(expectedPath);
        agentCwd = expectedPath;
        agentWorktreePath = expectedPath;
      } catch {
        agentCwd = await createWorktree(project.path, ticketId, logger);
        agentWorktreePath = agentCwd;
      }
    } catch (err) {
      logger.error({ err, ticketId, projectId }, 'Failed to create worktree — falling back to project path');
    }
  }

  // Create agent_runs row
  const startedAt = Date.now();
  db.prepare(
    `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status, worktree_path)
     VALUES (?, ?, ?, ?, ?, 'running', ?)`,
  ).run(runId, ticketId, agentTypeId, agentType.model, startedAt, agentWorktreePath);

  trackRun(projectId, runId);

  const childLogger = logger.child({ runId, agentType: agentTypeId, project: projectId });
  childLogger.info({ ticketId, cwd: agentCwd, worktree: !!agentWorktreePath }, 'Agent run starting');

  try {
    // Build the system prompt
    const prompt = await buildPrompt({
      agentTypeId,
      projectId,
      ticketId,
      runId,
      db,
      worktreePath: agentWorktreePath,
    });

    await mkdir(ARTIFACTS_DIR, { recursive: true });

    // Set up transcript file
    const transcriptPath = join(ARTIFACTS_DIR, `${runId}.log`);
    const transcriptStream = createWriteStream(transcriptPath, { flags: 'a' });

    // Parse + validate allowed_tools (Review #6 M3 — Zod at every boundary)
    const tools = allowedToolsSchema.parse(JSON.parse(agentType.allowed_tools));

    // Build the claude command — no MCP. Agents interact with tickets via
    // the ticket CLI script (src/cli/ticket.cjs) called through Bash.
    // The CLI is a thin Node.js wrapper around parameterized SQLite queries.
    // Env vars tell the script where the DB is and who's calling.
    const claudeArgs = [
      '-p', prompt,
      '--model', agentType.model,
      '--permission-mode', agentType.permission_mode,
      '--allowedTools', tools.join(','),
      '--output-format', 'text',
    ];

    childLogger.info({ cwd: agentCwd }, 'Spawning claude subprocess');

    // Build the author string for ticket CLI comments
    const authorString = `agent:${agentTypeId}:${runId}`;

    // Refuse to spawn if AI provider not configured
    if (!config.ai.auth_method) {
      const durationMs = Date.now() - startedAt;
      db.prepare(
        `UPDATE agent_runs SET exit_status = 'crashed', ended_at = ?, error_message = ? WHERE id = ?`,
      ).run(Date.now(), 'AI provider not configured', runId);

      db.transaction(() => {
        db.prepare(
          'UPDATE tickets SET claimed_by_run_id = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND claimed_by_run_id = ?',
        ).run(Date.now(), ticketId, runId);
        addComment(db, ticketId, {
          type: 'block',
          author: authorString,
          body: 'AI provider not configured. Visit the setup wizard to configure authentication before agents can run.',
          meta: { run_id: runId, exit_status: 'crashed' },
        });
      })();

      childLogger.error('AI provider not configured — refusing to spawn agent');
      return { runId, exitStatus: 'crashed', exitCode: null, errorMessage: 'AI provider not configured', durationMs };
    }

    // Subprocess env: inherit parent + overlay auth based on config.ai.auth_method
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
    // auth_method === 'oauth': inherit parent env (current behavior)

    // Spawn the subprocess
    const result = await new Promise<AgentRunResult>((resolvePromise) => {
      const child: ChildProcess = spawn(config.claude_cli.binary_path, claudeArgs, {
        cwd: agentCwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: subprocessEnv,
      });

      child.stdout?.pipe(transcriptStream);
      child.stderr?.pipe(transcriptStream);

      let exited = false;

      // Timeout enforcement — SIGTERM then SIGKILL grace period.
      // Review #6 H1 / HIGH-02: child.killed is set when kill() is CALLED,
      // not when the process EXITS. We track exit state ourselves via a flag
      // and clear the kill timer on the 'exit' event.
      const timeoutMs = agentType.timeout_minutes * 60 * 1000;
      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const timer = setTimeout(() => {
        childLogger.warn({ timeoutMs }, 'Agent timed out — sending SIGTERM');
        child.kill('SIGTERM');
        // Grace period: SIGKILL after 10 seconds if not exited
        killTimer = setTimeout(() => {
          if (!exited) {
            childLogger.warn('Agent did not exit after SIGTERM — sending SIGKILL');
            child.kill('SIGKILL');
          }
        }, 10_000);
      }, timeoutMs);

      // Capture exit code + signal from 'exit' (fires when process ends).
      // Resolve the promise from 'close' (fires when process ends AND all
      // stdio pipes have flushed). Using 'exit' alone caused transcriptStream
      // to end() before stdout/stderr data was fully consumed → empty logs.
      // (Overnight 242 runs had 0-byte transcripts from this bug.)
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
        // All stdio streams fully drained. Safe to end the transcript now.
        transcriptStream.end();

        const durationMs = Date.now() - startedAt;
        let exitStatus: AgentRunResult['exitStatus'];
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

        resolvePromise({ runId, exitStatus, exitCode, errorMessage, durationMs });
      });

      child.on('error', (err) => {
        exited = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        transcriptStream.end();
        const durationMs = Date.now() - startedAt;
        resolvePromise({
          runId,
          exitStatus: 'crashed',
          exitCode: null,
          errorMessage: `Spawn error: ${err.message}`,
          durationMs,
        });
      });
    });

    // Update the agent_runs row
    db.prepare(
      `UPDATE agent_runs
       SET exit_status = ?, ended_at = ?, transcript_path = ?, error_message = ?
       WHERE id = ?`,
    ).run(result.exitStatus, Date.now(), transcriptPath, result.errorMessage, runId);

    // On failure: release the ticket claim and add a block comment.
    // Atomic: both ops in one transaction so the ticket can't end up
    // unclaimed-but-no-block-comment if the process crashes between them.
    // (Final Review H-01)
    if (result.exitStatus !== 'success') {
      childLogger.warn({ exitStatus: result.exitStatus, errorMessage: result.errorMessage }, 'Agent run failed');

      db.transaction(() => {
        db.prepare(
          'UPDATE tickets SET claimed_by_run_id = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND claimed_by_run_id = ?',
        ).run(Date.now(), ticketId, runId);

        addComment(db, ticketId, {
          type: 'block',
          author: `agent:${agentTypeId}:${runId}`,
          body: `Agent run failed: ${result.errorMessage ?? result.exitStatus}. Releasing claim. This ticket needs human attention.`,
          meta: {
            run_id: runId,
            exit_status: result.exitStatus,
            exit_code: result.exitCode,
          duration_ms: result.durationMs,
        },
      });
      })(); // end transaction
    } else {
      childLogger.info({ durationMs: result.durationMs }, 'Agent run completed successfully');
    }

    return result;
  } finally {
    untrackRun(projectId, runId);
  }
}
