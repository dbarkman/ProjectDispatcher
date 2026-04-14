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
import type { Config } from '../../config.schema.js';
import { inboxRoutes } from './inbox.js';
import { projectUiRoutes } from './projects.js';
import { ticketUiRoutes } from './tickets.js';
import { agentTypeUiRoutes } from './agent-types.js';
import { settingsUiRoutes } from './settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Register Handlebars helpers
Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);
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

export async function setupUi(app: FastifyInstance, db: Database, config: Config): Promise<void> {
  const templatesDir = join(__dirname, '..', 'templates');

  // Register shared partials used inside full views, and pre-compile them
  // as standalone templates for htmx auto-poll endpoints that render just
  // the fragment. One-shot startup I/O before listen() — async readFile
  // doesn't block anything here.
  const commentThreadSrc = await readFile(join(templatesDir, 'comment-thread.hbs'), 'utf8');
  Handlebars.registerPartial('commentThread', commentThreadSrc);
  const commentThreadTemplate = Handlebars.compile(commentThreadSrc);

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
  await projectUiRoutes(app, db, config);
  await ticketUiRoutes(app, db, { commentThreadTemplate });
  await agentTypeUiRoutes(app, db);
  await settingsUiRoutes(app, config);
}
