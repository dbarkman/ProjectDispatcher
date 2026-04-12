import type { Command } from 'commander';
import chalk from 'chalk';
import { api } from '../api-client.js';

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
