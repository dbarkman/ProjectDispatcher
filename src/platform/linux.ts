// Linux platform integration — systemd user unit for the daemon service.

import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

const UNIT_NAME = 'projectdispatcher';
const UNIT_DIR = join(homedir(), '.config', 'systemd', 'user');
const UNIT_PATH = join(UNIT_DIR, `${UNIT_NAME}.service`);

export interface ServiceConfig {
  daemonEntryPath: string;
  nodePath: string;
  logsDir: string;
  workingDir: string;
}

export function buildUnit(config: ServiceConfig): string {
  return `[Unit]
Description=Project Dispatcher Daemon
After=network.target

[Service]
ExecStart="${config.nodePath}" "${config.daemonEntryPath}"
Restart=on-failure
RestartSec=5
WorkingDirectory=${config.workingDir}
StandardOutput=append:${join(config.logsDir, 'daemon-stdout.log')}
StandardError=append:${join(config.logsDir, 'daemon-stderr.log')}
Environment=NODE_ENV=production
Environment=HOME=${homedir()}

[Install]
WantedBy=default.target
`;
}

export async function installService(config: ServiceConfig): Promise<void> {
  await mkdir(UNIT_DIR, { recursive: true });
  await mkdir(config.logsDir, { recursive: true });
  await writeFile(UNIT_PATH, buildUnit(config), 'utf8');
  await execFileAsync('systemctl', ['--user', 'daemon-reload']);
  await execFileAsync('systemctl', ['--user', 'enable', '--now', UNIT_NAME]);
}

export async function uninstallService(): Promise<void> {
  try {
    await execFileAsync('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
  } catch {
    // May not be enabled
  }
  try {
    await unlink(UNIT_PATH);
    await execFileAsync('systemctl', ['--user', 'daemon-reload']);
  } catch {
    // May not exist
  }
}

export async function startService(): Promise<void> {
  await execFileAsync('systemctl', ['--user', 'start', UNIT_NAME]);
}

export async function stopService(): Promise<void> {
  await execFileAsync('systemctl', ['--user', 'stop', UNIT_NAME]);
}

export async function getServiceStatus(): Promise<'running' | 'stopped' | 'not-installed'> {
  try {
    const { stdout } = await execFileAsync('systemctl', ['--user', 'is-active', UNIT_NAME]);
    if (stdout.trim() === 'active') return 'running';
    return 'stopped';
  } catch {
    return 'not-installed';
  }
}
