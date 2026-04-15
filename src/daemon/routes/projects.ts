import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import type { Scheduler } from '../scheduler.js';
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  archiveProject,
  wakeProject,
  AbbreviationConflictError,
} from '../../db/queries/projects.js';
import {
  cloneProjectType,
  createEmptyProjectType,
  describeProjectWorkflowState,
  getProjectTypeForProject,
  setProjectTypeOwner,
  updateProjectType,
} from '../../db/queries/project-types.js';
import {
  cloneAgentTypeForProject,
  getAgentType,
} from '../../db/queries/agent-types.js';
import {
  readPromptFileByName,
  writePromptFile,
} from '../../services/prompt-file.js';
import { z } from 'zod';
import {
  createProjectBody,
  updateProjectBody,
  updateProjectWorkflowBody,
  listProjectsQuery,
  idParam,
} from '../schemas.js';

export async function projectRoutes(app: FastifyInstance, db: Database, scheduler?: Scheduler): Promise<void> {
  // GET /api/projects — list (filterable by status)
  app.get('/api/projects', async (request) => {
    const query = listProjectsQuery.parse(request.query);
    return listProjects(db, query.status ? { status: query.status } : undefined);
  });

  // GET /api/projects/:id — detail with heartbeat state
  app.get<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const project = getProject(db, id);
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }
    return project;
  });

  // POST /api/projects — register a new project.
  //
  // Project types are *templates*. On registration we clone the chosen template
  // (and its columns) into a fresh project-scoped project_type, then point the
  // new project at that copy. Editing the project's workflow later never
  // touches the library template or any other project. A special 'blank'
  // template id creates an empty workflow the user fills in themselves.
  app.post('/api/projects', async (request, reply) => {
    const body = createProjectBody.parse(request.body);

    // Resolve the template. 'blank' bypasses the library lookup entirely.
    if (body.project_type_id !== 'blank') {
      const tpl = db
        .prepare(
          // Only library templates (owner_project_id IS NULL) can be used at registration.
          // Project-scoped copies of other projects must not be reusable here.
          'SELECT 1 FROM project_types WHERE id = ? AND owner_project_id IS NULL',
        )
        .get(body.project_type_id);
      if (!tpl) {
        return reply
          .status(400)
          .send({ error: `Unknown template: ${body.project_type_id}` });
      }
    }

    // Pre-check: only an *active* project claims a path. Archived rows
    // don't, so the same folder can be re-registered after archive. The
    // partial unique index on projects.path is the authoritative enforcement;
    // this pre-check exists to return a clean 409 with a useful error
    // message instead of surfacing a raw SQLite UNIQUE violation as 500.
    const pathExists = db
      .prepare("SELECT 1 FROM projects WHERE path = ? AND status != 'archived'")
      .get(body.path);
    if (pathExists) {
      return reply.status(409).send({ error: `Path already registered: ${body.path}` });
    }

    // Registration in one transaction:
    //   1. Clone (or create blank) the project_type with owner_project_id=NULL.
    //      Has to come first because the project row FK-references a valid
    //      project_type id.
    //   2. Create the project pointing at that new type.
    //   3. Reparent the project_type to the new project via UPDATE.
    //
    // If any step fails the whole transaction rolls back — no orphaned types,
    // no half-created projects.
    const result = db.transaction(() => {
      const scopedType =
        body.project_type_id === 'blank'
          ? createEmptyProjectType(db, body.name, null)
          : cloneProjectType(db, body.project_type_id, null);

      const project = createProject(db, {
        name: body.name,
        path: body.path,
        abbreviation: body.abbreviation,
        projectTypeId: scopedType.id,
      });

      setProjectTypeOwner(db, scopedType.id, project.id);

      return project;
    })();

    return reply.status(201).send(getProject(db, result.id));
  });

  // GET /api/projects/:id/workflow — columns + agent assignments for the project.
  app.get<{ Params: { id: string } }>('/api/projects/:id/workflow', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const project = getProject(db, id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const state = describeProjectWorkflowState(db, project);
    if (state === 'broken') {
      return reply
        .status(500)
        .send({ error: 'Project workflow state is inconsistent. Contact an admin.' });
    }
    const workflow = getProjectTypeForProject(db, id);
    // state==='scoped' guarantees getProjectTypeForProject returns a row.
    return workflow;
  });

  // PUT /api/projects/:id/workflow — replace the project's column list.
  // Validates that no ticket lives in a column that's being removed.
  app.put<{ Params: { id: string } }>('/api/projects/:id/workflow', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = updateProjectWorkflowBody.parse(request.body);
    const project = getProject(db, id);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    const state = describeProjectWorkflowState(db, project);
    if (state === 'broken') {
      return reply
        .status(500)
        .send({ error: 'Project workflow state is inconsistent. Contact an admin.' });
    }
    const workflow = getProjectTypeForProject(db, id)!;

    // Refuse to remove any column that still holds tickets. Prevents
    // orphaned tickets pinned to a non-existent column.
    const incomingIds = new Set(body.columns.map((c) => c.column_id));
    const removedIds = workflow.columns
      .map((c) => c.column_id)
      .filter((id) => !incomingIds.has(id));
    if (removedIds.length > 0) {
      const placeholders = removedIds.map(() => '?').join(',');
      const orphaned = db
        .prepare(
          `SELECT "column", COUNT(*) AS c FROM tickets
           WHERE project_id = ? AND "column" IN (${placeholders})
           GROUP BY "column"`,
        )
        .all(project.id, ...removedIds) as Array<{ column: string; c: number }>;
      if (orphaned.length > 0) {
        return reply.status(409).send({
          error: 'Cannot remove columns that still hold tickets',
          columns: orphaned,
        });
      }
    }

    // Verify every referenced agent_type exists and is either library or
    // owned by this project — single query (was N+1 per review M-01).
    const referencedAgentIds = [
      ...new Set(
        body.columns
          .map((c) => c.agent_type_id)
          .filter((v): v is string => typeof v === 'string' && v.length > 0),
      ),
    ];
    if (referencedAgentIds.length > 0) {
      const placeholders = referencedAgentIds.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT id FROM agent_types
           WHERE id IN (${placeholders})
             AND (owner_project_id IS NULL OR owner_project_id = ?)`,
        )
        .all(...referencedAgentIds, project.id) as Array<{ id: string }>;
      const foundIds = new Set(rows.map((r) => r.id));
      const invalid = referencedAgentIds.filter((id) => !foundIds.has(id));
      if (invalid.length > 0) {
        return reply.status(400).send({
          error: `Unknown or out-of-scope agent: ${invalid[0]}`,
          invalid,
        });
      }
    }

    const updated = updateProjectType(db, workflow.id, { columns: body.columns });
    return updated;
  });

  // PATCH /api/projects/:id — update
  app.patch<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = updateProjectBody.parse(request.body);

    if (body.project_type_id) {
      // Defense-in-depth: a project can only repoint at a library template
      // (owner_project_id IS NULL) or its own existing scoped type. Prevents
      // pointing at another project's private type. (Review M-03.)
      const target = db
        .prepare(
          `SELECT owner_project_id FROM project_types
           WHERE id = ? AND (owner_project_id IS NULL OR owner_project_id = ?)`,
        )
        .get(body.project_type_id, id);
      if (!target) {
        return reply
          .status(400)
          .send({ error: `Unknown or out-of-scope project type: ${body.project_type_id}` });
      }
    }

    let updated;
    try {
      updated = updateProject(db, id, {
        name: body.name,
        projectTypeId: body.project_type_id,
        status: body.status,
        abbreviation: body.abbreviation,
      });
    } catch (err) {
      if (err instanceof AbbreviationConflictError) {
        return reply.status(409).send({
          error: `Abbreviation '${err.requested}' is already in use by another active project`,
        });
      }
      throw err;
    }
    if (!updated) {
      return reply.status(404).send({ error: 'Project not found' });
    }
    return updated;
  });

  // DELETE /api/projects/:id — archive (not hard delete)
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const archived = archiveProject(db, id);
    if (!archived) {
      return reply.status(404).send({ error: 'Project not found' });
    }
    return { status: 'archived' };
  });

  // POST /api/projects/:id/agents/fork — fork a library agent_type into a
  // project-scoped copy. The fork starts with identical prompt, model, and
  // tools; editing the fork never affects the library. If a column_id is
  // supplied, that column is also rebound to the fork in the same transaction.
  //
  // The fork gets its own prompt file (<fork-uuid>.md) copied from the library
  // agent's file, so subsequent prompt edits are isolated.
  app.post<{ Params: { id: string } }>(
    '/api/projects/:id/agents/fork',
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({
        // Same charset constraint as other agent_type_id references — length
        // bounded so obvious junk is rejected cheaply before any DB lookup.
        agent_type_id: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
        column_id: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/).optional(),
      }).parse(request.body);

      const project = getProject(db, id);
      if (!project) return reply.status(404).send({ error: 'Project not found' });

      const libAgent = getAgentType(db, body.agent_type_id);
      if (!libAgent || libAgent.owner_project_id !== null) {
        return reply.status(400).send({
          error: 'Can only fork library agents (built-in or user-created with no owner)',
        });
      }

      // Read the library prompt from its *actual* stored path — not
      // `${id}.md`, which was coincidentally right for built-ins but wrong
      // for any user-created library agent whose prompt file doesn't match
      // the slug convention. (Review #N1 C-1 / security M-01.)
      //
      // ENOENT is treated as "blank prompt" so a library agent with no
      // prompt file still clones gracefully; any other error aborts the
      // fork before we touch the DB.
      let promptContent = '';
      try {
        promptContent = await readPromptFileByName(libAgent.system_prompt_path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          request.log.error({ err }, 'Failed to read library prompt during fork');
          return reply.status(500).send({ error: 'Failed to read library prompt' });
        }
      }

      // Step 1: DB clone + optional column rebind, in one transaction.
      // Snapshot the column's prior agent_type_id BEFORE we rebind, so the
      // rollback path (step 2) can restore it. Without this, the FK from
      // project_type_columns.agent_type_id → agent_types.id (no ON DELETE
      // clause = NO ACTION in SQLite) would block the rollback DELETE,
      // leaving an orphan agent row referenced by the column. (Review #N2 L-03.)
      const clone = db.transaction(() => {
        const workflow = getProjectTypeForProject(db, id);
        const result = cloneAgentTypeForProject(db, body.agent_type_id, project.id);
        let priorColumnAgentId: string | null = null;
        let rebound = false;
        if (body.column_id && workflow) {
          const col = workflow.columns.find((c) => c.column_id === body.column_id);
          if (col) {
            priorColumnAgentId = col.agent_type_id;
            db.prepare(
              `UPDATE project_type_columns SET agent_type_id = ?
               WHERE project_type_id = ? AND column_id = ?`,
            ).run(result.agent.id, workflow.id, body.column_id);
            rebound = true;
          }
        }
        return { ...result, priorColumnAgentId, rebound, workflowId: workflow?.id ?? null };
      })();

      // Step 2: write the fork's prompt file. If this fails, roll back the
      // DB clone so the user doesn't end up with a visible-but-broken fork.
      // The rollback must restore the column's prior agent_type_id first,
      // otherwise the FK blocks the agent row delete. (Review #N1 H-1 /
      // security L-02 / Review #N2 L-03.)
      try {
        await writePromptFile(clone.agent.id, promptContent);
      } catch (err) {
        request.log.error({ err }, 'Fork prompt file write failed; rolling back DB clone');
        try {
          db.transaction(() => {
            if (clone.rebound && body.column_id && clone.workflowId) {
              db.prepare(
                `UPDATE project_type_columns SET agent_type_id = ?
                 WHERE project_type_id = ? AND column_id = ?`,
              ).run(clone.priorColumnAgentId, clone.workflowId, body.column_id);
            }
            db.prepare('DELETE FROM agent_types WHERE id = ?').run(clone.agent.id);
          })();
        } catch (rollbackErr) {
          // Rollback itself failed — log loudly; operator will have to clean up
          // manually. We still return 500 to the user; a second, compounding
          // error doesn't change the outcome. (Fail-loud principle.)
          request.log.error(
            { rollbackErr, forkAgentId: clone.agent.id },
            'Fork rollback failed — orphan agent row may remain',
          );
        }
        return reply.status(500).send({ error: 'Failed to write fork prompt file' });
      }

      return reply.status(201).send({
        forked_agent_type_id: clone.agent.id,
        column_id: body.column_id,
      });
    },
  );

  // POST /api/projects/:id/wake — manually reset heartbeat
  app.post<{ Params: { id: string } }>('/api/projects/:id/wake', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const project = getProject(db, id);
    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }
    wakeProject(db, id);
    // Also reschedule the scheduler's in-memory timer so the heartbeat
    // fires at the new next_check_at, not the old one. (Gap fix #2)
    scheduler?.resetProject(id);
    return { status: 'heartbeat_reset' };
  });
}
