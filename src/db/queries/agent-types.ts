import type { Database } from 'better-sqlite3';

export interface AgentType {
  id: string;
  name: string;
  description: string | null;
  system_prompt_path: string;
  model: string;
  allowed_tools: string; // JSON array
  permission_mode: string;
  timeout_minutes: number;
  max_retries: number;
  is_builtin: number;
  created_at: number;
  updated_at: number;
}

export interface CreateAgentTypeData {
  id: string;
  name: string;
  description?: string;
  systemPromptPath: string;
  model: string;
  allowedTools: string[];
  permissionMode: string;
  timeoutMinutes?: number;
  maxRetries?: number;
}

export interface UpdateAgentTypeData {
  name?: string;
  description?: string;
  model?: string;
  allowedTools?: string[];
  permissionMode?: string;
  timeoutMinutes?: number;
  maxRetries?: number;
}

export function listAgentTypes(db: Database): AgentType[] {
  return db.prepare('SELECT * FROM agent_types ORDER BY name').all() as AgentType[];
}

export function getAgentType(db: Database, id: string): AgentType | null {
  return (
    (db.prepare('SELECT * FROM agent_types WHERE id = ?').get(id) as AgentType | undefined) ?? null
  );
}

export function createAgentType(db: Database, data: CreateAgentTypeData): AgentType {
  const now = Date.now();
  db.prepare(
    `INSERT INTO agent_types (
      id, name, description, system_prompt_path, model, allowed_tools,
      permission_mode, timeout_minutes, max_retries, is_builtin, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).run(
    data.id,
    data.name,
    data.description ?? null,
    data.systemPromptPath,
    data.model,
    JSON.stringify(data.allowedTools),
    data.permissionMode,
    data.timeoutMinutes ?? 30,
    data.maxRetries ?? 0,
    now,
    now,
  );
  return getAgentType(db, data.id)!;
}

export function updateAgentType(
  db: Database,
  id: string,
  data: UpdateAgentTypeData,
): AgentType | null {
  const existing = getAgentType(db, id);
  if (!existing) return null;

  const now = Date.now();
  const fields: string[] = ['updated_at = ?'];
  const values: unknown[] = [now];

  if (data.name !== undefined) {
    fields.push('name = ?');
    values.push(data.name);
  }
  if (data.description !== undefined) {
    fields.push('description = ?');
    values.push(data.description);
  }
  if (data.model !== undefined) {
    fields.push('model = ?');
    values.push(data.model);
  }
  if (data.allowedTools !== undefined) {
    fields.push('allowed_tools = ?');
    values.push(JSON.stringify(data.allowedTools));
  }
  if (data.permissionMode !== undefined) {
    fields.push('permission_mode = ?');
    values.push(data.permissionMode);
  }
  if (data.timeoutMinutes !== undefined) {
    fields.push('timeout_minutes = ?');
    values.push(data.timeoutMinutes);
  }
  if (data.maxRetries !== undefined) {
    fields.push('max_retries = ?');
    values.push(data.maxRetries);
  }

  values.push(id);
  db.prepare(`UPDATE agent_types SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  return getAgentType(db, id);
}

export function deleteAgentType(db: Database, id: string): { deleted: boolean; reason?: string } {
  const at = db.prepare('SELECT is_builtin FROM agent_types WHERE id = ?').get(id) as
    | { is_builtin: number }
    | undefined;
  if (!at) return { deleted: false, reason: 'not_found' };
  if (at.is_builtin === 1) return { deleted: false, reason: 'is_builtin' };

  // Check if any project type columns reference this agent type
  const inUse = db
    .prepare('SELECT COUNT(*) AS c FROM project_type_columns WHERE agent_type_id = ?')
    .get(id) as { c: number };
  if (inUse.c > 0) return { deleted: false, reason: 'in_use' };

  db.prepare('DELETE FROM agent_types WHERE id = ?').run(id);
  return { deleted: true };
}
