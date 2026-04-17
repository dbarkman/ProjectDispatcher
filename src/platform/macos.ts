// macOS platform integration — LaunchAgent for the daemon service.

import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

const PLIST_NAME = 'com.projectdispatcher.daemon';
const PLIST_DIR = join(homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = join(PLIST_DIR, `${PLIST_NAME}.plist`);

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface ServiceConfig {
  daemonEntryPath: string; // Absolute path to dist/daemon/index.js
  nodePath: string; // Absolute path to node binary
  logsDir: string;
  workingDir: string;
}

export function buildPlist(config: ServiceConfig): string {
  const esc = xmlEscape;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(PLIST_NAME)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(config.nodePath)}</string>
    <string>${esc(config.daemonEntryPath)}</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${esc(config.workingDir)}</string>
  <key>StandardOutPath</key>
  <string>${esc(join(config.logsDir, 'daemon-stdout.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(join(config.logsDir, 'daemon-stderr.log'))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${esc(process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin')}</string>
    <key>HOME</key>
    <string>${esc(homedir())}</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
</dict>
</plist>`;
}

export async function installService(config: ServiceConfig): Promise<void> {
  await mkdir(PLIST_DIR, { recursive: true });
  await mkdir(config.logsDir, { recursive: true });
  await writeFile(PLIST_PATH, buildPlist(config), 'utf8');

  const uid = process.getuid?.()?.toString() ?? '501';
  await execFileAsync('launchctl', ['bootstrap', `gui/${uid}`, PLIST_PATH]);
}

export async function uninstallService(): Promise<void> {
  try {
    const uid = process.getuid?.()?.toString() ?? '501';
    await execFileAsync('launchctl', ['bootout', `gui/${uid}`, PLIST_PATH]);
  } catch {
    // May already be unloaded
  }
  try {
    await unlink(PLIST_PATH);
  } catch {
    // May not exist
  }
}

export async function startService(): Promise<void> {
  await execFileAsync('launchctl', ['start', PLIST_NAME]);
}

export async function stopService(): Promise<void> {
  await execFileAsync('launchctl', ['stop', PLIST_NAME]);
}

export async function restartService(): Promise<void> {
  const uid = process.getuid?.()?.toString() ?? '501';
  await execFileAsync('launchctl', ['kickstart', '-k', `gui/${uid}/${PLIST_NAME}`]);
}

export async function getServiceStatus(): Promise<'running' | 'stopped' | 'not-installed'> {
  try {
    const { stdout } = await execFileAsync('launchctl', ['list', PLIST_NAME]);
    if (/"PID"\s*=/.test(stdout)) return 'running';
    return 'stopped';
  } catch {
    return 'not-installed';
  }
}
