import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
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

// Portable __dirname for ESM (Review #6 L4 — import.meta.dirname requires Node 21.2)
const __dirname = dirname(fileURLToPath(import.meta.url));

const ARTIFACTS_DIR = join(DEFAULT_TASKS_DIR, 'artifacts', 'runs');

const allowedToolsSchema = z.array(z.string().min(1));

/**
 * Pick the right command for spawning the MCP server.
 *   - Prod (npm run build): dist/mcp/server.js exists; spawn `node` directly.
 *     No tsx runtime needed in production install — keeps the dependency
 *     surface tight (tsx stays in devDependencies).
 *   - Dev (tsx-watch daemon): no dist; spawn via `npx tsx` against the .ts
 *     source. Local node_modules/.bin is on PATH because the daemon was
 *     launched via `npm run dev`, so npx finds tsx without a registry hit.
 *
 * Resolved once at module load (one sync existsSync at startup, before the
 * server binds — same pattern as runMigrations sync I/O).
 */
function resolveMcpServerSpawn(): { command: string; args: string[] } {
  const distPath = resolve(join(__dirname, '..', 'mcp', 'server.js'));
  if (existsSync(distPath)) {
    return { command: 'node', args: [distPath] };
  }
  const srcPath = resolve(join(__dirname, '..', 'mcp', 'server.ts'));
  return { command: 'npx', args: ['tsx', srcPath] };
}

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
 *   4. Write a temporary MCP config file.
 *   5. Spawn `claude -p` with scrubbed env (whitelist-only).
 *   6. Pipe stdout/stderr to a transcript file.
 *   7. Enforce timeout: SIGTERM → 10s grace → SIGKILL.
 *   8. On exit: update agent_runs, release claim on failure, add block comment.
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

  // Create agent_runs row
  const startedAt = Date.now();
  db.prepare(
    `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, exit_status)
     VALUES (?, ?, ?, ?, ?, 'running')`,
  ).run(runId, ticketId, agentTypeId, agentType.model, startedAt);

  trackRun(projectId, runId);

  const childLogger = logger.child({ runId, agentType: agentTypeId, project: projectId });
  childLogger.info({ ticketId }, 'Agent run starting');

  // MCP config temp file path — cleaned up in finally block
  let mcpConfigPath: string | null = null;

  try {
    // Build the system prompt
    const prompt = await buildPrompt({
      agentTypeId,
      projectId,
      ticketId,
      runId,
      db,
    });

    // Write MCP config to a temp file
    mcpConfigPath = join(ARTIFACTS_DIR, `${runId}-mcp.json`);
    await mkdir(ARTIFACTS_DIR, { recursive: true });

    // Build the MCP server spawn config. Prefer the compiled JS in prod
    // (no TS runtime needed) and fall back to tsx + .ts in dev where the
    // tsx-watch daemon never emits dist/. Earlier code hardcoded server.js
    // which doesn't exist in dev, so agents got "MCP tools not available"
    // from a silent spawn failure. (Ticket #5e892a59.)
    const spawnCmd = resolveMcpServerSpawn();
    const mcpConfig = {
      mcpServers: {
        dispatch: {
          command: spawnCmd.command,
          args: spawnCmd.args,
          env: {
            DISPATCH_RUN_ID: runId,
            DISPATCH_TICKET_ID: ticketId,
            DISPATCH_PROJECT_ID: projectId,
            DISPATCH_AGENT_TYPE: agentTypeId,
            DISPATCH_DB_PATH: DEFAULT_DB_PATH,
          },
        },
      },
    };
    await writeFile(mcpConfigPath, JSON.stringify(mcpConfig), 'utf8');

    // Set up transcript file
    const transcriptPath = join(ARTIFACTS_DIR, `${runId}.log`);
    const transcriptStream = createWriteStream(transcriptPath, { flags: 'a' });

    // Parse + validate allowed_tools (Review #6 M3 — Zod at every boundary)
    const tools = allowedToolsSchema.parse(JSON.parse(agentType.allowed_tools));

    // Build the claude command
    const claudeArgs = [
      '-p', prompt,
      '--model', agentType.model,
      '--permission-mode', agentType.permission_mode,
      '--mcp-config', mcpConfigPath,
      '--allowedTools', tools.join(','),
      '--output-format', 'text',
    ];

    childLogger.info({ cwd: project.path }, 'Spawning claude subprocess');

    // Subprocess environment: inherit the full parent env.
    //
    // The claude CLI authenticates via OAuth tokens stored in ~/.claude/
    // (not just ANTHROPIC_API_KEY). Scrubbing the env breaks OAuth auth,
    // which is how most Claude Code users authenticate. Since this is a
    // single-user localhost tool where the subprocess runs as the same
    // user with the same trust level, inheriting the env is the correct
    // default. A future config option can offer a scrubbed whitelist mode
    // for users who want it.

    // Spawn the subprocess
    const result = await new Promise<AgentRunResult>((resolvePromise) => {
      const child: ChildProcess = spawn(config.claude_cli.binary_path, claudeArgs, {
        cwd: project.path,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_ENV: 'production' },
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

      child.on('exit', (code, signal) => {
        exited = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        transcriptStream.end();

        const durationMs = Date.now() - startedAt;
        let exitStatus: AgentRunResult['exitStatus'];
        let errorMessage: string | null = null;

        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          exitStatus = 'timeout';
          errorMessage = `Timed out after ${agentType.timeout_minutes} minutes`;
        } else if (code !== 0) {
          exitStatus = 'crashed';
          errorMessage = `Exited with code ${code ?? 'unknown'}`;
        } else {
          exitStatus = 'success';
        }

        resolvePromise({ runId, exitStatus, exitCode: code, errorMessage, durationMs });
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
    // Clean up temp MCP config (Review #6 LOW-03 — moved to finally)
    if (mcpConfigPath) {
      try {
        await unlink(mcpConfigPath);
      } catch {
        // Best-effort cleanup
      }
    }
  }
}
