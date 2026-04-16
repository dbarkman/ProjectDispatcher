import { readFile } from 'node:fs/promises';
import type { Database } from 'better-sqlite3';
import { resolvePromptPath } from './prompt-file.js';

interface PromptBuildInput {
  agentTypeId: string;
  projectId: string;
  ticketId: string;
  runId: string;
  db: Database;
}

interface AgentTypeRow {
  id: string;
  name: string;
  system_prompt_path: string;
}

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  project_type_id: string;
}

interface TicketRow {
  id: string;
  title: string;
  column: string;
}

interface ProjectTypeColumnRow {
  column_id: string;
  name: string;
  agent_type_id: string | null;
  order: number;
}

/**
 * Assemble the full system prompt for an agent run.
 *
 * Structure (from DESIGN.md §11.2):
 *   1. Role prefix
 *   2. Agent type prompt body (read from ~/Development/.tasks/prompts/)
 *   3. Project context (CWD, CLAUDE.md hint)
 *   4. Ticket context (ticket ID, current column, run ID)
 *   5. Output instructions (how to move tickets, how to block)
 *   6. Workflow hint (next column for this project type)
 *
 * Returns the full prompt as a single string. Deterministic for the
 * same inputs (no randomness, no timestamps in the prompt itself).
 */
export async function buildPrompt(input: PromptBuildInput): Promise<string> {
  const { agentTypeId, projectId, ticketId, runId, db } = input;

  // Load the three DB rows we need
  const agentType = db
    .prepare('SELECT id, name, system_prompt_path FROM agent_types WHERE id = ?')
    .get(agentTypeId) as AgentTypeRow | undefined;
  if (!agentType) throw new Error(`Agent type not found: ${agentTypeId}`);

  const project = db
    .prepare('SELECT id, name, path, project_type_id FROM projects WHERE id = ?')
    .get(projectId) as ProjectRow | undefined;
  if (!project) throw new Error(`Project not found: ${projectId}`);

  const ticket = db
    .prepare('SELECT id, title, "column" FROM tickets WHERE id = ?')
    .get(ticketId) as TicketRow | undefined;
  if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);

  // Read the agent's system prompt file
  let promptBody: string;
  try {
    const promptPath = resolvePromptPath(agentType.system_prompt_path);
    promptBody = await readFile(promptPath, 'utf8');
  } catch {
    promptBody = `You are a ${agentType.name}. No system prompt file was found at ${agentType.system_prompt_path}.`;
  }

  // Figure out the workflow — what columns come after the current one?
  const columns = db
    .prepare(
      `SELECT column_id, name, agent_type_id, "order"
       FROM project_type_columns
       WHERE project_type_id = ?
       ORDER BY "order"`,
    )
    .all(project.project_type_id) as ProjectTypeColumnRow[];

  const currentIdx = columns.findIndex((c) => c.column_id === ticket.column);
  const nextColumn = currentIdx >= 0 && currentIdx < columns.length - 1
    ? columns[currentIdx + 1]
    : null;

  // Build the prompt
  const sections: string[] = [];

  // 1. Role prefix
  sections.push(`You are a ${agentType.name} working on project "${project.name}".`);
  sections.push('');

  // 2. Agent type prompt body
  sections.push(promptBody.trim());
  sections.push('');

  // 3. Project context
  sections.push('## Project Context');
  sections.push(`Your current working directory is: ${project.path}`);
  sections.push('Read CLAUDE.md first if it exists — it is the authoritative guide to this project.');
  sections.push('');

  // 4. Ticket context
  sections.push('## Your Assignment');
  sections.push(`You have been assigned a ticket.`);
  sections.push(`- Ticket title: "${ticket.title}"`);
  sections.push(`- Ticket ID: ${ticket.id}`);
  sections.push(`- Current column: ${ticket.column}`);
  sections.push(`- Run ID: ${runId}`);
  sections.push('');

  // 5. Ticket CLI — how agents interact with tickets (replaces MCP)
  sections.push('## Ticket CLI');
  sections.push('Use the ticket CLI via Bash to read your ticket, add comments, and move it when done.');
  sections.push('The CLI is a Node.js script. All env vars are pre-set — just run the commands.');
  sections.push('');
  sections.push('```bash');
  sections.push('# Read your ticket (full details + comment thread):');
  sections.push(`node $DISPATCH_TICKET_BIN read ${ticket.id}`);
  sections.push('');
  sections.push('# Add a comment (types: comment, journal, block, finding, complete):');
  sections.push(`node $DISPATCH_TICKET_BIN comment ${ticket.id} journal "your message here"`);
  sections.push('');
  sections.push('# Attach a code review finding:');
  sections.push(`node $DISPATCH_TICKET_BIN finding ${ticket.id} medium "Title" "Description with file:line refs"`);
  sections.push('');
  sections.push('# Move ticket to next column when done:');
  if (nextColumn) {
    sections.push(`node $DISPATCH_TICKET_BIN move ${ticket.id} ${nextColumn.column_id} "Summary of what you did"`);
  } else {
    sections.push(`node $DISPATCH_TICKET_BIN move ${ticket.id} <column> "Summary of what you did"`);
  }
  sections.push('');
  sections.push('# Move to human if blocked:');
  sections.push(`node $DISPATCH_TICKET_BIN move ${ticket.id} human "Blocked: reason here"`);
  sections.push('```');
  sections.push('');
  sections.push('**Read your ticket first** — it has the full description and any prior comments from other agents.');
  sections.push('');

  // 6. Output instructions
  sections.push('## When You Are Done');
  if (nextColumn) {
    sections.push(
      `Move the ticket to \`${nextColumn.column_id}\` ("${nextColumn.name}") with a summary comment.`,
    );
  } else {
    sections.push(
      'Move the ticket to the appropriate next column with a summary comment.',
    );
  }
  sections.push(
    'If you are blocked and cannot proceed, move the ticket to `human` with a clear, specific question. Do not leave the ticket sitting in your column.',
  );
  sections.push('');

  // 6. Workflow hint
  if (columns.length > 0) {
    const workflowStr = columns
      .map((c) => (c.column_id === ticket.column ? `[${c.name}]` : c.name))
      .join(' → ');
    sections.push(`Workflow: ${workflowStr}`);
  }

  return sections.join('\n');
}
