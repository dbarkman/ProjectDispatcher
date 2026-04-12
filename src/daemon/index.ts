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
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { seedBuiltins } from '../db/seed.js';
import { createHttpServer, BIND_HOST } from './http.js';
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

  // 4. Discover projects on disk
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
  const recovery = recoverFromCrash(db, logger);
  if (recovery.orphanedRuns > 0) {
    logger.warn(recovery, 'Crash recovery cleaned up stale state');
  }

  // 6. HTTP server
  const app = await createHttpServer({ config, db, logger });

  // 6. Listen
  const port = config.ui.port;
  await app.listen({ host: BIND_HOST, port });
  logger.info({ host: BIND_HOST, port }, 'Daemon listening');

  // 8. Start filesystem watcher for live project discovery
  const watcher = startWatcher(db, config, logger);
  logger.info('Filesystem watcher started');

  // 9. Start the heartbeat scheduler
  const scheduler = new Scheduler(db, config, logger);
  scheduler.start();

  // Graceful shutdown — idempotent so concurrent SIGTERM + SIGINT don't
  // race each other. (Security Review #7 LOW-01)
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received');
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
      db.close();
      logger.info('Database closed');
    } catch (err) {
      logger.error({ err }, 'Error closing database');
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // If startup fails (bad config, DB unreachable, port in use), crash
  // loud with the actual error — do not swallow it.
  console.error('Fatal: daemon failed to start', err);
  process.exit(1);
});
