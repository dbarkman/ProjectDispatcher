#!/usr/bin/env node
// Project Dispatcher installer.
//
// Run with: npx projectdispatcher install
// Or: node dist/install.js
//
// Flow:
//   1. Check prerequisites (Node 22+, claude CLI in PATH)
//   2. Create ~/.tasks/ directory structure
//   3. Initialize database + run migrations + seed builtins
//   4. Copy default prompt files
//   5. Write default config.json
//   6. Install platform service (LaunchAgent / systemd / Windows)
//   7. Wait for daemon to become healthy (with PID verification)
//   8. Auto-discover projects
//   9. Open browser (unless --no-browser or DISPATCH_NO_BROWSER=1)
//  10. Print success + next steps

import { existsSync } from 'node:fs';
import { mkdir, writeFile, copyFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform as osPlatform } from 'node:os';
import chalk from 'chalk';
import { DEFAULT_TASKS_DIR, DEFAULT_DB_PATH } from './db/index.js';
import { openDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { seedBuiltins } from './db/seed.js';
import { configSchema } from './config.schema.js';
import { detectPlatform } from './platform/detect.js';
import { parseInstallerFlags, manualStartHint, getServicePid } from './install-utils.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const PROMPTS_SRC = resolve(join(__dirname, 'prompts', 'defaults'));
const PROMPTS_DEST = join(DEFAULT_TASKS_DIR, 'prompts');
const CONFIG_PATH = join(DEFAULT_TASKS_DIR, 'config.json');
const LOGS_DIR = join(DEFAULT_TASKS_DIR, 'logs');
const ARTIFACTS_DIR = join(DEFAULT_TASKS_DIR, 'artifacts', 'runs');
const DEFAULT_PORT = 5757;

const flags = parseInstallerFlags(process.argv);

async function main(): Promise<void> {
  console.log(chalk.bold('\n  Project Dispatcher Installer\n'));

  // 1. Prerequisites
  console.log(chalk.cyan('Checking prerequisites...'));

  const nodeVersion = parseInt(process.versions.node.split('.')[0]!, 10);
  if (nodeVersion < 22) {
    console.error(chalk.red(`  Node.js 22+ required (found ${process.versions.node})`));
    process.exit(1);
  }
  console.log(chalk.green(`  Node.js ${process.versions.node}`));

  try {
    await execFileAsync('claude', ['--version']);
    console.log(chalk.green('  claude CLI found'));
  } catch {
    console.log(chalk.yellow('  claude CLI not found in PATH (agents will not run until installed)'));
  }

  // 2. Create directory structure
  console.log(chalk.cyan('\nCreating directory structure...'));

  const dirs = [DEFAULT_TASKS_DIR, PROMPTS_DEST, LOGS_DIR, ARTIFACTS_DIR];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    console.log(chalk.dim(`  ${dir}`));
  }

  // 3. Database
  console.log(chalk.cyan('\nInitializing database...'));

  const db = openDatabase(DEFAULT_DB_PATH);
  const migrations = runMigrations(db);
  console.log(chalk.green(`  Migrations applied: ${migrations.applied.length}`));

  const seed = seedBuiltins(db);
  const seedTotal = seed.projectTypesInserted + seed.agentTypesInserted + seed.projectTypeColumnsInserted;
  console.log(chalk.green(`  Seed data: ${seedTotal} rows`));
  db.close();

  // 4. Copy default prompts (preserving user edits)
  console.log(chalk.cyan('\nCopying default prompts...'));

  if (existsSync(PROMPTS_SRC)) {
    const promptFiles = await readdir(PROMPTS_SRC);
    let copied = 0;
    for (const file of promptFiles) {
      const dest = join(PROMPTS_DEST, file);
      if (!existsSync(dest)) {
        await copyFile(join(PROMPTS_SRC, file), dest);
        copied++;
      }
    }
    console.log(chalk.green(`  ${copied} prompt files copied (${promptFiles.length - copied} already existed)`));
  } else {
    console.log(chalk.yellow('  Default prompts not found — skipping'));
  }

  // 5. Config
  console.log(chalk.cyan('\nWriting config...'));

  const defaultConfig = configSchema.parse({}) as Record<string, unknown>;
  if (!existsSync(CONFIG_PATH)) {
    await writeFile(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2) + '\n', 'utf8');
    console.log(chalk.green(`  Default config written to ${CONFIG_PATH}`));
  } else {
    console.log(chalk.dim('  Config already exists — skipping'));
  }

  // 6. Platform service
  console.log(chalk.cyan('\nInstalling daemon service...'));

  const platform = detectPlatform();
  const daemonEntry = resolve(join(__dirname, 'daemon', 'index.js'));
  const nodePath = process.execPath;

  const serviceConfig = {
    daemonEntryPath: daemonEntry,
    nodePath,
    logsDir: LOGS_DIR,
    workingDir: DEFAULT_TASKS_DIR,
  };

  try {
    if (platform === 'macos') {
      const { installService } = await import('./platform/macos.js');
      await installService(serviceConfig);
      console.log(chalk.green('  LaunchAgent installed'));
    } else if (platform === 'linux') {
      const { installService } = await import('./platform/linux.js');
      await installService(serviceConfig);
      console.log(chalk.green('  systemd user unit installed'));
    } else if (platform === 'windows') {
      const { installService } = await import('./platform/windows.js');
      await installService(serviceConfig);
    } else {
      console.log(chalk.yellow(`  Unsupported platform (${platform}) — daemon must be started manually`));
    }
  } catch (err) {
    console.error(chalk.red(`  Service install failed: ${err instanceof Error ? err.message : String(err)}`));
    console.log(chalk.dim(`  Start the daemon manually with: ${manualStartHint(platform)}`));
    process.exit(1);
  }

  // 7. Wait for daemon health with PID verification
  console.log(chalk.cyan('\nWaiting for daemon to become healthy...'));

  let healthy = false;
  let sawPidMismatch = false;

  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/api/health`);
      if (res.ok) {
        const body = (await res.json()) as { pid?: number };
        const servicePid = await getServicePid(platform);
        if (
          servicePid !== null &&
          body.pid !== undefined &&
          body.pid !== servicePid
        ) {
          sawPidMismatch = true;
          process.stdout.write(chalk.dim('x'));
          continue;
        }
        healthy = true;
        console.log(chalk.green('  Daemon is healthy!'));
        break;
      }
    } catch {
      process.stdout.write(chalk.dim('.'));
    }
  }

  if (!healthy) {
    if (sawPidMismatch) {
      console.error(
        chalk.red('\n  Health check responded, but from a different process (PID mismatch).'),
      );
      console.error(
        chalk.red(`  Another process is occupying port ${DEFAULT_PORT}.`),
      );
      console.error(
        chalk.dim(`  Stop the other process, then run: ${manualStartHint(platform)}`),
      );
      process.exit(1);
    }
    console.log(chalk.yellow('\n  Daemon did not become healthy within 20 seconds.'));
    console.log(chalk.dim(`  Start manually with: ${manualStartHint(platform)}`));
  }

  // 8. Auto-discover projects
  if (healthy) {
    console.log(chalk.cyan('\nDiscovering projects...'));
    try {
      const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/api/discovery`);
      if (res.ok) {
        const data = (await res.json()) as {
          discovered: Array<{ path: string; name: string }>;
          registered: number;
        };
        if (data.discovered.length > 0) {
          for (const p of data.discovered) {
            console.log(chalk.dim(`  ${p.name} (${p.path})`));
          }
          console.log(
            chalk.dim(
              `\n  ${data.discovered.length} unregistered project(s) found. Register with:`,
            ),
          );
          console.log(chalk.dim('    dispatch projects register <path> --type software-dev'));
        } else {
          console.log(chalk.dim('  No new projects found'));
        }
        if (data.registered > 0) {
          console.log(chalk.green(`  ${data.registered} project(s) already registered`));
        }
      }
    } catch {
      console.log(chalk.dim('  Discovery skipped (could not reach daemon)'));
    }
  }

  // 9. Open browser (unless suppressed)
  if (healthy && !flags.noBrowser) {
    console.log(chalk.cyan('\nOpening the UI in your browser...'));
    const url = `http://127.0.0.1:${DEFAULT_PORT}`;
    try {
      const os = osPlatform();
      if (os === 'darwin') await execFileAsync('open', [url]);
      else if (os === 'linux') await execFileAsync('xdg-open', [url]);
      else if (os === 'win32') await execFileAsync('cmd', ['/c', 'start', url]);
      console.log(chalk.green(`  Opened ${url}`));
    } catch {
      console.log(`  Open in your browser: ${chalk.cyan(url)}`);
    }
  }

  // 10. Success
  console.log(chalk.bold.green('\n  Installation complete!\n'));
  console.log('  Next steps:\n');

  let step = 1;

  if (!healthy) {
    console.log(`    ${step}. Start the daemon:\n`);
    console.log(`         ${chalk.cyan(manualStartHint(platform))}\n`);
    step++;
  }

  console.log(`    ${step}. Install the ${chalk.cyan('dispatch')} CLI globally (optional but recommended):\n`);
  console.log(`         ${chalk.cyan('npm install -g projectdispatcher')}\n`);
  console.log(`       This puts ${chalk.cyan('dispatch')} on your PATH for project/ticket management`);
  console.log(`       and the ${chalk.cyan('dispatch uninstall')} command when you want to remove PD.\n`);
  step++;

  console.log(`    ${step}. Open the UI — ${healthy ? 'already opened in your browser at' : 'once the daemon is running, open'}:\n`);
  console.log(`         ${chalk.cyan(`http://127.0.0.1:${DEFAULT_PORT}`)}\n`);
  console.log('       Register projects, create tickets, and manage everything visually.\n');
  step++;

  console.log(`    ${step}. Or, once the CLI is installed:\n`);
  console.log(`         ${chalk.cyan('dispatch projects register <path> --type software-dev')}`);
  console.log(`         ${chalk.cyan('dispatch ticket new')}`);
  console.log('');
}

main().catch(async (err) => {
  console.error(chalk.red(`\nInstallation failed: ${err instanceof Error ? err.message : String(err)}`));

  console.error(chalk.dim('Attempting rollback...'));
  try {
    const platform = detectPlatform();
    if (platform === 'macos') {
      const { uninstallService } = await import('./platform/macos.js');
      await uninstallService();
    } else if (platform === 'linux') {
      const { uninstallService } = await import('./platform/linux.js');
      await uninstallService();
    }
  } catch {
    // Best-effort
  }
  console.error(chalk.dim(`Data directory preserved at: ${DEFAULT_TASKS_DIR}`));
  console.error(chalk.dim('Delete it manually if you want a clean slate: rm -rf ~/Development/.tasks'));
  process.exit(1);
});
