// Daemon entry point for Project Dispatcher.
//
// Startup order:
//   1. Load config
//   2. Create logger
//   3. Open database + run migrations + seed builtins
//   4. Discover projects on disk
//   5. Crash recovery (clean orphaned runs — MUST be before scheduler)
//   6. Create HTTP server + bind and listen
//   7. Start filesystem watcher
//   8. Start heartbeat scheduler
//
// Shutdown (SIGTERM / SIGINT — idempotent):
//   1. Stop scheduler (no new agent runs)
//   2. Close filesystem watcher (no new discovery events)
//   3. Close HTTP server (drain in-flight requests)
//   4. Close database (flush WAL)
//   5. Exit 0

import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { seedBuiltins } from '../db/seed.js';
import { createHttpServer, BIND_HOST } from './http.js';
import { writePidFile, removePidFile } from './pidfile.js';
import { startBackgroundJobs } from './jobs.js';
import { discoverProjects } from './discovery.js';
import { startWatcher } from './watcher.js';
import { recoverFromCrash } from './recovery.js';
import { Scheduler } from './scheduler.js';

const TASKS_DIR = join(homedir(), 'Development', '.tasks');

async function main(): Promise<void> {
  // 1. Config
  const config = loadConfig();

  // 2. Logger
  const logsDir = join(TASKS_DIR, 'logs');
  const logger = createLogger(logsDir);
  logger.info('Project Dispatcher starting');

  // 3. Database
  const db = openDatabase();
  const migrations = runMigrations(db);
  if (migrations.applied.length > 0) {
    logger.info({ applied: migrations.applied }, 'Migrations applied');
  }
  const seed = seedBuiltins(db);
  if (seed.projectTypesInserted + seed.agentTypesInserted + seed.projectTypeColumnsInserted > 0) {
    logger.info(seed, 'Seed data inserted');
  }

  // 4. Ensure default prompt files exist in ~/.tasks/prompts/
  //    Copies from the shipped defaults (src/prompts/defaults/ or
  //    dist/prompts/defaults/) if the target doesn't already exist.
  //    Preserves user edits — never overwrites existing files.
  const promptsSrc = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'defaults'));
  const promptsDest = join(TASKS_DIR, 'prompts');
  try {
    await mkdir(promptsDest, { recursive: true });
    if (existsSync(promptsSrc)) {
      const promptFiles = await readdir(promptsSrc);
      let copied = 0;
      for (const file of promptFiles) {
        const destPath = join(promptsDest, file);
        if (!existsSync(destPath)) {
          await copyFile(join(promptsSrc, file), destPath);
          copied++;
        }
      }
      if (copied > 0) {
        logger.info({ copied, total: promptFiles.length }, 'Default prompt files copied');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to copy default prompt files — agents will use fallback prompts');
  }

  // 5. Discover projects on disk
  const discovery = await discoverProjects(db, config);
  logger.info(
    {
      registered: discovery.registered.length,
      discovered: discovery.discovered.length,
      missing: discovery.missing.length,
      restored: discovery.restored.length,
    },
    'Project discovery complete',
  );

  // 5. Crash recovery — clean up stale state BEFORE the scheduler starts
  const recovery = await recoverFromCrash(db, logger);
  if (recovery.orphanedRuns > 0) {
    logger.warn(recovery, 'Crash recovery cleaned up stale state');
  }

  // 6. Create scheduler instance (but don't start it yet — HTTP routes
  //    need a reference to call resetProject on ticket moves and wakes).
  const scheduler = new Scheduler(db, config, logger);

  // 7. HTTP server — pass scheduler so routes can trigger heartbeat resets
  const app = await createHttpServer({ config, db, logger, scheduler });

  // 8. Listen
  const port = config.ui.port;
  await app.listen({ host: BIND_HOST, port });
  logger.info({ host: BIND_HOST, port }, 'Daemon listening');

  if (!config.ai.auth_method) {
    logger.warn(
      { setupUrl: `http://${BIND_HOST}:${port}/ui/setup` },
      'AI provider not configured — visit the setup wizard to configure authentication',
    );
  }

  // 9. Start filesystem watcher for live project discovery
  const watcher = startWatcher(db, config, logger);
  logger.info('Filesystem watcher started');

  // 10. Start the heartbeat scheduler (after listen so the server is ready)
  scheduler.start();

  // 11. Write PID file (Gap fix #14)
  await writePidFile();
  logger.info({ pid: process.pid }, 'PID file written');

  // 12. Start background jobs (backup + retention cleanup)
  const jobsInterval = startBackgroundJobs(db, config, logger);
  logger.info('Background jobs started');

  // Graceful shutdown — idempotent so concurrent SIGTERM + SIGINT don't
  // race each other. (Security Review #7 LOW-01)
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received');
    clearInterval(jobsInterval);
    try {
      scheduler.stop();
      logger.info('Scheduler stopped');
    } catch (err) {
      logger.error({ err }, 'Error stopping scheduler');
    }
    try {
      await watcher.close();
      logger.info('Filesystem watcher closed');
    } catch (err) {
      logger.error({ err }, 'Error closing watcher');
    }
    try {
      await app.close();
      logger.info('HTTP server closed');
    } catch (err) {
      logger.error({ err }, 'Error closing HTTP server');
    }
    try {
      await removePidFile();
      logger.info('PID file removed');
    } catch (err) {
      logger.error({ err }, 'Error removing PID file');
    }
    try {
      db.close();
      logger.info('Database closed');
    } catch (err) {
      logger.error({ err }, 'Error closing database');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Process-level resilience. A single bad request (e.g. a filename with
  // non-ASCII chars in a Content-Disposition header) must NOT kill the
  // daemon. These handlers catch what Fastify's error handler misses —
  // errors thrown synchronously inside Node's HTTP response writer bypass
  // the framework's error handler entirely. Without this, one malformed
  // attachment download crashed the entire server (ERR_INVALID_CHAR).
  //
  // We log fatal-level but do NOT exit. The request that caused the error
  // already failed; the server stays up for everything else.
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — exiting for clean restart');
    // Exit and let the init system (LaunchAgent / systemd / PM2) restart
    // the process cleanly. Staying alive after an uncaught synchronous
    // exception risks serving requests from a corrupted process state.
    // (Code review MEDIUM: Node docs explicitly warn against staying alive.)
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled rejection — daemon staying alive');
  });
}

main().catch((err) => {
  // If startup fails (bad config, DB unreachable, port in use), crash
  // loud with the actual error — do not swallow it.
  console.error('Fatal: daemon failed to start', err);
  process.exit(1);
});
