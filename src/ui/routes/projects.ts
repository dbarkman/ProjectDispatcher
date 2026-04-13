import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { listProjects, getProject } from '../../db/queries/projects.js';
import { listProjectTypes } from '../../db/queries/project-types.js';
import { discoverProjects, folderDisplayName } from '../../daemon/discovery.js';
import { getInboxCount } from './helpers.js';
import type { Config } from '../../config.schema.js';

const uuidParam = z.object({ id: z.string().uuid() });

export async function projectUiRoutes(app: FastifyInstance, db: Database, config?: Config): Promise<void> {
  // GET /ui/projects — projects list with register form
  app.get('/ui/projects', async (request, reply) => {
    const projects = listProjects(db);
    const projectTypes = listProjectTypes(db);

    // Get discovered-but-not-registered folders
    let discovered: Array<{ path: string; name: string }> = [];
    if (config) {
      try {
        const disc = await discoverProjects(db, config);
        discovered = disc.discovered.map((p) => ({ path: p, name: folderDisplayName(p) }));
      } catch {
        // Discovery failure shouldn't break the page
      }
    }

    return reply.view('projects.hbs', {
      activePage: 'projects',
      pageTitle: 'Projects',
      breadcrumbs: [{ label: 'Projects', href: '/ui/projects' }],
      projects,
      projectTypes,
      discovered,
      inboxCount: getInboxCount(db) || undefined,
    });
  });

  // GET /ui/projects/:id — project board
  app.get<{ Params: { id: string } }>('/ui/projects/:id', async (request, reply) => {
    const { id } = uuidParam.parse(request.params);
    const project = getProject(db, id);
    if (!project) return reply.status(404).send('Project not found');

    // Get columns for this project type
    const columns = db
      .prepare(
        `SELECT column_id, name, agent_type_id, "order"
         FROM project_type_columns
         WHERE project_type_id = ?
         ORDER BY "order"`,
      )
      .all(project.project_type_id) as Array<{
        column_id: string;
        name: string;
        agent_type_id: string | null;
        order: number;
      }>;

    // Get tickets grouped by column
    const tickets = db
      .prepare(
        `SELECT id, title, priority, "column", claimed_by_run_id, updated_at
         FROM tickets WHERE project_id = ?
         ORDER BY created_at`,
      )
      .all(project.id) as Array<{
        id: string;
        title: string;
        priority: string;
        column: string;
        claimed_by_run_id: string | null;
        updated_at: number;
      }>;

    const ticketsByColumn = new Map<string, typeof tickets>();
    for (const col of columns) {
      ticketsByColumn.set(col.column_id, []);
    }
    for (const t of tickets) {
      const list = ticketsByColumn.get(t.column);
      if (list) list.push(t);
    }

    const boardColumns = columns.map((col) => ({
      ...col,
      isAgent: col.agent_type_id !== null,
      isDone: col.column_id === 'done',
      isHuman: col.column_id === 'human',
      tickets: (ticketsByColumn.get(col.column_id) ?? []).map((t) => ({
        ...t,
        shortId: t.id.slice(0, 8),
        isClaimed: t.claimed_by_run_id !== null,
      })),
    }));

    return reply.view('board.hbs', {
      activePage: 'projects',
      pageTitle: project.name,
      inboxCount: getInboxCount(db) || undefined,
      breadcrumbs: [
        { label: 'Projects', href: '/ui/projects' },
        { label: project.name, href: `/ui/projects/${project.id}` },
      ],
      project,
      columns: boardColumns,
    });
  });
}
