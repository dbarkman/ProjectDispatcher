import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { listProjects, getProject } from '../../db/queries/projects.js';
import {
  getProjectTypeForProject,
  listProjectTypes,
} from '../../db/queries/project-types.js';
import {
  getAgentType,
  listAgentTypes,
  listAgentTypesForProject,
} from '../../db/queries/agent-types.js';
import { formatTicketDisplayId } from '../../db/queries/abbreviation.js';
// Handlebars import no longer needed — boardColumnsTemplate is pre-compiled
// and injected from setup.ts.
import { readFile } from 'node:fs/promises';
import { resolvePromptPath } from '../../services/prompt-file.js';
import { discoverProjects, folderDisplayName } from '../../daemon/discovery.js';
import { getInboxCount } from './helpers.js';
import { getTicketStatuses } from '../../db/queries/agent-runs.js';
import type { ConfigRef } from '../../config.schema.js';

const uuidParam = z.object({ id: z.string().uuid() });

interface ProjectRoutesDeps {
  boardColumnsTemplate: HandlebarsTemplateDelegate;
}

export async function projectUiRoutes(
  app: FastifyInstance,
  db: Database,
  configRef: ConfigRef,
  deps: ProjectRoutesDeps,
): Promise<void> {
  // GET /ui/projects — projects list with register form
  app.get('/ui/projects', async (request, reply) => {
    const projects = listProjects(db);
    const projectTypes = listProjectTypes(db);

    // Get discovered-but-not-registered folders
    let discovered: Array<{ path: string; name: string }> = [];
    try {
      const disc = await discoverProjects(db, configRef.current);
      discovered = disc.discovered.map((p) => ({ path: p, name: folderDisplayName(p) }));
    } catch {
      // Discovery failure shouldn't break the page
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
        `SELECT id, title, priority, "column", claimed_by_run_id, sequence_number, updated_at
         FROM tickets WHERE project_id = ?
         ORDER BY created_at`,
      )
      .all(project.id) as Array<{
        id: string;
        title: string;
        priority: string;
        column: string;
        claimed_by_run_id: string | null;
        sequence_number: number;
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
        displayId: formatTicketDisplayId(project.abbreviation, t.sequence_number),
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
  // and assign an agent per column. Returns 500 if the project's scoped
  // project_type is missing (a broken invariant — only possible via direct
  // DB manipulation, never via the API).
  app.get<{ Params: { id: string } }>('/ui/projects/:id/workflow', async (request, reply) => {
    const { id } = uuidParam.parse(request.params);
    const project = getProject(db, id);
    if (!project) return reply.status(404).send('Project not found');

    const workflow = getProjectTypeForProject(db, id);
    if (!workflow) {
      // Should never happen for a project created via the API — registration
      // always clones a scoped project_type. Fail loud so a broken row is
      // visible instead of silently rendering an editor with no columns.
      return reply.status(500).send('Project workflow state is inconsistent.');
    }

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
      agentChoices,
      // Aggressively escape every '<' to its Unicode form. Defends against:
      //   - </script> breaking out of the <script> tag,
      //   - <!-- / <script driving the tokenizer into script-data-*-escaped
      //     state even inside type="application/json" (reviewer M-04, sec L-01),
      //   - any future HTML-parser quirk.
      // JSON.parse handles '\u003C' identically to '<', so runtime behavior
      // is unchanged. The page uses {{{ }}} to inject this as raw HTML inside
      // a <script type="application/json"> block.
      agentChoicesJson: JSON.stringify(agentChoices).replace(/</g, '\\u003C'),
    });
  });

  // GET /ui/projects/:id/board-partial — htmx fragment returning just the kanban
  // columns. The board page polls this every 10s so ticket movements appear
  // without F5. Same pattern as the comment-thread auto-refresh.
  app.get<{ Params: { id: string } }>('/ui/projects/:id/board-partial', async (request, reply) => {
    const { id } = uuidParam.parse(request.params);
    const project = getProject(db, id);
    if (!project) return reply.status(404).send('Project not found');

    const columns = db
      .prepare(
        `SELECT column_id, name, agent_type_id, "order"
         FROM project_type_columns WHERE project_type_id = ? ORDER BY "order"`,
      )
      .all(project.project_type_id) as Array<{
        column_id: string; name: string; agent_type_id: string | null; order: number;
      }>;

    const tickets = db
      .prepare(
        `SELECT id, title, priority, "column", claimed_by_run_id, sequence_number, updated_at
         FROM tickets WHERE project_id = ? ORDER BY created_at`,
      )
      .all(project.id) as Array<{
        id: string; title: string; priority: string; column: string;
        claimed_by_run_id: string | null; sequence_number: number; updated_at: number;
      }>;

    const ticketsByColumn = new Map<string, typeof tickets>();
    for (const col of columns) ticketsByColumn.set(col.column_id, []);
    for (const t of tickets) ticketsByColumn.get(t.column)?.push(t);

    const ticketStatuses = getTicketStatuses(db, id);
    const boardColumns = columns.map((col) => ({
      ...col,
      isAgent: col.agent_type_id !== null,
      isDone: col.column_id === 'done',
      isHuman: col.column_id === 'human',
      tickets: (ticketsByColumn.get(col.column_id) ?? []).map((t) => ({
        ...t,
        displayId: formatTicketDisplayId(project.abbreviation, t.sequence_number),
        isClaimed: t.claimed_by_run_id !== null,
        statusColor: ticketStatuses.get(t.id) ?? 'gray',
      })),
    }));

    return reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(deps.boardColumnsTemplate({ columns: boardColumns }));
  });

  // GET /ui/projects/:id/settings — edit project metadata (name, path, abbreviation).
  // Workflow columns + agents are edited via /ui/projects/:id/workflow.
  // (Ticket #951cacc2.)
  app.get<{ Params: { id: string } }>('/ui/projects/:id/settings', async (request, reply) => {
    const { id } = uuidParam.parse(request.params);
    const project = getProject(db, id);
    if (!project) return reply.status(404).send('Project not found');

    // Resolve the project_type display name so the read-only field
    // shows something meaningful instead of a UUID. (Review M-2.)
    const ptRow = db
      .prepare('SELECT name FROM project_types WHERE id = ?')
      .get(project.project_type_id) as { name: string } | undefined;
    const projectTypeName = ptRow?.name ?? project.project_type_id;

    return reply.view('project-settings.hbs', {
      activePage: 'projects',
      pageTitle: `${project.name} — Settings`,
      inboxCount: getInboxCount(db) || undefined,
      breadcrumbs: [
        { label: 'Projects', href: '/ui/projects' },
        { label: project.name, href: `/ui/projects/${project.id}` },
        { label: 'Settings', href: `/ui/projects/${project.id}/settings` },
      ],
      project,
      projectTypeName,
    });
  });

  // GET /ui/projects/:id/agents/:agentId/edit — project-scoped agent edit.
  //
  // Same form as /ui/agent-types/:id but renders under project context:
  // breadcrumbs walk back through the project + workflow editor, the
  // left-nav highlight stays on Projects, and Save redirects back to
  // the workflow page (so the Customize → Edit button transition is
  // visible without manual reload).
  //
  // Security: only agents owned by THIS project are editable through
  // this route. Library agents (owner_project_id IS NULL) and agents
  // owned by other projects return 404. Editing library agents must
  // go through /ui/agent-types/:id (a deliberate, library-only flow).
  app.get<{ Params: { id: string; agentId: string } }>(
    '/ui/projects/:id/agents/:agentId/edit',
    async (request, reply) => {
      const params = z
        .object({
          id: z.string().uuid(),
          agentId: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
        })
        .parse(request.params);

      const project = getProject(db, params.id);
      if (!project) return reply.status(404).send('Project not found');

      const agent = getAgentType(db, params.agentId);
      if (!agent || agent.owner_project_id !== project.id) {
        return reply.status(404).send('Agent not found in this project');
      }

      let promptText = '';
      try {
        const path = resolvePromptPath(agent.system_prompt_path);
        promptText = await readFile(path, 'utf8');
      } catch {
        // Missing prompt file → empty editor; user can write fresh content.
      }

      const tools = (() => {
        try { return JSON.parse(agent.allowed_tools) as string[]; }
        catch { return []; }
      })();

      return reply.view('agent-type-detail.hbs', {
        activePage: 'projects',
        pageTitle: `${project.name} — ${agent.name}`,
        inboxCount: getInboxCount(db) || undefined,
        breadcrumbs: [
          { label: 'Projects', href: '/ui/projects' },
          { label: project.name, href: `/ui/projects/${project.id}` },
          { label: 'Workflow', href: `/ui/projects/${project.id}/workflow` },
          { label: agent.name, href: `/ui/projects/${project.id}/agents/${agent.id}/edit` },
        ],
        agentType: agent,
        promptText,
        tools,
        // After save, return user to the workflow editor so Customize → Edit
        // transition is visible without a manual reload.
        saveRedirectUrl: `/ui/projects/${project.id}/workflow`,
      });
    },
  );
}
