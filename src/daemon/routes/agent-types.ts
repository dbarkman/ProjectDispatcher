import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import {
  listAgentTypes,
  getAgentType,
  createAgentType,
  updateAgentType,
  deleteAgentType,
} from '../../db/queries/agent-types.js';

/** Root directory for prompt files. Resolved once at module load. */
const PROMPTS_DIR = resolve(join(homedir(), 'Development', '.tasks', 'prompts'));

/**
 * Validate that a prompt filename is safe — no traversal, no absolute paths,
 * must stay inside PROMPTS_DIR. Returns the resolved absolute path or throws.
 *
 * Security: This is the Review #1 watchpoint for system_prompt_path traversal.
 * Uses realpath-equivalent resolution + startsWith containment check, not
 * regex alone (regex can miss symlink escapes and edge cases).
 */
function resolvePromptPath(filename: string): string {
  // Reject obvious traversal before even resolving
  if (filename.includes('..') || filename.startsWith('/') || filename.startsWith('\\')) {
    throw new Error(`Invalid prompt filename: ${filename}`);
  }
  const full = resolve(PROMPTS_DIR, filename);
  if (!full.startsWith(PROMPTS_DIR + sep)) {
    throw new Error(`Prompt path escapes prompts directory: ${filename}`);
  }
  return full;
}

const slugParam = z.object({ id: z.string().min(1) });

const createAgentTypeBody = z.object({
  id: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'Must be a lowercase slug'),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  model: z.string().min(1),
  allowed_tools: z.array(z.string()),
  permission_mode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']),
  timeout_minutes: z.number().int().positive().optional(),
  max_retries: z.number().int().min(0).optional(),
  prompt_text: z.string().optional(), // If provided, written to <id>.md
});

const updateAgentTypeBody = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  model: z.string().min(1).optional(),
  allowed_tools: z.array(z.string()).optional(),
  permission_mode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']).optional(),
  timeout_minutes: z.number().int().positive().optional(),
  max_retries: z.number().int().min(0).optional(),
  prompt_text: z.string().optional(), // If provided, overwrites the prompt file
});

export async function agentTypeRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // GET /api/agent-types
  app.get('/api/agent-types', async () => {
    return listAgentTypes(db);
  });

  // GET /api/agent-types/:id — includes prompt text read from disk
  app.get<{ Params: { id: string } }>('/api/agent-types/:id', async (request, reply) => {
    const { id } = slugParam.parse(request.params);
    const at = getAgentType(db, id);
    if (!at) return reply.status(404).send({ error: 'Agent type not found' });

    // Read prompt file — no stale cache, always fresh from disk
    let promptText: string | null = null;
    try {
      const promptPath = resolvePromptPath(at.system_prompt_path);
      if (existsSync(promptPath)) {
        promptText = await readFile(promptPath, 'utf8');
      }
    } catch {
      // Path resolution failed or file missing — return null, not an error
    }

    return { ...at, prompt_text: promptText };
  });

  // POST /api/agent-types
  app.post('/api/agent-types', async (request, reply) => {
    const body = createAgentTypeBody.parse(request.body);

    const exists = db.prepare('SELECT 1 FROM agent_types WHERE id = ?').get(body.id);
    if (exists) {
      return reply.status(409).send({ error: `Agent type already exists: ${body.id}` });
    }

    const promptFilename = `${body.id}.md`;

    // Write prompt file if text was provided
    if (body.prompt_text) {
      const promptPath = resolvePromptPath(promptFilename);
      await mkdir(dirname(promptPath), { recursive: true });
      await writeFile(promptPath, body.prompt_text, 'utf8');
    }

    const at = createAgentType(db, {
      id: body.id,
      name: body.name,
      description: body.description,
      systemPromptPath: promptFilename,
      model: body.model,
      allowedTools: body.allowed_tools,
      permissionMode: body.permission_mode,
      timeoutMinutes: body.timeout_minutes,
      maxRetries: body.max_retries,
    });

    return reply.status(201).send(at);
  });

  // PATCH /api/agent-types/:id
  app.patch<{ Params: { id: string } }>('/api/agent-types/:id', async (request, reply) => {
    const { id } = slugParam.parse(request.params);
    const body = updateAgentTypeBody.parse(request.body);

    // Write prompt file if text was provided
    if (body.prompt_text !== undefined) {
      const existing = getAgentType(db, id);
      if (!existing) return reply.status(404).send({ error: 'Agent type not found' });

      const promptPath = resolvePromptPath(existing.system_prompt_path);
      await mkdir(dirname(promptPath), { recursive: true });
      await writeFile(promptPath, body.prompt_text, 'utf8');
    }

    const updated = updateAgentType(db, id, {
      name: body.name,
      description: body.description,
      model: body.model,
      allowedTools: body.allowed_tools,
      permissionMode: body.permission_mode,
      timeoutMinutes: body.timeout_minutes,
      maxRetries: body.max_retries,
    });

    if (!updated) return reply.status(404).send({ error: 'Agent type not found' });
    return updated;
  });

  // DELETE /api/agent-types/:id
  app.delete<{ Params: { id: string } }>('/api/agent-types/:id', async (request, reply) => {
    const { id } = slugParam.parse(request.params);
    const result = deleteAgentType(db, id);

    if (!result.deleted) {
      const status = result.reason === 'not_found' ? 404 : 409;
      const message =
        result.reason === 'is_builtin'
          ? 'Cannot delete built-in agent type'
          : result.reason === 'in_use'
            ? 'Cannot delete agent type: in use by project type columns'
            : 'Agent type not found';
      return reply.status(status).send({ error: message });
    }

    return { status: 'deleted' };
  });
}
