import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';
import { type ConfigRef } from '../config.schema.js';
import type { Scheduler } from './scheduler.js';
import { projectRoutes } from './routes/projects.js';
import { projectTypeRoutes } from './routes/project-types.js';
import { agentTypeRoutes } from './routes/agent-types.js';
import { ticketRoutes } from './routes/tickets.js';
import { attachmentRoutes } from './routes/attachments.js';
import { configRoutes } from './routes/config.js';
import { aiConfigRoutes } from './routes/ai-config.js';
import { agentRunRoutes } from './routes/agent-runs.js';
import { discoveryRoutes } from './routes/discovery.js';
import { setupUi } from '../ui/routes/setup.js';

export interface HttpServerDeps {
  configRef: ConfigRef;
  db: Database;
  logger: Logger;
  scheduler?: Scheduler;
}

/**
 * Create and configure the Fastify HTTP server.
 *
 * Binds to 127.0.0.1 ONLY — per DESIGN.md §15 (security model), this
 * daemon must never be network-reachable. The bind address is hardcoded,
 * not configurable, because making it configurable invites
 * misconfiguration. If someone needs remote access, they should use an
 * SSH tunnel, not a config knob.
 *
 * CORS allows localhost origins only (any port) for development
 * flexibility, but the bound address means it's unreachable from
 * non-local origins regardless.
 */
export async function createHttpServer(deps: HttpServerDeps): Promise<FastifyInstance> {
  const { configRef, db, logger, scheduler } = deps;

  const app = Fastify({
    // Fastify 5 uses `loggerInstance` for external Pino instances (not
    // `logger`, which now only accepts a config object). The cast is safe
    // because Pino Logger is a superset of FastifyBaseLogger — the type
    // mismatch is a known Fastify 5 / Pino generics interop issue.
    loggerInstance: logger as FastifyBaseLogger,
  });

  // --- DNS rebinding protection ---
  // Reject requests whose Host header hostname is not localhost / 127.0.0.1 /
  // [::1]. A malicious page served from attacker.com that DNS-rebinds to
  // 127.0.0.1 sends Host: attacker.com — the hostname check catches that.
  // Port is intentionally not checked: the security value is entirely in the
  // hostname, and Fastify's inject() sends "localhost:80" by default which
  // would break every integration test for no real security gain.
  const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host;
    if (!host) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    // Extract hostname — strip port suffix. IPv6 brackets handled: [::1]:5757
    const colonIdx = host.lastIndexOf(':');
    const hostname = colonIdx > 0 && !host.endsWith(']')
      ? host.slice(0, colonIdx)
      : host;
    if (!ALLOWED_HOSTNAMES.has(hostname)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
  });

  // Security headers applied to every response.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
    ].join('; ');
    reply.header('Content-Security-Policy', csp);
  });

  // Setup wizard redirect: if AI provider not configured, redirect UI
  // routes to /ui/setup. API, static, and the setup page itself are exempt.
  app.addHook('onRequest', async (request, reply) => {
    if (configRef.current.ai.auth_method) return;
    const url = request.url;
    if (url.startsWith('/ui/setup') || url.startsWith('/api/') || url.startsWith('/static/')) return;
    if (url === '/' || url.startsWith('/ui/')) {
      return reply.redirect('/ui/setup');
    }
  });

  // Multipart support for file uploads (attachments).
  await app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10 MB
      files: 1,                    // one file per request
    },
  });

  // CORS: allow localhost on any port (for dev), reject everything else.
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) {
        // Non-browser request (curl, CLI, etc.) — allow
        cb(null, true);
        return;
      }
      try {
        const url = new URL(origin);
        if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]') {
          cb(null, true);
          return;
        }
      } catch {
        // Malformed origin — reject
      }
      cb(new Error('CORS: origin not allowed'), false);
    },
  });

  // Global error handler — structured JSON errors, no stack traces leaked.
  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    // Zod validation errors → 400 with field-specific details.
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      return reply.status(400).send({ error: 'Validation failed', issues });
    }

    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 500) {
      request.log.error({ err: error }, 'Internal server error');
    } else {
      request.log.warn({ err: error }, `Client error ${statusCode}`);
    }

    reply.status(statusCode).send({
      error: statusCode >= 500 ? 'Internal server error' : error.message,
    });
  });

  // --- Route registration ---
  await projectRoutes(app, db, scheduler);
  await projectTypeRoutes(app, db);
  await agentTypeRoutes(app, db);
  await ticketRoutes(app, db, scheduler);
  await attachmentRoutes(app, db);
  await agentRunRoutes(app, db);
  await configRoutes(app, configRef);
  await aiConfigRoutes(app, configRef);
  await discoveryRoutes(app, db, configRef);

  // Web UI (htmx + Handlebars) — serves HTML pages
  await setupUi(app, db, configRef);

  // Health check — no auth, lightweight, used by monitoring and CLI.
  app.get('/api/health', async () => {
    // Quick DB liveness check — pragma returns a value if the connection
    // is alive. If the DB handle is broken, this throws and the error
    // handler returns 500.
    db.pragma('journal_mode');

    return {
      status: 'ok',
      pid: process.pid,
      uptime_seconds: Math.floor(process.uptime()),
      database: 'connected',
      port: configRef.current.ui.port,
    };
  });

  return app;
}

/**
 * The address the daemon binds to. Hardcoded to 127.0.0.1.
 * See the security note on createHttpServer above.
 */
export const BIND_HOST = '127.0.0.1';
