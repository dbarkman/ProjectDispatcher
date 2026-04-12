// dispatch update — checks for newer versions and applies them.
//
// For MVP this is a simple version check + npm install flow.
// Post-MVP: automatic migration running + daemon restart.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';

const execFileAsync = promisify(execFile);

const PACKAGE_NAME = 'projectdispatcher';

export async function runUpdate(): Promise<void> {
  console.log(chalk.cyan('Checking for updates...'));

  // Get installed version
  const pkg = await import('../../package.json', { with: { type: 'json' } });
  const installedVersion = (pkg.default as { version: string }).version;
  console.log(`  Installed: ${installedVersion}`);

  // Check npm for latest
  try {
    const { stdout } = await execFileAsync('npm', ['view', PACKAGE_NAME, 'version']);
    const latestVersion = stdout.trim();
    console.log(`  Latest:    ${latestVersion}`);

    if (latestVersion === installedVersion) {
      console.log(chalk.green('\n  Already up to date!'));
      return;
    }

    console.log(chalk.yellow(`\n  Update available: ${installedVersion} → ${latestVersion}`));
    console.log(chalk.dim(`  Run: npm install -g ${PACKAGE_NAME}@latest`));
    console.log(chalk.dim('  Then restart the daemon to apply migrations.'));
  } catch {
    console.log(chalk.yellow('  Could not check npm registry (are you offline?)'));
  }
}
