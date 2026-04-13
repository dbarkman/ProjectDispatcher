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
//   7. Wait for daemon to become healthy
//   8. Run auto-discovery
//   9. Print success + next steps

import { existsSync } from 'node:fs';
import { mkdir, writeFile, copyFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import chalk from 'chalk';
import { DEFAULT_TASKS_DIR, DEFAULT_DB_PATH } from './db/index.js';
import { openDatabase } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { seedBuiltins } from './db/seed.js';
import { configSchema } from './config.schema.js';
import { detectPlatform } from './platform/detect.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const PROMPTS_SRC = resolve(join(__dirname, 'prompts', 'defaults'));
const PROMPTS_DEST = join(DEFAULT_TASKS_DIR, 'prompts');
const CONFIG_PATH = join(DEFAULT_TASKS_DIR, 'config.json');
const LOGS_DIR = join(DEFAULT_TASKS_DIR, 'logs');
const ARTIFACTS_DIR = join(DEFAULT_TASKS_DIR, 'artifacts', 'runs');

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
    console.log(chalk.yellow(`  Service install failed: ${err instanceof Error ? err.message : String(err)}`));
    console.log(chalk.dim('  Start the daemon manually with: npm run dev'));
  }

  // 7. Wait for daemon health (Gap fix #15)
  console.log(chalk.cyan('\nWaiting for daemon to become healthy...'));

  let healthy = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch(`http://127.0.0.1:${5757}/api/health`);
      if (res.ok) {
        healthy = true;
        console.log(chalk.green('  Daemon is healthy!'));
        break;
      }
    } catch {
      process.stdout.write(chalk.dim('.'));
    }
  }
  if (!healthy) {
    console.log(chalk.yellow('\n  Daemon did not become healthy within 20 seconds.'));
    console.log(chalk.dim('  Start manually with: npm run dev'));
  }

  // 8. Open browser (Gap fix #16)
  if (healthy) {
    console.log(chalk.cyan('\nOpening the UI in your browser...'));
    const url = `http://127.0.0.1:${5757}`;
    try {
      const os = (await import('node:os')).platform();
      const { execFile: execF } = await import('node:child_process');
      const { promisify: prom } = await import('node:util');
      const execFA = prom(execF);
      if (os === 'darwin') await execFA('open', [url]);
      else if (os === 'linux') await execFA('xdg-open', [url]);
      else if (os === 'win32') await execFA('cmd', ['/c', 'start', url]);
      console.log(chalk.green(`  Opened ${url}`));
    } catch {
      console.log(`  Open in your browser: ${chalk.cyan(url)}`);
    }
  }

  // 9. Success
  console.log(chalk.bold.green('\n  Installation complete!\n'));
  console.log('  Next steps:');
  if (!healthy) {
    console.log(`    1. Start the daemon:  ${chalk.cyan('npm run dev')}`);
    console.log(`    2. Open the UI:       ${chalk.cyan('http://127.0.0.1:5757')}`);
  }
  console.log(`    ${healthy ? '1' : '3'}. Discover projects: ${chalk.cyan('dispatch projects discover')}`);
  console.log(`    ${healthy ? '2' : '4'}. Register a project: ${chalk.cyan('dispatch projects register <path> --type software-dev')}`);
  console.log(`    ${healthy ? '3' : '5'}. Create a ticket:   ${chalk.cyan('dispatch ticket new')}`);
  console.log('');
}

main().catch(async (err) => {
  console.error(chalk.red(`\nInstallation failed: ${err instanceof Error ? err.message : String(err)}`));

  // Rollback: attempt to remove the service and .tasks/ if we created them (Gap fix #17)
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
