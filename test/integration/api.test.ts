// MVP-41: Integration tests for the HTTP API.
// Uses Fastify's inject() method — no port binding, fast and isolated.
// Each test gets a fresh in-memory DB.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { openDatabase } from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedBuiltins } from '../../src/db/seed.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import { createHttpServer } from '../../src/daemon/http.js';
import type { Database } from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

let app: FastifyInstance;
let db: Database;
let tmpDir: string;

beforeEach(async () => {
  db = openDatabase(':memory:');
  runMigrations(db);
  seedBuiltins(db);

  tmpDir = mkdtempSync(join(tmpdir(), 'pd-api-test-'));
  const config = loadConfig(join(tmpDir, 'nonexistent.json'));
  const logger = createLogger(join(tmpDir, 'logs'));

  app = await createHttpServer({ config, db, logger });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('Health API', () => {
  it('GET /api/health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.database).toBe('connected');
  });
});

describe('Projects API', () => {
  it('creates, lists, and archives a project', async () => {
    // Create
    const create = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Test', path: '/tmp/test-api', project_type_id: 'software-dev' },
    });
    expect(create.statusCode).toBe(201);
    const project = create.json();
    expect(project.name).toBe('Test');

    // List
    const list = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(list.json()).toHaveLength(1);

    // Archive
    const archive = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}` });
    expect(archive.statusCode).toBe(200);

    // List after archive — should be empty (default excludes archived)
    const listAfter = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(listAfter.json()).toHaveLength(0);
  });

  it('rejects duplicate path with 409', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'A', path: '/dup', project_type_id: 'software-dev' },
    });
    const dup = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'B', path: '/dup', project_type_id: 'software-dev' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('rejects invalid input with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Validation failed');
  });
});

describe('Tickets API', () => {
  let projectId: string;

  beforeEach(async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'TP', path: '/tp-api', project_type_id: 'software-dev' },
    });
    projectId = res.json().id;
  });

  it('full ticket lifecycle: create → move → comment → show thread', async () => {
    // Create
    const create = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      payload: { project_id: projectId, title: 'Lifecycle test' },
    });
    expect(create.statusCode).toBe(201);
    const ticket = create.json();
    expect(ticket.column).toBe('human');

    // Move to coding-agent
    const move = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/move`,
      payload: { to_column: 'coding-agent', comment: 'Start coding' },
    });
    expect(move.statusCode).toBe(200);
    expect(move.json().column).toBe('coding-agent');

    // Add a comment
    await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/comments`,
      payload: { type: 'journal', author: 'agent:coding:r1', body: 'Working...' },
    });

    // Show with thread
    const show = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticket.id}`,
    });
    expect(show.statusCode).toBe(200);
    const full = show.json();
    expect(full.comments).toHaveLength(2); // move comment + journal
    expect(full.comments[0].type).toBe('move');
    expect(full.comments[1].type).toBe('journal');
  });

  it('inbox query returns only human-column tickets', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/tickets',
      payload: { project_id: projectId, title: 'In inbox' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/tickets',
      payload: { project_id: projectId, title: 'Not in inbox', column: 'coding-agent' },
    });

    const inbox = await app.inject({ method: 'GET', url: '/api/tickets?column=human' });
    expect(inbox.json()).toHaveLength(1);
    expect(inbox.json()[0].title).toBe('In inbox');
  });

  it('rejects move to invalid column with 400', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      payload: { project_id: projectId, title: 'Bad move' },
    });
    const ticket = create.json();

    const move = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticket.id}/move`,
      payload: { to_column: 'nonexistent-column' },
    });
    expect(move.statusCode).toBe(400);
  });

  it('returns 404 for nonexistent ticket', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/tickets/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('Project Workflow API (per-project templates)', () => {
  let projectId: string;

  beforeEach(async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'WF', path: '/wf-test', project_type_id: 'software-dev' },
    });
    expect(res.statusCode).toBe(201);
    projectId = res.json().id;
  });

  it('registration clones the template into a project-scoped project_type', async () => {
    // Fetch the workflow — it should exist with cloned columns.
    const wf = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/workflow` });
    expect(wf.statusCode).toBe(200);
    const body = wf.json();
    expect(body.owner_project_id).toBe(projectId);
    expect(body.id).not.toBe('software-dev'); // Fresh UUID, not the template slug
    expect(body.columns.length).toBeGreaterThan(0);
    // Confirm the library template itself is untouched.
    const listProjectTypes = await app.inject({ method: 'GET', url: '/api/project-types' });
    const libSoftwareDev = (listProjectTypes.json() as Array<{ id: string }>).find(
      (t) => t.id === 'software-dev',
    );
    expect(libSoftwareDev).toBeTruthy();
    // Library's owner is null — it wasn't consumed by the clone
    const softwareDevFull = await app.inject({ method: 'GET', url: '/api/project-types/software-dev' });
    expect(softwareDevFull.json().owner_project_id).toBeNull();
  });

  it('editing one project workflow does not affect another project', async () => {
    const other = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'WF2', path: '/wf-test-2', project_type_id: 'software-dev' },
    });
    expect(other.statusCode).toBe(201);
    const otherId = other.json().id;

    // Edit the first project's workflow — rename a column.
    const wfBefore = (await app.inject({ method: 'GET', url: `/api/projects/${projectId}/workflow` })).json();
    const renamedCols = wfBefore.columns.map((c: { name: string }, i: number) =>
      i === 0 ? { ...wfBefore.columns[i], name: 'Renamed Inbox' } : wfBefore.columns[i],
    );
    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/workflow`,
      payload: { columns: renamedCols },
    });
    expect(put.statusCode).toBe(200);

    // Other project still has the original column names.
    const otherWf = (await app.inject({ method: 'GET', url: `/api/projects/${otherId}/workflow` })).json();
    expect(otherWf.columns[0].name).toBe(wfBefore.columns[0].name);
    expect(otherWf.columns[0].name).not.toBe('Renamed Inbox');
  });

  it('blank template creates an empty workflow', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Blank', path: '/blank-test', project_type_id: 'blank' },
    });
    expect(res.statusCode).toBe(201);
    const wf = (await app.inject({
      method: 'GET',
      url: `/api/projects/${res.json().id}/workflow`,
    })).json();
    expect(wf.columns).toHaveLength(0);
  });

  it('PUT workflow refuses to remove columns that still hold tickets', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/tickets',
      payload: { project_id: projectId, title: 'Stuck here', column: 'coding-agent' },
    });
    const wf = (await app.inject({ method: 'GET', url: `/api/projects/${projectId}/workflow` })).json();
    // Try to save the workflow WITHOUT the coding-agent column
    const reducedCols = wf.columns.filter(
      (c: { column_id: string }) => c.column_id !== 'coding-agent',
    );
    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/workflow`,
      payload: { columns: reducedCols },
    });
    expect(put.statusCode).toBe(409);
    expect(put.json().error).toMatch(/tickets/i);
  });

  it('PUT workflow rejects cross-project agent references', async () => {
    // Register a second project and fork one of its agents.
    const other = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'OtherProj', path: '/other-wf', project_type_id: 'software-dev' },
    });
    const otherId = other.json().id;
    const fork = await app.inject({
      method: 'POST',
      url: `/api/projects/${otherId}/agents/fork`,
      payload: { agent_type_id: 'coding-agent' },
    });
    expect(fork.statusCode).toBe(201);
    const otherProjectAgentId = fork.json().forked_agent_type_id;

    // Now try to assign that OTHER project's agent to THIS project's column.
    const wf = (await app.inject({ method: 'GET', url: `/api/projects/${projectId}/workflow` })).json();
    const cols = wf.columns.map((c: { column_id: string }, i: number) =>
      i === 1 ? { ...wf.columns[i], agent_type_id: otherProjectAgentId } : wf.columns[i],
    );
    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${projectId}/workflow`,
      payload: { columns: cols },
    });
    expect(put.statusCode).toBe(400);
    expect(put.json().error).toMatch(/out-of-scope/i);
  });

  it('fork creates a project-scoped copy, rebinds the column, and does not mutate the library', async () => {
    const libraryCodingAgent = (await app.inject({
      method: 'GET',
      url: '/api/agent-types/coding-agent',
    })).json();

    const fork = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/agents/fork`,
      payload: { agent_type_id: 'coding-agent', column_id: 'coding-agent' },
    });
    expect(fork.statusCode).toBe(201);
    const forkedId = fork.json().forked_agent_type_id;

    // The forked agent has a different id (UUID, not slug) and its system_prompt_path
    // points at a fork-specific file — so editing the fork doesn't write over the library.
    const forked = (await app.inject({
      method: 'GET',
      url: `/api/agent-types/${forkedId}`,
    })).json();
    expect(forked.id).not.toBe('coding-agent');
    expect(forked.owner_project_id).toBe(projectId);
    expect(forked.system_prompt_path).not.toBe(libraryCodingAgent.system_prompt_path);

    // The project's coding-agent column now points at the fork, not the library.
    const wf = (await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/workflow`,
    })).json();
    const codingColumn = wf.columns.find((c: { column_id: string }) => c.column_id === 'coding-agent');
    expect(codingColumn.agent_type_id).toBe(forkedId);

    // Library is untouched.
    const libAfter = (await app.inject({
      method: 'GET',
      url: '/api/agent-types/coding-agent',
    })).json();
    expect(libAfter.system_prompt_path).toBe(libraryCodingAgent.system_prompt_path);
  });

  it('fork rejects forking a project-scoped agent (only library agents are forkable)', async () => {
    const firstFork = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/agents/fork`,
      payload: { agent_type_id: 'coding-agent' },
    });
    const forkedId = firstFork.json().forked_agent_type_id;
    const doubleFork = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/agents/fork`,
      payload: { agent_type_id: forkedId },
    });
    expect(doubleFork.statusCode).toBe(400);
  });
});

describe('Config API', () => {
  it('GET /api/config returns defaults', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ui.port).toBe(5757);
  });
});

describe('Project Types API', () => {
  it('lists seeded project types', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/project-types' });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThanOrEqual(5);
  });

  it('rejects deletion of built-in type with 409', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/project-types/software-dev' });
    expect(res.statusCode).toBe(409);
  });
});

describe('Agent Types API', () => {
  it('lists seeded agent types', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agent-types' });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(9);
  });
});

describe('Attachments API', () => {
  let projectId: string;
  let ticketId: string;
  const ATTACHMENTS_BASE = join(homedir(), 'Development', '.tasks', 'artifacts', 'attachments');

  // Minimal 1x1 red PNG (68 bytes)
  const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAH' +
      'ggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64',
  );

  function multipartPayload(
    filename: string,
    contentType: string,
    content: Buffer,
  ): { body: Buffer; contentType: string } {
    const boundary = '----TestBoundary' + Date.now();
    const header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([Buffer.from(header), content, Buffer.from(footer)]);
    return { body, contentType: `multipart/form-data; boundary=${boundary}` };
  }

  beforeEach(async () => {
    const proj = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'AttachProj', path: '/attach-test', project_type_id: 'software-dev' },
    });
    projectId = proj.json().id;

    const ticket = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      payload: { project_id: projectId, title: 'Attach ticket' },
    });
    ticketId = ticket.json().id;
  });

  afterEach(() => {
    // Clean up attachment files written to disk by test uploads
    const ticketDir = join(ATTACHMENTS_BASE, ticketId);
    if (existsSync(ticketDir)) {
      rmSync(ticketDir, { recursive: true, force: true });
    }
  });

  it('uploads an image and lists it', async () => {
    const { body, contentType } = multipartPayload('test.png', 'image/png', TINY_PNG);
    const upload = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketId}/attachments`,
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(upload.statusCode).toBe(201);
    const attachment = upload.json();
    expect(attachment.filename).toBe('test.png');
    expect(attachment.mime_type).toBe('image/png');
    expect(attachment.size_bytes).toBe(TINY_PNG.length);

    // List
    const list = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketId}/attachments`,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].id).toBe(attachment.id);
  });

  it('serves an uploaded file', async () => {
    const { body, contentType } = multipartPayload('serve.png', 'image/png', TINY_PNG);
    const upload = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketId}/attachments`,
      headers: { 'content-type': contentType },
      payload: body,
    });
    const id = upload.json().id;

    const file = await app.inject({
      method: 'GET',
      url: `/api/attachments/${id}/file`,
    });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.rawPayload.length).toBe(TINY_PNG.length);
  });

  it('deletes an attachment and removes file from disk', async () => {
    const { body, contentType } = multipartPayload('del.png', 'image/png', TINY_PNG);
    const upload = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketId}/attachments`,
      headers: { 'content-type': contentType },
      payload: body,
    });
    const att = upload.json();

    // Verify file exists on disk before delete
    const filePath = join(ATTACHMENTS_BASE, ticketId, att.stored_name);
    expect(existsSync(filePath)).toBe(true);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/attachments/${att.id}`,
    });
    expect(del.statusCode).toBe(200);

    // Verify DB record is gone
    const list = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketId}/attachments`,
    });
    expect(list.json()).toHaveLength(0);

    // Verify file is gone from disk
    expect(existsSync(filePath)).toBe(false);
  });

  it('rejects upload with disallowed MIME type', async () => {
    const { body, contentType } = multipartPayload('evil.exe', 'application/octet-stream', Buffer.from('bad'));
    const upload = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketId}/attachments`,
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(upload.statusCode).toBe(400);
    expect(upload.json().error).toMatch(/Unsupported file type/);
  });

  it('rejects SVG uploads', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>');
    const { body, contentType } = multipartPayload('evil.svg', 'image/svg+xml', svg);
    const upload = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketId}/attachments`,
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(upload.statusCode).toBe(400);
    expect(upload.json().error).toMatch(/Unsupported file type/);
  });

  it('returns 404 for upload to nonexistent ticket', async () => {
    const { body, contentType } = multipartPayload('lost.png', 'image/png', TINY_PNG);
    const upload = await app.inject({
      method: 'POST',
      url: '/api/tickets/00000000-0000-0000-0000-000000000000/attachments',
      headers: { 'content-type': contentType },
      payload: body,
    });
    expect(upload.statusCode).toBe(404);
  });

  it('returns 404 for nonexistent attachment file', async () => {
    const file = await app.inject({
      method: 'GET',
      url: '/api/attachments/00000000-0000-0000-0000-000000000000/file',
    });
    expect(file.statusCode).toBe(404);
  });
});
