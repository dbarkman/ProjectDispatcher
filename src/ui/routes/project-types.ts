import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { listProjectTypes, getProjectType } from '../../db/queries/project-types.js';
import { listAgentTypes } from '../../db/queries/agent-types.js';
import { getInboxCount } from './helpers.js';

const slugParam = z.object({ id: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/) });

export async function projectTypeUiRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // GET /ui/project-types — list
  app.get('/ui/project-types', async (_request, reply) => {
    const types = listProjectTypes(db);
    return reply.view('project-types.hbs', {
      activePage: 'project-types',
      pageTitle: 'Project Types',
      breadcrumbs: [{ label: 'Project Types', href: '/ui/project-types' }],
      types,
      inboxCount: getInboxCount(db) || undefined,
    });
  });

  // GET /ui/project-types/:id — detail with columns editor
  app.get<{ Params: { id: string } }>('/ui/project-types/:id', async (request, reply) => {
    const { id } = slugParam.parse(request.params);
    const pt = getProjectType(db, id);
    if (!pt) return reply.status(404).send('Project type not found');

    const agentTypes = listAgentTypes(db);

    return reply.view('project-type-detail.hbs', {
      activePage: 'project-types',
      pageTitle: pt.name,
      breadcrumbs: [
        { label: 'Project Types', href: '/ui/project-types' },
        { label: pt.name, href: `/ui/project-types/${pt.id}` },
      ],
      projectType: pt,
      columnsJson: JSON.stringify(pt.columns),
      agentTypes,
      agentTypesJson: JSON.stringify(agentTypes.map((at) => ({ id: at.id, name: at.name }))),
      inboxCount: getInboxCount(db) || undefined,
    });
  });
}
