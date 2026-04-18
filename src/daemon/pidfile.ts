// PID file management — writes the daemon's PID to
// ~/Development/.tasks/daemon.pid on startup, removes it on shutdown.
// Used by the CLI to check if the daemon is running without making
// an HTTP request. (Gap fix #14)

import { writeFile, unlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_TASKS_DIR } from '../db/index.js';

const PID_PATH = join(DEFAULT_TASKS_DIR, 'daemon.pid');

/**
 * Write the current process PID to the PID file.
 * Called at daemon startup after the HTTP server binds.
 */
export async function writePidFile(): Promise<void> {
  await writeFile(PID_PATH, String(process.pid), 'utf8');
}

/**
 * Remove the PID file. Called during graceful shutdown.
 */
export async function removePidFile(): Promise<void> {
  try {
    await unlink(PID_PATH);
  } catch {
    // May not exist — that's fine
  }
}

export function readPidFile(pidFilePath: string = PID_PATH): number | null {
  try {
    if (!existsSync(pidFilePath)) return null;
    const content = readFileSync(pidFilePath, 'utf8').trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

export function isDaemonRunning(pidFilePath?: string): { running: boolean; pid: number | null } {
  const pid = readPidFile(pidFilePath);
  if (pid === null) return { running: false, pid: null };
  return { running: isProcessAlive(pid), pid };
}

export { PID_PATH };
