import pino, { type Logger } from 'pino';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type { Logger } from 'pino';

/**
 * Create a Pino logger configured for dispatch.
 *
 * - **Development** (`NODE_ENV !== 'production'`): pretty-printed output
 *   to stdout via `pino-pretty`, debug level. Human-readable during
 *   development work.
 * - **Production**: structured JSON written to a daily-named file at
 *   `<logsDir>/daemon-YYYY-MM-DD.log`, info level. The daily filename
 *   is the rotation strategy; cleanup of old files is the retention
 *   job's responsibility (MVP-34), not this module's.
 *
 * Callers own the logger's lifetime — same pattern as `openDatabase()`
 * and `loadConfig()`. The daemon (MVP-06) will create one logger at
 * startup and use `logger.child({...})` for contextual logging.
 *
 * Writes are synchronous in production: at our expected log volume
 * (a handful of events per minute, maybe dozens during an agent run)
 * the cost of async buffering plus flush-on-exit is worse than direct
 * sync writes. Keeps shutdown simple and tests deterministic.
 */
export function createLogger(logsDir: string): Logger {
  const isDev = process.env.NODE_ENV !== 'production';

  if (isDev) {
    return pino({
      level: 'debug',
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      },
    });
  }

  mkdirSync(logsDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const logPath = join(logsDir, `daemon-${today}.log`);

  return pino(
    {
      level: 'info',
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination({
      dest: logPath,
      sync: true,
      mkdir: true,
    }),
  );
}
