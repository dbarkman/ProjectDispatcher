// dispatch uninstall — removes the daemon service and optionally deletes data.

import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import chalk from 'chalk';
import { DEFAULT_TASKS_DIR } from '../db/index.js';
import { detectPlatform } from '../platform/detect.js';

export async function runUninstall(deleteData: boolean): Promise<void> {
  console.log(chalk.cyan('\nUninstalling Project Dispatcher...\n'));

  // 1. Stop + uninstall the service
  const platform = detectPlatform();
  try {
    if (platform === 'macos') {
      const { uninstallService } = await import('../platform/macos.js');
      await uninstallService();
      console.log(chalk.green('  LaunchAgent removed'));
    } else if (platform === 'linux') {
      const { uninstallService } = await import('../platform/linux.js');
      await uninstallService();
      console.log(chalk.green('  systemd user unit removed'));
    } else if (platform === 'windows') {
      const { uninstallService } = await import('../platform/windows.js');
      await uninstallService();
    } else {
      console.log(chalk.dim('  No service to remove on this platform'));
    }
  } catch (err) {
    console.log(chalk.yellow(`  Service removal: ${err instanceof Error ? err.message : String(err)}`));
  }

  // 2. Optionally delete the data directory
  if (deleteData) {
    if (existsSync(DEFAULT_TASKS_DIR)) {
      await rm(DEFAULT_TASKS_DIR, { recursive: true, force: true });
      console.log(chalk.red(`  Data directory deleted: ${DEFAULT_TASKS_DIR}`));
    }
  } else {
    console.log(chalk.dim(`  Data preserved at: ${DEFAULT_TASKS_DIR}`));
    console.log(chalk.dim('  Delete manually with: rm -rf ~/Development/.tasks'));
  }

  console.log(chalk.green('\n  Uninstall complete. Goodbye!\n'));
}
