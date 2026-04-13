import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { listAgentRuns, getAgentRun } from '../../db/queries/agent-runs.js';
import { readTranscript } from '../../services/transcript.js';

const uuidParam = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  ticket_id: z.string().uuid().optional(),
  agent_type_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function agentRunRoutes(app: FastifyInstance, db: Database): Promise<void> {
  // GET /api/agent-runs — list recent runs (filterable)
  app.get('/api/agent-runs', async (request) => {
    const query = listQuery.parse(request.query);
    return listAgentRuns(db, {
      ticketId: query.ticket_id,
      agentTypeId: query.agent_type_id,
      limit: query.limit,
    });
  });

  // GET /api/agent-runs/:id — run detail
  app.get<{ Params: { id: string } }>('/api/agent-runs/:id', async (request, reply) => {
    const { id } = uuidParam.parse(request.params);
    const run = getAgentRun(db, id);
    if (!run) return reply.status(404).send({ error: 'Agent run not found' });
    return run;
  });

  // GET /api/agent-runs/:id/transcript — raw transcript text
  app.get<{ Params: { id: string } }>('/api/agent-runs/:id/transcript', async (request, reply) => {
    const { id } = uuidParam.parse(request.params);
    const run = getAgentRun(db, id);
    if (!run) return reply.status(404).send({ error: 'Agent run not found' });
    if (!run.transcript_path) return reply.status(404).send({ error: 'No transcript available' });

    try {
      const text = await readTranscript(id);
      return reply.type('text/plain').send(text);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reply.status(404).send({ error: 'Transcript file not found' });
      }
      throw err;
    }
  });
}
