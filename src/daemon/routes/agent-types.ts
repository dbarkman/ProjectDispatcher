import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import {
  listAgentTypes,
  getAgentType,
  createAgentType,
  updateAgentType,
  deleteAgentType,
} from '../../db/queries/agent-types.js';
import {
  resolvePromptPath,
  writePromptFile,
} from '../../services/prompt-file.js';

// Slug param — same constraint as create-time. (Code Review #4 F-06)
const slugParam = z.object({
  id: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'Must be a lowercase slug'),
});

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

    // Read prompt file — no stale cache, always fresh from disk.
    // Uses try/catch instead of existsSync to avoid sync I/O in a request
    // handler (Code Review #4 F-03, Security Review #4 LOW).
    let promptText: string | null = null;
    try {
      const promptPath = resolvePromptPath(at.system_prompt_path);
      promptText = await readFile(promptPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Prompt file missing — warn so the operator knows. Agents launched
        // against this type will get a degraded prompt. (Final Review M-01)
        request.log.warn({ path: at.system_prompt_path }, 'Prompt file missing for agent type');
      } else {
        request.log.warn({ err, path: at.system_prompt_path }, 'Failed to read prompt file');
      }
      // promptText stays null
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

    // DB first, then file — a failed file write after a successful DB insert
    // is easier to recover from (retry on next write) than an orphaned file
    // with no DB row. (Review #5 F-05)
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

    // Write prompt file after DB success (atomic via temp+rename).
    // Uses !== undefined for consistency with the PATCH handler — empty
    // string is a valid "clear the prompt" operation. (Review #5 F-04)
    if (body.prompt_text !== undefined) {
      await writePromptFile(body.id, body.prompt_text);
    }

    return reply.status(201).send(at);
  });

  // PATCH /api/agent-types/:id
  app.patch<{ Params: { id: string } }>('/api/agent-types/:id', async (request, reply) => {
    const { id } = slugParam.parse(request.params);
    const body = updateAgentTypeBody.parse(request.body);

    // DB first, then file — same ordering rationale as POST. (Review #5 F-05)
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

    // Write prompt file after DB success (atomic via temp+rename)
    if (body.prompt_text !== undefined) {
      const promptId = updated.system_prompt_path.replace(/\.md$/, '');
      await writePromptFile(promptId, body.prompt_text);
    }

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
