import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Config } from '../config.schema.js';
import { DEFAULT_DB_PATH } from '../db/index.js';
import { addComment } from '../db/queries/tickets.js';
import { buildPrompt } from '../services/prompt-builder.js';

const ARTIFACTS_DIR = join(homedir(), 'Development', '.tasks', 'artifacts', 'runs');

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
 * 1. Load the agent type, validate concurrency limits.
 * 2. Create an agent_runs DB row (status = 'running').
 * 3. Build the system prompt.
 * 4. Write a temporary MCP config file.
 * 5. Spawn `claude -p` with the prompt, MCP config, CWD, model, tools,
 *    and permission mode.
 * 6. Pipe stdout/stderr to a transcript file.
 * 7. Enforce the timeout.
 * 8. On exit: update the agent_runs row, release the ticket claim if
 *    crashed/timed out, add a block comment on failure.
 *
 * Returns a promise that resolves when the subprocess exits.
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
    const mcpConfigPath = join(ARTIFACTS_DIR, `${runId}-mcp.json`);
    await mkdir(ARTIFACTS_DIR, { recursive: true });

    // Resolve the MCP server script path relative to this file's compiled location
    const mcpServerPath = resolve(join(import.meta.dirname ?? '.', '..', 'mcp', 'server.js'));

    const mcpConfig = {
      mcpServers: {
        dispatch: {
          command: 'node',
          args: [mcpServerPath],
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

    // Parse allowed_tools
    const tools = JSON.parse(agentType.allowed_tools) as string[];

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

    // Spawn the subprocess
    const result = await new Promise<AgentRunResult>((resolvePromise) => {
      const child: ChildProcess = spawn(config.claude_cli.binary_path, claudeArgs, {
        cwd: project.path,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Don't inherit potentially dangerous env — only pass what's needed
          HOME: homedir(),
          PATH: process.env['PATH'] ?? '',
          NODE_ENV: process.env['NODE_ENV'] ?? 'production',
        },
      });

      child.stdout?.pipe(transcriptStream);
      child.stderr?.pipe(transcriptStream);

      // Timeout enforcement
      const timeoutMs = agentType.timeout_minutes * 60 * 1000;
      const timer = setTimeout(() => {
        childLogger.warn({ timeoutMs }, 'Agent timed out — sending SIGTERM');
        child.kill('SIGTERM');
        // Grace period: if still alive after 10 seconds, SIGKILL
        setTimeout(() => {
          if (!child.killed) {
            childLogger.warn('Agent did not exit after SIGTERM — sending SIGKILL');
            child.kill('SIGKILL');
          }
        }, 10_000);
      }, timeoutMs);

      child.on('exit', (code, signal) => {
        clearTimeout(timer);
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
        clearTimeout(timer);
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

    // On failure: release the ticket claim and add a block comment
    if (result.exitStatus !== 'success') {
      childLogger.warn({ exitStatus: result.exitStatus, errorMessage: result.errorMessage }, 'Agent run failed');

      db.prepare(
        'UPDATE tickets SET claimed_by_run_id = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?',
      ).run(Date.now(), ticketId);

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
    } else {
      childLogger.info({ durationMs: result.durationMs }, 'Agent run completed successfully');
    }

    // Clean up temp MCP config
    try {
      await unlink(mcpConfigPath);
    } catch {
      // Best-effort cleanup
    }

    return result;
  } finally {
    untrackRun(projectId, runId);
  }
}
