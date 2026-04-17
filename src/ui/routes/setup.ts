// UI route registration and template engine setup.
//
// Registers @fastify/view (Handlebars) and @fastify/static, then
// mounts all UI page routes. The API routes are mounted separately
// in daemon/http.ts — UI routes serve HTML, API routes serve JSON.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import fastifyView from '@fastify/view';
import fastifyStatic from '@fastify/static';
import Handlebars from 'handlebars';
import type { Database } from 'better-sqlite3';
import type { ConfigRef } from '../../config.schema.js';
import { displayPath } from '../../display-path.js';
import { inboxRoutes } from './inbox.js';
import { projectUiRoutes } from './projects.js';
import { ticketUiRoutes } from './tickets.js';
import { agentTypeUiRoutes } from './agent-types.js';
import { projectTypeUiRoutes } from './project-types.js';
import { settingsUiRoutes } from './settings.js';
import { setupWizardRoutes } from './setup-wizard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Register Handlebars helpers
Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);
Handlebars.registerHelper('displayPath', (path: string) => displayPath(path));
Handlebars.registerHelper('relativeTime', (timestamp: number) => {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
});

export async function setupUi(app: FastifyInstance, db: Database, configRef: ConfigRef): Promise<void> {
  const templatesDir = join(__dirname, '..', 'templates');

  const commentThreadSrc = await readFile(join(templatesDir, 'comment-thread.hbs'), 'utf8');
  Handlebars.registerPartial('commentThread', commentThreadSrc);
  const commentThreadTemplate = Handlebars.compile(commentThreadSrc);

  const agentEditFormSrc = await readFile(join(templatesDir, 'agent-edit-form.hbs'), 'utf8');
  Handlebars.registerPartial('agentEditForm', agentEditFormSrc);

  const projectTypeEditFormSrc = await readFile(join(templatesDir, 'project-type-edit-form.hbs'), 'utf8');
  Handlebars.registerPartial('projectTypeEditForm', projectTypeEditFormSrc);

  const boardColumnsSrc = await readFile(join(templatesDir, 'board-columns.hbs'), 'utf8');
  Handlebars.registerPartial('boardColumns', boardColumnsSrc);
  const boardColumnsTemplate = Handlebars.compile(boardColumnsSrc);

  // Template engine
  await app.register(fastifyView, {
    engine: { handlebars: Handlebars },
    root: templatesDir,
    layout: 'layout.hbs',
    options: {
      partials: {},
    },
  });

  // Static files (CSS, JS)
  await app.register(fastifyStatic, {
    root: join(__dirname, '..', 'static'),
    prefix: '/static/',
    decorateReply: false,
  });

  // Mount UI page routes
  await inboxRoutes(app, db);
  await projectUiRoutes(app, db, configRef, { boardColumnsTemplate });
  await ticketUiRoutes(app, db, { commentThreadTemplate });
  await agentTypeUiRoutes(app, db);
  await projectTypeUiRoutes(app, db);
  await settingsUiRoutes(app, configRef);
  await setupWizardRoutes(app);
}
