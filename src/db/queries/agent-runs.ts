import type { Database } from 'better-sqlite3';

export interface AgentRun {
  id: string;
  ticket_id: string;
  agent_type_id: string;
  model: string;
  started_at: number;
  ended_at: number | null;
  exit_status: string | null;
  transcript_path: string | null;
  cost_estimate_cents: number | null;
  error_message: string | null;
}

export function listAgentRuns(
  db: Database,
  filter?: { ticketId?: string; agentTypeId?: string; limit?: number },
): AgentRun[] {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter?.ticketId) {
    conditions.push('ticket_id = ?');
    values.push(filter.ticketId);
  }
  if (filter?.agentTypeId) {
    conditions.push('agent_type_id = ?');
    values.push(filter.agentTypeId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filter?.limit ?? 50;

  return db
    .prepare(`SELECT * FROM agent_runs ${where} ORDER BY started_at DESC LIMIT ?`)
    .all(...values, limit) as AgentRun[];
}

export function getAgentRun(db: Database, id: string): AgentRun | null {
  return (
    (db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as AgentRun | undefined) ?? null
  );
}

export type TicketStatus = 'green' | 'red' | 'gray';

interface LatestRunRow {
  ticket_id: string;
  exit_status: string | null;
  ended_at: number | null;
}

interface LatestIssueRow {
  ticket_id: string;
  created_at: number;
}

export function getTicketStatuses(
  db: Database,
  projectId: string,
): Map<string, TicketStatus> {
  const latestRuns = db
    .prepare(
      `SELECT ar.ticket_id, ar.exit_status, ar.ended_at
       FROM agent_runs ar
       INNER JOIN (
         SELECT ticket_id, MAX(started_at) AS max_started
         FROM agent_runs
         WHERE ticket_id IN (SELECT id FROM tickets WHERE project_id = ?)
         GROUP BY ticket_id
       ) latest ON ar.ticket_id = latest.ticket_id AND ar.started_at = latest.max_started`,
    )
    .all(projectId) as LatestRunRow[];

  const latestIssues = db
    .prepare(
      `SELECT tc.ticket_id, MAX(tc.created_at) AS created_at
       FROM ticket_comments tc
       WHERE tc.ticket_id IN (SELECT id FROM tickets WHERE project_id = ?)
         AND tc.type IN ('finding', 'block')
       GROUP BY tc.ticket_id`,
    )
    .all(projectId) as LatestIssueRow[];

  const runMap = new Map<string, LatestRunRow>();
  for (const r of latestRuns) {
    runMap.set(r.ticket_id, r);
  }

  const issueMap = new Map<string, LatestIssueRow>();
  for (const i of latestIssues) {
    issueMap.set(i.ticket_id, i);
  }

  const result = new Map<string, TicketStatus>();

  const ticketIds = db
    .prepare('SELECT id FROM tickets WHERE project_id = ?')
    .all(projectId) as Array<{ id: string }>;

  for (const { id } of ticketIds) {
    const run = runMap.get(id);
    const issue = issueMap.get(id);

    if (!run && !issue) {
      result.set(id, 'gray');
      continue;
    }

    if (!run && issue) {
      result.set(id, 'red');
      continue;
    }

    if (run && !issue) {
      if (run.exit_status === 'success') {
        result.set(id, 'green');
      } else if (
        run.exit_status === 'crashed' ||
        run.exit_status === 'timeout' ||
        run.exit_status === 'blocked'
      ) {
        result.set(id, 'red');
      } else {
        result.set(id, 'gray');
      }
      continue;
    }

    // Both run and issue exist — most recent event wins
    const runTime = run!.ended_at ?? 0;
    const issueTime = issue!.created_at;

    if (issueTime > runTime) {
      result.set(id, 'red');
    } else if (run!.exit_status === 'success') {
      result.set(id, 'green');
    } else if (
      run!.exit_status === 'crashed' ||
      run!.exit_status === 'timeout' ||
      run!.exit_status === 'blocked'
    ) {
      result.set(id, 'red');
    } else {
      result.set(id, 'gray');
    }
  }

  return result;
}
