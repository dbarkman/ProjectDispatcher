// MVP-40: Unit tests for database query functions.
// Uses in-memory SQLite for isolation. Each test gets a fresh DB.

import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../../src/db/index.js';
import { runMigrations } from '../../../src/db/migrate.js';
import { seedBuiltins } from '../../../src/db/seed.js';
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  archiveProject,
  wakeProject,
} from '../../../src/db/queries/projects.js';
import {
  listProjectTypes,
  getProjectType,
} from '../../../src/db/queries/project-types.js';
import {
  listAgentTypes,
  getAgentType,
} from '../../../src/db/queries/agent-types.js';
import {
  createTicket,
  getTicket,
  getTicketWithComments,
  listTickets,
  updateTicket,
  deleteTicket,
  moveTicket,
  addComment,
} from '../../../src/db/queries/tickets.js';
import {
  createAttachment,
  listAttachments,
  getAttachment,
  deleteAttachment,
} from '../../../src/db/queries/attachments.js';
import { getTicketStatuses } from '../../../src/db/queries/agent-runs.js';

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
  seedBuiltins(db);
});

// --- Projects ---

describe('projects queries', () => {
  it('creates a project with heartbeat', () => {
    const p = createProject(db, { name: 'Test', path: '/tmp/test', projectTypeId: 'software-dev' });
    expect(p.name).toBe('Test');
    expect(p.status).toBe('active');
    expect(p.next_check_at).toBeGreaterThan(Date.now() - 1000);
  });

  it('lists active projects, excludes archived', () => {
    createProject(db, { name: 'A', path: '/a', projectTypeId: 'software-dev' });
    const b = createProject(db, { name: 'B', path: '/b', projectTypeId: 'research' });
    archiveProject(db, b.id);

    const list = listProjects(db);
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('A');
  });

  it('updates a project partially', () => {
    const p = createProject(db, { name: 'Old', path: '/old', projectTypeId: 'software-dev' });
    const updated = updateProject(db, p.id, { name: 'New' });
    expect(updated!.name).toBe('New');
    expect(updated!.project_type_id).toBe('software-dev'); // unchanged
  });

  it('wakes a project by resetting heartbeat', () => {
    const p = createProject(db, { name: 'W', path: '/w', projectTypeId: 'software-dev' });
    wakeProject(db, p.id);
    const after = getProject(db, p.id);
    expect(after!.consecutive_empty_checks).toBe(0);
    expect(after!.last_wake_at).toBeGreaterThan(0);
  });

  it('returns null for nonexistent project', () => {
    expect(getProject(db, 'nonexistent')).toBeNull();
  });
});

// --- Project Types ---

describe('project types queries', () => {
  it('lists seeded project types', () => {
    const types = listProjectTypes(db);
    expect(types.length).toBeGreaterThanOrEqual(5);
  });

  it('gets a project type with columns', () => {
    const pt = getProjectType(db, 'software-dev');
    expect(pt).not.toBeNull();
    expect(pt!.columns.length).toBe(5); // human, coding-agent, code-reviewer, security-reviewer, done
    expect(pt!.columns[0]!.column_id).toBe('human');
    expect(pt!.columns[4]!.column_id).toBe('done');
  });
});

// --- Agent Types ---

describe('agent types queries', () => {
  it('lists seeded agent types', () => {
    const types = listAgentTypes(db);
    expect(types.length).toBe(9);
  });

  it('gets an agent type with valid JSON tools', () => {
    const at = getAgentType(db, 'coding-agent');
    expect(at).not.toBeNull();
    const tools = JSON.parse(at!.allowed_tools) as string[];
    expect(tools).toContain('Read');
    expect(tools).toContain('Write');
  });
});

// --- Tickets ---

describe('tickets queries', () => {
  let projectId: string;

  beforeEach(() => {
    const p = createProject(db, { name: 'TP', path: '/tp', projectTypeId: 'software-dev' });
    projectId = p.id;
  });

  it('creates a ticket with defaults', () => {
    const t = createTicket(db, { projectId, title: 'Test ticket' });
    expect(t.column).toBe('human');
    expect(t.priority).toBe('normal');
    expect(t.created_by).toBe('human');
  });

  it('lists tickets with filters', () => {
    createTicket(db, { projectId, title: 'A', priority: 'high' });
    createTicket(db, { projectId, title: 'B', priority: 'low' });

    const all = listTickets(db);
    expect(all).toHaveLength(2);

    const high = listTickets(db, { priority: 'high' });
    expect(high).toHaveLength(1);
    expect(high[0]!.title).toBe('A');
  });

  it('updates ticket fields but not column', () => {
    const t = createTicket(db, { projectId, title: 'Old' });
    const updated = updateTicket(db, t.id, { title: 'New', priority: 'urgent' });
    expect(updated!.title).toBe('New');
    expect(updated!.priority).toBe('urgent');
    expect(updated!.column).toBe('human'); // unchanged
  });

  it('deletes a ticket', () => {
    const t = createTicket(db, { projectId, title: 'Delete me' });
    expect(deleteTicket(db, t.id)).toBe(true);
    expect(getTicket(db, t.id)).toBeNull();
  });

  it('moves a ticket and creates a move comment', () => {
    const t = createTicket(db, { projectId, title: 'Move me' });
    const moved = moveTicket(db, t.id, { toColumn: 'coding-agent', comment: 'Go!' });
    expect(moved!.column).toBe('coding-agent');

    const full = getTicketWithComments(db, t.id);
    const moveComment = full!.comments.find((c) => c.type === 'move');
    expect(moveComment).toBeDefined();
    expect(moveComment!.body).toBe('Go!');
  });

  it('adds comments (append-only)', () => {
    const t = createTicket(db, { projectId, title: 'Comments' });
    addComment(db, t.id, { type: 'comment', author: 'human', body: 'First' });
    addComment(db, t.id, { type: 'journal', author: 'agent:coding:r1', body: 'Second' });

    const full = getTicketWithComments(db, t.id);
    expect(full!.comments).toHaveLength(2);
    expect(full!.comments[0]!.body).toBe('First');
    expect(full!.comments[1]!.body).toBe('Second');
  });

  it('rejects ticket creation with invalid project', () => {
    expect(() =>
      createTicket(db, { projectId: 'bad-uuid', title: 'Fail' }),
    ).toThrow(/FOREIGN KEY/);
  });

  it('moveTicket resets heartbeat when target is an agent column', () => {
    const t = createTicket(db, { projectId, title: 'HB test' });
    moveTicket(db, t.id, { toColumn: 'coding-agent' });
    const after = getProject(db, projectId);
    // Heartbeat should have been reset to near-immediate
    expect(after!.next_check_at).toBeLessThanOrEqual(Date.now() + 10000);
    expect(after!.consecutive_empty_checks).toBe(0);
  });
});

// --- Attachments ---

describe('attachments queries', () => {
  let projectId: string;
  let ticketId: string;

  beforeEach(() => {
    const p = createProject(db, { name: 'AP', path: '/ap', projectTypeId: 'software-dev' });
    projectId = p.id;
    const t = createTicket(db, { projectId, title: 'Attachment test' });
    ticketId = t.id;
  });

  it('creates an attachment and returns it', () => {
    const a = createAttachment(db, {
      ticketId,
      filename: 'screenshot.png',
      storedName: 'abc-123.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
    });
    expect(a.id).toBeDefined();
    expect(a.ticket_id).toBe(ticketId);
    expect(a.filename).toBe('screenshot.png');
    expect(a.stored_name).toBe('abc-123.png');
    expect(a.mime_type).toBe('image/png');
    expect(a.size_bytes).toBe(1024);
    expect(a.created_at).toBeGreaterThan(0);
  });

  it('lists attachments for a ticket in creation order', () => {
    createAttachment(db, {
      ticketId,
      filename: 'first.png',
      storedName: 'a.png',
      mimeType: 'image/png',
      sizeBytes: 100,
    });
    createAttachment(db, {
      ticketId,
      filename: 'second.jpg',
      storedName: 'b.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 200,
    });

    const list = listAttachments(db, ticketId);
    expect(list).toHaveLength(2);
    expect(list[0]!.filename).toBe('first.png');
    expect(list[1]!.filename).toBe('second.jpg');
  });

  it('returns empty array for ticket with no attachments', () => {
    expect(listAttachments(db, ticketId)).toHaveLength(0);
  });

  it('gets a single attachment by id', () => {
    const a = createAttachment(db, {
      ticketId,
      filename: 'get-me.png',
      storedName: 'x.png',
      mimeType: 'image/png',
      sizeBytes: 50,
    });
    const fetched = getAttachment(db, a.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.filename).toBe('get-me.png');
  });

  it('returns null for nonexistent attachment', () => {
    expect(getAttachment(db, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('deletes an attachment', () => {
    const a = createAttachment(db, {
      ticketId,
      filename: 'delete-me.png',
      storedName: 'del.png',
      mimeType: 'image/png',
      sizeBytes: 10,
    });
    expect(deleteAttachment(db, a.id)).toBe(true);
    expect(getAttachment(db, a.id)).toBeNull();
  });

  it('delete returns false for nonexistent attachment', () => {
    expect(deleteAttachment(db, '00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('cascades delete when ticket is deleted', () => {
    const a = createAttachment(db, {
      ticketId,
      filename: 'cascade.png',
      storedName: 'c.png',
      mimeType: 'image/png',
      sizeBytes: 10,
    });
    deleteTicket(db, ticketId);
    expect(getAttachment(db, a.id)).toBeNull();
    expect(listAttachments(db, ticketId)).toHaveLength(0);
  });
});

// --- Ticket Statuses ---

describe('getTicketStatuses', () => {
  let projectId: string;

  beforeEach(() => {
    const p = createProject(db, { name: 'StatusProj', path: '/sp', projectTypeId: 'software-dev' });
    projectId = p.id;
  });

  function insertRun(ticketId: string, exitStatus: string, startedAt: number, endedAt: number | null = startedAt + 1000) {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO agent_runs (id, ticket_id, agent_type_id, model, started_at, ended_at, exit_status)
       VALUES (?, ?, 'coding-agent', 'claude-opus-4-6', ?, ?, ?)`,
    ).run(id, ticketId, startedAt, endedAt, exitStatus);
    return id;
  }

  it('returns gray for ticket with no runs and no issues', () => {
    const t = createTicket(db, { projectId, title: 'Idle ticket' });
    const statuses = getTicketStatuses(db, projectId);
    expect(statuses.get(t.id)).toBe('gray');
  });

  it('returns green for ticket with successful run', () => {
    const t = createTicket(db, { projectId, title: 'Good ticket' });
    insertRun(t.id, 'success', 1000);
    const statuses = getTicketStatuses(db, projectId);
    expect(statuses.get(t.id)).toBe('green');
  });

  it('returns red for ticket with crashed run', () => {
    const t = createTicket(db, { projectId, title: 'Crashed ticket' });
    insertRun(t.id, 'crashed', 1000);
    const statuses = getTicketStatuses(db, projectId);
    expect(statuses.get(t.id)).toBe('red');
  });

  it('returns red for ticket with timeout run', () => {
    const t = createTicket(db, { projectId, title: 'Timeout ticket' });
    insertRun(t.id, 'timeout', 1000);
    const statuses = getTicketStatuses(db, projectId);
    expect(statuses.get(t.id)).toBe('red');
  });

  it('returns red for ticket with blocked run', () => {
    const t = createTicket(db, { projectId, title: 'Blocked ticket' });
    insertRun(t.id, 'blocked', 1000);
    const statuses = getTicketStatuses(db, projectId);
    expect(statuses.get(t.id)).toBe('red');
  });

  it('returns gray for ticket with running (no exit) status', () => {
    const t = createTicket(db, { projectId, title: 'Running ticket' });
    insertRun(t.id, 'running', 1000, null);
    const statuses = getTicketStatuses(db, projectId);
    expect(statuses.get(t.id)).toBe('gray');
  });

  it('returns red for ticket with only finding comments and no runs', () => {
    const t = createTicket(db, { projectId, title: 'Finding only' });
    addComment(db, t.id, { type: 'finding', author: 'agent:code-reviewer:r1', body: 'Issue found' });
    const statuses = getTicketStatuses(db, projectId);
    expect(statuses.get(t.id)).toBe('red');
  });

  it('returns red for ticket with only block comments and no runs', () => {
    const t = createTicket(db, { projectId, title: 'Block only' });
    addComment(db, t.id, { type: 'block', author: 'system:recovery', body: 'Crashed' });
    const statuses = getTicketStatuses(db, projectId);
    expect(statuses.get(t.id)).toBe('red');
  });

  it('returns red when finding comment is newer than successful run', () => {
    const t = createTicket(db, { projectId, title: 'Finding after success' });
    insertRun(t.id, 'success', 1000, 2000);
    addComment(db, t.id, { type: 'finding', author: 'agent:code-reviewer:r1', body: 'Nope' });
    const statuses = getTicketStatuses(db, projectId);
    expect(statuses.get(t.id)).toBe('red');
  });

  it('returns green when successful run is newer than finding comment', () => {
    const t = createTicket(db, { projectId, title: 'Success after finding' });
    addComment(db, t.id, { type: 'finding', author: 'agent:code-reviewer:r1', body: 'Old finding' });
    // Run ends well after the comment (comment created_at is ~Date.now())
    insertRun(t.id, 'success', Date.now() + 100000, Date.now() + 200000);
    const statuses = getTicketStatuses(db, projectId);
    expect(statuses.get(t.id)).toBe('green');
  });

  it('uses latest run when ticket has multiple runs', () => {
    const t = createTicket(db, { projectId, title: 'Multiple runs' });
    insertRun(t.id, 'crashed', 1000, 2000);
    insertRun(t.id, 'success', 3000, 4000);
    const statuses = getTicketStatuses(db, projectId);
    expect(statuses.get(t.id)).toBe('green');
  });

  it('handles multiple tickets in same project independently', () => {
    const t1 = createTicket(db, { projectId, title: 'Good' });
    const t2 = createTicket(db, { projectId, title: 'Bad' });
    const t3 = createTicket(db, { projectId, title: 'Idle' });
    insertRun(t1.id, 'success', 1000);
    insertRun(t2.id, 'crashed', 1000);
    const statuses = getTicketStatuses(db, projectId);
    expect(statuses.get(t1.id)).toBe('green');
    expect(statuses.get(t2.id)).toBe('red');
    expect(statuses.get(t3.id)).toBe('gray');
  });
});
