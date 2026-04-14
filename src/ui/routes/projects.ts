import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { listProjects, getProject } from '../../db/queries/projects.js';
import {
  getProjectType,
  getProjectTypeForProject,
  listProjectTypes,
} from '../../db/queries/project-types.js';
import {
  listAgentTypes,
  listAgentTypesForProject,
} from '../../db/queries/agent-types.js';
import { discoverProjects, folderDisplayName } from '../../daemon/discovery.js';
import { getInboxCount } from './helpers.js';
import { getTicketStatuses } from '../../db/queries/agent-runs.js';
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

    const ticketStatuses = getTicketStatuses(db, id);

    const boardColumns = columns.map((col) => ({
      ...col,
      isAgent: col.agent_type_id !== null,
      isDone: col.column_id === 'done',
      isHuman: col.column_id === 'human',
      tickets: (ticketsByColumn.get(col.column_id) ?? []).map((t) => ({
        ...t,
        shortId: t.id.slice(0, 8),
        isClaimed: t.claimed_by_run_id !== null,
        statusColor: ticketStatuses.get(t.id) ?? 'gray',
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

  // GET /ui/projects/:id/workflow — column + agent editor for a project.
  //
  // Shows the project's private project_type (cloned from its template at
  // registration) and lets the user add / remove / rename / reorder columns
  // and assign an agent per column. Legacy projects that still point at a
  // shared library type get a "re-register to customize" message.
  app.get<{ Params: { id: string } }>('/ui/projects/:id/workflow', async (request, reply) => {
    const { id } = uuidParam.parse(request.params);
    const project = getProject(db, id);
    if (!project) return reply.status(404).send('Project not found');

    const workflow = getProjectTypeForProject(db, id);
    // Legacy: project was registered before migration 003 and still points
    // at a shared library template. Don't let the user edit the library.
    const isLegacy = workflow === null;
    const legacyLibraryType = isLegacy ? getProjectType(db, project.project_type_id) : null;

    const library = listAgentTypes(db); // owner IS NULL
    const forked = listAgentTypesForProject(db, id); // owner = this project

    // Build one flat agent list with a scope label for the dropdown.
    const agentChoices = [
      ...forked.map((a) => ({
        id: a.id,
        name: a.name,
        scope: 'project',
        scopeLabel: 'project',
      })),
      ...library.map((a) => ({
        id: a.id,
        name: a.name,
        scope: 'library',
        scopeLabel: a.is_builtin ? 'built-in' : 'library',
      })),
    ];

    return reply.view('workflow.hbs', {
      activePage: 'projects',
      pageTitle: `${project.name} — Workflow`,
      inboxCount: getInboxCount(db) || undefined,
      breadcrumbs: [
        { label: 'Projects', href: '/ui/projects' },
        { label: project.name, href: `/ui/projects/${project.id}` },
        { label: 'Workflow', href: `/ui/projects/${project.id}/workflow` },
      ],
      project,
      workflow,
      isLegacy,
      legacyLibraryType,
      agentChoices,
      // Escape </ to <\/ so the embedded JSON can't break out of the
      // enclosing <script> tag even if an agent's name contains '</script>'.
      // The page uses {{{ }}} to inject this as raw HTML inside a
      // <script type="application/json"> block; parsed by JSON.parse at runtime.
      agentChoicesJson: JSON.stringify(agentChoices).replace(/<\/(script)/gi, '<\\/$1'),
    });
  });
}
