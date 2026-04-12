// Daemon entry point for Project Dispatcher.
//
// Startup order:
//   1. Load config
//   2. Create logger
//   3. Open database + run migrations + seed builtins
//   4. Create HTTP server
//   5. Bind and listen
//
// Shutdown (SIGTERM / SIGINT):
//   1. Close HTTP server (stop accepting new connections)
//   2. Close database (flush WAL)
//   3. Exit 0

import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { openDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { seedBuiltins } from '../db/seed.js';
import { createHttpServer, BIND_HOST } from './http.js';

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

  // 4. HTTP server
  const app = await createHttpServer({ config, db, logger });

  // 5. Listen
  const port = config.ui.port;
  await app.listen({ host: BIND_HOST, port });
  logger.info({ host: BIND_HOST, port }, 'Daemon listening');

  // Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'Shutdown signal received');
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
