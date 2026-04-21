// Seed data for built-in project types, agent types, and project type columns.
//
// Idempotency strategy: pre-check existence by primary key / UNIQUE tuple,
// then INSERT without OR IGNORE. Rationale: OR IGNORE silently swallows
// CHECK failures, which would mask typos in this seed file. The pre-check +
// explicit insert pattern means:
//   - Re-running the seed is a no-op (rows already exist → skip)
//   - User edits to built-in rows are preserved (row exists → skip, no UPDATE)
//   - Typos in the seed data fail loud at insert time via the CHECK
//     constraints we added in 001_init.sql (allowed_tools JSON validity,
//     permission_mode enum, etc.)
//
// Everything runs inside a single db.transaction() so partial failures
// leave no partial state behind.

import type { Database } from 'better-sqlite3';
import type { ClaudeModel } from '../types.js';

// ClaudeModel moved to ../types.ts so the config loader can reference the
// same closed set — single source of truth for "models agents may run as."

type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';

interface ProjectTypeSeed {
  id: string;
  name: string;
  description: string;
}

interface AgentTypeSeed {
  id: string;
  name: string;
  description: string;
  systemPromptPath: string; // filename inside ~/Development/.tasks/prompts/
  model: ClaudeModel;
  allowedTools: string[]; // JSON-encoded at insert time
  permissionMode: PermissionMode;
  timeoutMinutes: number;
  maxRetries?: number;
}

interface ProjectTypeColumnSeed {
  projectTypeId: string;
  columnId: string;
  name: string;
  agentTypeId: string | null;
  order: number;
}

const PROJECT_TYPES: ProjectTypeSeed[] = [
  {
    id: 'software-dev',
    name: 'Software Dev',
    description: 'Standard software development project with code, reviews, and security audit.',
  },
  {
    id: 'vps-maintenance',
    name: 'VPS Maintenance',
    description: 'Server and infrastructure maintenance with operations and auditing.',
  },
  {
    id: 'content',
    name: 'Content',
    description: 'Writing and editorial workflow for blog posts, documentation, marketing copy.',
  },
  {
    id: 'research',
    name: 'Research',
    description: 'Information gathering and summarization.',
  },
  {
    id: 'personal',
    name: 'Personal',
    description: 'No agents — just a personal ticket tracker.',
  },
];

const AGENT_TYPES: AgentTypeSeed[] = [
  {
    id: 'coding-agent',
    name: 'Coding Agent',
    description: 'Writes and modifies code. The primary worker for software-dev projects.',
    systemPromptPath: 'coding-agent.md',
    model: 'claude-opus-4-7',
    allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'Task'],
    permissionMode: 'bypassPermissions',
    timeoutMinutes: 60,
  },
  {
    id: 'code-reviewer',
    name: 'Code Reviewer',
    description: 'Reviews code quality, architecture, correctness. Does not write code.',
    systemPromptPath: 'code-reviewer.md',
    model: 'claude-opus-4-7',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    permissionMode: 'default',
    timeoutMinutes: 30,
  },
  {
    id: 'security-reviewer',
    name: 'Security Reviewer',
    description:
      'Reviews code for security vulnerabilities and server config changes for hardening regressions.',
    systemPromptPath: 'security-reviewer.md',
    model: 'claude-opus-4-7',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    permissionMode: 'default',
    timeoutMinutes: 45,
  },
  {
    id: 'sysadmin',
    name: 'Sysadmin',
    description: 'Executes server administration tasks. Runs commands, makes config changes, deploys.',
    systemPromptPath: 'sysadmin.md',
    model: 'claude-sonnet-4-6',
    allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
    permissionMode: 'bypassPermissions',
    timeoutMinutes: 45,
  },
  {
    id: 'security-auditor',
    name: 'Security Auditor',
    description: 'Audits server state for hardening, CVEs, misconfigurations. Read-heavy.',
    systemPromptPath: 'security-auditor.md',
    model: 'claude-sonnet-4-6',
    allowedTools: ['Read', 'Grep', 'Bash'],
    permissionMode: 'default',
    timeoutMinutes: 30,
  },
  {
    id: 'writer',
    name: 'Writer',
    description: 'Drafts long-form content — blog posts, docs, marketing copy.',
    systemPromptPath: 'writer.md',
    model: 'claude-sonnet-4-6',
    allowedTools: ['Read', 'Write', 'WebFetch'],
    permissionMode: 'acceptEdits',
    timeoutMinutes: 30,
  },
  {
    id: 'editor',
    name: 'Editor',
    description: 'Edits, proofreads, improves drafts.',
    systemPromptPath: 'editor.md',
    model: 'claude-sonnet-4-6',
    allowedTools: ['Read', 'Edit', 'WebFetch'],
    permissionMode: 'acceptEdits',
    timeoutMinutes: 30,
  },
  {
    id: 'deployer',
    name: 'Deployer',
    description: 'Executes deployments. Runs CI, monitors health checks, rolls back on failure.',
    systemPromptPath: 'deployer.md',
    model: 'claude-sonnet-4-6',
    allowedTools: ['Bash', 'Read', 'Grep'],
    permissionMode: 'bypassPermissions',
    timeoutMinutes: 30,
  },
  {
    id: 'researcher',
    name: 'Researcher',
    description: 'Gathers information, summarizes findings. No writing beyond summary documents.',
    systemPromptPath: 'researcher.md',
    model: 'claude-haiku-4-5-20251001',
    allowedTools: ['Read', 'Write', 'WebFetch', 'WebSearch'],
    permissionMode: 'acceptEdits',
    timeoutMinutes: 20,
  },
  {
    id: 'merge-agent',
    name: 'Merge Agent',
    description: 'Handles git merges and simple conflict resolution for completed tickets.',
    systemPromptPath: 'merge-agent.md',
    model: 'claude-opus-4-7',
    allowedTools: ['Bash', 'Read', 'Edit', 'Grep'],
    permissionMode: 'acceptEdits',
    timeoutMinutes: 10,
    maxRetries: 2,
  },
];

const PROJECT_TYPE_COLUMNS: ProjectTypeColumnSeed[] = [
  // software-dev: human → coding-agent → code-reviewer → security-reviewer → merging → done
  { projectTypeId: 'software-dev', columnId: 'human', name: 'Human', agentTypeId: null, order: 0 },
  {
    projectTypeId: 'software-dev',
    columnId: 'coding-agent',
    name: 'Coding Agent',
    agentTypeId: 'coding-agent',
    order: 1,
  },
  {
    projectTypeId: 'software-dev',
    columnId: 'code-reviewer',
    name: 'Code Review',
    agentTypeId: 'code-reviewer',
    order: 2,
  },
  {
    projectTypeId: 'software-dev',
    columnId: 'security-reviewer',
    name: 'Security Review',
    agentTypeId: 'security-reviewer',
    order: 3,
  },
  {
    projectTypeId: 'software-dev',
    columnId: 'merging',
    name: 'Merging',
    agentTypeId: 'merge-agent',
    order: 4,
  },
  { projectTypeId: 'software-dev', columnId: 'done', name: 'Done', agentTypeId: null, order: 5 },

  // vps-maintenance: human → sysadmin → security-auditor → merging → done
  { projectTypeId: 'vps-maintenance', columnId: 'human', name: 'Human', agentTypeId: null, order: 0 },
  {
    projectTypeId: 'vps-maintenance',
    columnId: 'sysadmin',
    name: 'Sysadmin',
    agentTypeId: 'sysadmin',
    order: 1,
  },
  {
    projectTypeId: 'vps-maintenance',
    columnId: 'security-auditor',
    name: 'Security Audit',
    agentTypeId: 'security-auditor',
    order: 2,
  },
  {
    projectTypeId: 'vps-maintenance',
    columnId: 'merging',
    name: 'Merging',
    agentTypeId: 'merge-agent',
    order: 3,
  },
  { projectTypeId: 'vps-maintenance', columnId: 'done', name: 'Done', agentTypeId: null, order: 4 },

  // content: human → writer → editor → done
  { projectTypeId: 'content', columnId: 'human', name: 'Human', agentTypeId: null, order: 0 },
  { projectTypeId: 'content', columnId: 'writer', name: 'Writer', agentTypeId: 'writer', order: 1 },
  { projectTypeId: 'content', columnId: 'editor', name: 'Editor', agentTypeId: 'editor', order: 2 },
  { projectTypeId: 'content', columnId: 'done', name: 'Done', agentTypeId: null, order: 3 },

  // research: human → researcher → done
  { projectTypeId: 'research', columnId: 'human', name: 'Human', agentTypeId: null, order: 0 },
  {
    projectTypeId: 'research',
    columnId: 'researcher',
    name: 'Researcher',
    agentTypeId: 'researcher',
    order: 1,
  },
  { projectTypeId: 'research', columnId: 'done', name: 'Done', agentTypeId: null, order: 2 },

  // personal: backlog → in-progress → done (no agents)
  //
  // NOTE: this project type uses column_id='human' (not 'backlog') on purpose.
  // The unified-inbox query in the UI selects every ticket where column='human',
  // so personal tickets land in the same inbox as human-column tickets from the
  // other project types — no special-case routing. The display name 'Backlog' is
  // per-project-type, so the UI shows "Backlog" for personal and "Human" for the
  // other types even though the column_id matches. Do not rename this to
  // 'backlog' without also changing the inbox query and every other reference.
  { projectTypeId: 'personal', columnId: 'human', name: 'Backlog', agentTypeId: null, order: 0 },
  {
    projectTypeId: 'personal',
    columnId: 'in-progress',
    name: 'In Progress',
    agentTypeId: null,
    order: 1,
  },
  { projectTypeId: 'personal', columnId: 'done', name: 'Done', agentTypeId: null, order: 2 },
];

export interface SeedResult {
  projectTypesInserted: number;
  agentTypesInserted: number;
  projectTypeColumnsInserted: number;
}

/**
 * Insert the built-in project types, agent types, and their workflow columns
 * if they are not already present. Idempotent. Never updates existing rows,
 * so user edits to a built-in are preserved across re-seeds.
 *
 * Insert order matters: agent_types must land before project_type_columns
 * because the latter has a FK reference to the former.
 */
export function seedBuiltins(db: Database): SeedResult {
  const now = Date.now();
  let projectTypesInserted = 0;
  let agentTypesInserted = 0;
  let projectTypeColumnsInserted = 0;

  const ptExists = db.prepare('SELECT 1 FROM project_types WHERE id = ?');
  const ptInsert = db.prepare(
    `INSERT INTO project_types (id, name, description, is_builtin, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)`,
  );

  const atExists = db.prepare('SELECT 1 FROM agent_types WHERE id = ?');
  const atInsert = db.prepare(
    `INSERT INTO agent_types (
      id, name, description, system_prompt_path, model, allowed_tools,
      permission_mode, timeout_minutes, max_retries, is_builtin, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  );

  const ptcExists = db.prepare(
    'SELECT 1 FROM project_type_columns WHERE project_type_id = ? AND column_id = ?',
  );
  const ptcInsert = db.prepare(
    `INSERT INTO project_type_columns (project_type_id, column_id, name, agent_type_id, "order")
     VALUES (?, ?, ?, ?, ?)`,
  );

  const apply = db.transaction(() => {
    for (const pt of PROJECT_TYPES) {
      if (!ptExists.get(pt.id)) {
        ptInsert.run(pt.id, pt.name, pt.description, now, now);
        projectTypesInserted++;
      }
    }

    for (const at of AGENT_TYPES) {
      if (!atExists.get(at.id)) {
        atInsert.run(
          at.id,
          at.name,
          at.description,
          at.systemPromptPath,
          at.model,
          JSON.stringify(at.allowedTools),
          at.permissionMode,
          at.timeoutMinutes,
          at.maxRetries ?? 0,
          now,
          now,
        );
        agentTypesInserted++;
      }
    }

    for (const ptc of PROJECT_TYPE_COLUMNS) {
      if (!ptcExists.get(ptc.projectTypeId, ptc.columnId)) {
        ptcInsert.run(ptc.projectTypeId, ptc.columnId, ptc.name, ptc.agentTypeId, ptc.order);
        projectTypeColumnsInserted++;
      }
    }
  });

  apply();

  return { projectTypesInserted, agentTypesInserted, projectTypeColumnsInserted };
}
