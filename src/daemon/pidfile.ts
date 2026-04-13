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

/**
 * Read the PID from the file. Returns null if the file doesn't exist
 * or the content is not a valid number.
 */
export function readPidFile(): number | null {
  try {
    if (!existsSync(PID_PATH)) return null;
    const content = readFileSync(PID_PATH, 'utf8').trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Check if the daemon process is running by reading the PID file
 * and sending signal 0 (existence check, no actual signal).
 */
export function isDaemonRunning(): boolean {
  const pid = readPidFile();
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export { PID_PATH };
