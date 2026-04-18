import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Platform } from './platform/detect.js';

const execFileAsync = promisify(execFile);

const PLIST_NAME = 'com.projectdispatcher.daemon';

export interface InstallerFlags {
  noBrowser: boolean;
}

export function parseInstallerFlags(argv: string[]): InstallerFlags {
  return {
    noBrowser:
      argv.includes('--no-browser') ||
      process.env['DISPATCH_NO_BROWSER'] === '1',
  };
}

export function manualStartHint(plat: Platform): string {
  switch (plat) {
    case 'macos':
      return 'dispatch daemon start';
    case 'linux':
      return 'dispatch daemon start';
    case 'windows':
      return 'node dist/daemon/index.js';
    default:
      return 'node dist/daemon/index.js';
  }
}

export function parseLaunchctlPid(stdout: string): number | null {
  const match = /pid\s*=\s*(\d+)/.exec(stdout);
  return match ? parseInt(match[1]!, 10) : null;
}

export function parseSystemdPid(stdout: string): number | null {
  const match = /MainPID=(\d+)/.exec(stdout);
  const pid = match ? parseInt(match[1]!, 10) : null;
  return pid && pid > 0 ? pid : null;
}

export async function getServicePid(plat: Platform): Promise<number | null> {
  try {
    if (plat === 'macos') {
      const uid = process.getuid?.()?.toString() ?? '501';
      const { stdout } = await execFileAsync('launchctl', [
        'print',
        `gui/${uid}/${PLIST_NAME}`,
      ]);
      return parseLaunchctlPid(stdout);
    }
    if (plat === 'linux') {
      const { stdout } = await execFileAsync('systemctl', [
        'show',
        '--user',
        '--property=MainPID',
        'projectdispatcher',
      ]);
      return parseSystemdPid(stdout);
    }
  } catch {
    return null;
  }
  return null;
}
