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
