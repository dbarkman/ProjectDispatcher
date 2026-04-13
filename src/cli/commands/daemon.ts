import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import chalk from 'chalk';
import { api } from '../api-client.js';
import { DEFAULT_TASKS_DIR } from '../../db/index.js';

const execFileAsync = promisify(execFile);

interface HealthResponse {
  status: string;
  uptime_seconds: number;
  database: string;
  port: number;
}

export function registerDaemonCommands(program: Command): void {
  const daemon = program
    .command('daemon')
    .description('Manage the dispatch daemon');

  // dispatch daemon status
  daemon
    .command('status')
    .description('Check if the daemon is running')
    .action(async () => {
      try {
        const health = await api.get<HealthResponse>('/api/health');
        console.log(chalk.green('Daemon is running'));
        console.log(`  Status: ${health.status}`);
        console.log(`  Uptime: ${formatUptime(health.uptime_seconds)}`);
        console.log(`  Database: ${health.database}`);
        console.log(`  Port: ${health.port}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not running') || msg.includes('ECONNREFUSED')) {
          console.log(chalk.red('Daemon is not running.'));
          console.log(chalk.dim('Start it with: npm run dev'));
        } else {
          throw err;
        }
      }
    });

  // dispatch daemon start (Gap fix #9)
  daemon
    .command('start')
    .description('Start the daemon service')
    .action(async () => {
      try {
        const os = platform();
        if (os === 'darwin') {
          await execFileAsync('launchctl', ['start', 'com.projectdispatcher.daemon']);
        } else if (os === 'linux') {
          await execFileAsync('systemctl', ['--user', 'start', 'projectdispatcher']);
        } else {
          console.log(chalk.yellow('Service management not supported on this platform.'));
          console.log(chalk.dim('Start manually with: npm run dev'));
          return;
        }
        console.log(chalk.green('Daemon started.'));
      } catch (err) {
        console.error(chalk.red(`Failed to start: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // dispatch daemon stop
  daemon
    .command('stop')
    .description('Stop the daemon service')
    .action(async () => {
      try {
        const os = platform();
        if (os === 'darwin') {
          await execFileAsync('launchctl', ['stop', 'com.projectdispatcher.daemon']);
        } else if (os === 'linux') {
          await execFileAsync('systemctl', ['--user', 'stop', 'projectdispatcher']);
        } else {
          console.log(chalk.yellow('Service management not supported on this platform.'));
          return;
        }
        console.log(chalk.green('Daemon stopped.'));
      } catch (err) {
        console.error(chalk.red(`Failed to stop: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // dispatch daemon restart
  daemon
    .command('restart')
    .description('Restart the daemon service')
    .action(async () => {
      try {
        const os = platform();
        if (os === 'darwin') {
          await execFileAsync('launchctl', ['stop', 'com.projectdispatcher.daemon']);
          await execFileAsync('launchctl', ['start', 'com.projectdispatcher.daemon']);
        } else if (os === 'linux') {
          await execFileAsync('systemctl', ['--user', 'restart', 'projectdispatcher']);
        } else {
          console.log(chalk.yellow('Service management not supported on this platform.'));
          return;
        }
        console.log(chalk.green('Daemon restarted.'));
      } catch (err) {
        console.error(chalk.red(`Failed to restart: ${err instanceof Error ? err.message : String(err)}`));
      }
    });

  // dispatch daemon logs
  daemon
    .command('logs')
    .description('Show recent daemon logs')
    .option('-f, --follow', 'Follow the log in real-time')
    .option('-n, --lines <n>', 'Number of lines to show', '50')
    .action(async (opts: { follow?: boolean; lines: string }) => {
      const today = new Date().toISOString().slice(0, 10);
      const logPath = join(DEFAULT_TASKS_DIR, 'logs', `daemon-${today}.log`);

      if (opts.follow) {
        // Use tail -f for real-time following
        const { spawn } = await import('node:child_process');
        console.log(chalk.dim(`Following ${logPath} (Ctrl+C to stop)\n`));
        const child = spawn('tail', ['-f', '-n', opts.lines, logPath], { stdio: 'inherit' });
        child.on('error', () => {
          console.error(chalk.red(`Log file not found: ${logPath}`));
        });
      } else {
        try {
          const content = await readFile(logPath, 'utf8');
          const lines = content.trim().split('\n');
          const n = parseInt(opts.lines, 10) || 50;
          const tail = lines.slice(-n);
          console.log(tail.join('\n'));
        } catch {
          console.log(chalk.dim(`No log file found at ${logPath}`));
        }
      }
    });

  // dispatch board [project-id] — open UI in browser (Gap fix #11)
  program
    .command('board [project-id]')
    .description('Open the web UI in your browser')
    .action(async (projectId?: string) => {
      const url = projectId
        ? `http://127.0.0.1:5757/ui/projects/${projectId}`
        : 'http://127.0.0.1:5757';

      const os = platform();
      try {
        if (os === 'darwin') {
          await execFileAsync('open', [url]);
        } else if (os === 'linux') {
          await execFileAsync('xdg-open', [url]);
        } else if (os === 'win32') {
          await execFileAsync('cmd', ['/c', 'start', url]);
        } else {
          console.log(`Open in your browser: ${chalk.cyan(url)}`);
          return;
        }
        console.log(chalk.green(`Opened ${url}`));
      } catch {
        console.log(`Open in your browser: ${chalk.cyan(url)}`);
      }
    });
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ${seconds % 60}s`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
