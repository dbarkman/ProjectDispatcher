// Background jobs — nightly backup and retention cleanup.
//
// These run as periodic timers inside the daemon process, not as
// separate cron entries. Each job fires once per day (checked
// every hour, runs if the last run was >23 hours ago).
//
// Gap fixes #12 (backup) and #13 (retention cleanup).

import { mkdir, readdir, unlink, stat, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Config } from '../config.schema.js';
import { DEFAULT_TASKS_DIR } from '../db/index.js';

const BACKUPS_DIR = join(DEFAULT_TASKS_DIR, 'backups');
const LOGS_DIR = join(DEFAULT_TASKS_DIR, 'logs');
const RUNS_DIR = join(DEFAULT_TASKS_DIR, 'artifacts', 'runs');

/** State tracked in memory — resets on daemon restart, which is fine. */
let lastBackupAt = 0;
let lastCleanupAt = 0;

const ONE_HOUR_MS = 60 * 60 * 1000;
const TWENTY_THREE_HOURS_MS = 23 * ONE_HOUR_MS;

/**
 * Start the background job timer. Checks every hour whether the
 * nightly backup and retention cleanup need to run.
 */
export function startBackgroundJobs(
  db: Database,
  config: Config,
  logger: Logger,
): ReturnType<typeof setInterval> {
  const jobLogger = logger.child({ component: 'jobs' });

  const tick = async (): Promise<void> => {
    const now = Date.now();

    // Nightly backup (Gap fix #12)
    if (now - lastBackupAt > TWENTY_THREE_HOURS_MS) {
      try {
        await runBackup(db, config, jobLogger);
        lastBackupAt = now;
      } catch (err) {
        jobLogger.error({ err }, 'Backup job failed');
      }
    }

    // Retention cleanup (Gap fix #13)
    if (now - lastCleanupAt > TWENTY_THREE_HOURS_MS) {
      try {
        await runRetentionCleanup(config, jobLogger);
        lastCleanupAt = now;
      } catch (err) {
        jobLogger.error({ err }, 'Retention cleanup failed');
      }
    }
  };

  // Run immediately on startup, then every hour
  tick().catch((err) => jobLogger.error({ err }, 'Initial job tick failed'));
  return setInterval(() => {
    tick().catch((err) => jobLogger.error({ err }, 'Job tick failed'));
  }, ONE_HOUR_MS);
}

/**
 * Nightly backup: SQLite VACUUM INTO a dated backup file.
 * Keeps the last N backups per config.retention.backup_count.
 */
async function runBackup(db: Database, config: Config, logger: Logger): Promise<void> {
  await mkdir(BACKUPS_DIR, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const backupPath = join(BACKUPS_DIR, `tasks-${today}.db`);

  // Skip if today's backup already exists (async — no sync fs in daemon paths)
  try {
    await access(backupPath);
    logger.debug({ backupPath }, 'Backup already exists for today');
    return;
  } catch {
    // File doesn't exist — proceed with backup
  }

  // VACUUM INTO creates a clean, compacted copy of the database.
  // This is a read operation on the source DB — safe to run while
  // the daemon is operating. The destination file is written atomically.
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  logger.info({ backupPath }, 'Database backup created');

  // Prune old backups beyond the retention count
  const files = await readdir(BACKUPS_DIR);
  const backupFiles = files
    .filter((f) => f.startsWith('tasks-') && f.endsWith('.db'))
    .sort()
    .reverse(); // newest first

  const maxBackups = config.retention.backup_count;
  if (backupFiles.length > maxBackups) {
    const toDelete = backupFiles.slice(maxBackups);
    for (const file of toDelete) {
      await unlink(join(BACKUPS_DIR, file));
      logger.info({ file }, 'Old backup deleted');
    }
  }
}

/**
 * Retention cleanup: delete old transcripts and log files.
 * - Transcripts older than config.retention.transcript_days
 * - Logs older than config.retention.log_days
 */
async function runRetentionCleanup(config: Config, logger: Logger): Promise<void> {
  const now = Date.now();
  let deletedTranscripts = 0;
  let deletedLogs = 0;

  // Clean transcripts
  const transcriptMaxAge = config.retention.transcript_days * 24 * 60 * 60 * 1000;
  try {
    const files = await readdir(RUNS_DIR);
    for (const file of files) {
      if (!file.endsWith('.log') && !file.endsWith('.json')) continue;
      try {
        const fileStat = await stat(join(RUNS_DIR, file));
        if (now - fileStat.mtimeMs > transcriptMaxAge) {
          await unlink(join(RUNS_DIR, file));
          deletedTranscripts++;
        }
      } catch {
        // File may have been deleted by another process
      }
    }
  } catch {
    // RUNS_DIR doesn't exist — nothing to clean
  }

  // Clean old log files
  const logMaxAge = config.retention.log_days * 24 * 60 * 60 * 1000;
  try {
    const files = await readdir(LOGS_DIR);
    for (const file of files) {
      if (!file.endsWith('.log')) continue;
      try {
        const fileStat = await stat(join(LOGS_DIR, file));
        if (now - fileStat.mtimeMs > logMaxAge) {
          await unlink(join(LOGS_DIR, file));
          deletedLogs++;
        }
      } catch {
        // File may have been deleted by another process
      }
    }
  } catch {
    // LOGS_DIR doesn't exist — nothing to clean
  }

  if (deletedTranscripts > 0 || deletedLogs > 0) {
    logger.info({ deletedTranscripts, deletedLogs }, 'Retention cleanup complete');
  }
}
