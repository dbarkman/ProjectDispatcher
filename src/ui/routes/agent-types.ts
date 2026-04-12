import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { listAgentTypes, getAgentType } from '../../db/queries/agent-types.js';
import { resolvePromptPath } from '../../services/prompt-file.js';
import { getInboxCount } from './helpers.js';

const slugParam = z.object({ id: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/) });

export async function agentTypeUiRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // GET /ui/agent-types — list
  app.get('/ui/agent-types', async (request, reply) => {
    const types = listAgentTypes(db);
    return reply.view('agent-types.hbs', {
      activePage: 'agent-types',
      pageTitle: 'Agent Types',
      breadcrumbs: [{ label: 'Agent Types', href: '/ui/agent-types' }],
      types,
      inboxCount: getInboxCount(db) || undefined,
    });
  });

  // GET /ui/agent-types/:id — detail with prompt editor
  app.get<{ Params: { id: string } }>('/ui/agent-types/:id', async (request, reply) => {
    const { id } = slugParam.parse(request.params);
    const at = getAgentType(db, id);
    if (!at) return reply.status(404).send('Agent type not found');

    let promptText = '';
    try {
      const path = resolvePromptPath(at.system_prompt_path);
      promptText = await readFile(path, 'utf8');
    } catch {
      // File missing — empty editor
    }

    const tools = (() => {
      try { return JSON.parse(at.allowed_tools) as string[]; }
      catch { return []; }
    })();

    return reply.view('agent-type-detail.hbs', {
      activePage: 'agent-types',
      pageTitle: at.name,
      breadcrumbs: [
        { label: 'Agent Types', href: '/ui/agent-types' },
        { label: at.name, href: `/ui/agent-types/${at.id}` },
      ],
      agentType: at,
      promptText,
      tools,
    });
  });
}
