import type { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import { api } from '../api-client.js';

interface Project {
  id: string;
  name: string;
  path: string;
  project_type_id: string;
  status: string;
  created_at: number;
  updated_at: number;
}

interface DiscoveryResult {
  discovered: Array<{ path: string; name: string }>;
  registered: number;
  missing: number;
}

export function registerProjectCommands(program: Command): void {
  const projects = program
    .command('projects')
    .description('Manage projects');

  // dispatch projects list
  projects
    .command('list')
    .description('List all registered projects')
    .option('--status <status>', 'Filter by status (active, dormant, missing, archived)')
    .action(async (opts: { status?: string }) => {
      const query = opts.status ? `?status=${opts.status}` : '';
      const data = await api.get<Project[]>(`/api/projects${query}`);

      if (data.length === 0) {
        console.log(chalk.dim('No projects found.'));
        return;
      }

      const table = new Table({
        head: ['Name', 'Type', 'Status', 'Path'],
        style: { head: ['cyan'] },
      });

      for (const p of data) {
        const statusColor = p.status === 'active' ? chalk.green : p.status === 'missing' ? chalk.red : chalk.dim;
        table.push([p.name, p.project_type_id, statusColor(p.status), chalk.dim(p.path)]);
      }

      console.log(table.toString());
    });

  // dispatch projects show <id>
  projects
    .command('show <id>')
    .description('Show project details')
    .action(async (id: string) => {
      const p = await api.get<Project>(`/api/projects/${id}`);
      console.log(chalk.bold(p.name));
      console.log(`  Type: ${p.project_type_id}`);
      console.log(`  Status: ${p.status}`);
      console.log(`  Path: ${p.path}`);
      console.log(`  ID: ${chalk.dim(p.id)}`);
    });

  // dispatch projects register <path> --type <type>
  projects
    .command('register <path>')
    .description('Register a project folder')
    .requiredOption('--type <type>', 'Project type ID (e.g., software-dev)')
    .option('--name <name>', 'Display name (defaults to folder basename)')
    .action(async (path: string, opts: { type: string; name?: string }) => {
      const name = opts.name ?? path.split('/').pop() ?? path;
      const p = await api.post<Project>('/api/projects', {
        name,
        path,
        project_type_id: opts.type,
      });
      console.log(chalk.green(`Project registered: ${p.name} (${p.id})`));
    });

  // dispatch projects discover — show unregistered folders
  projects
    .command('discover')
    .description('Show folders discovered but not yet registered')
    .action(async () => {
      const result = await api.get<DiscoveryResult>('/api/discovery');
      if (result.discovered.length === 0) {
        console.log(chalk.dim('No unregistered folders found.'));
        console.log(chalk.dim(`(${result.registered} registered, ${result.missing} missing)`));
        return;
      }

      const table = new Table({
        head: ['Name', 'Path'],
        style: { head: ['cyan'] },
      });

      for (const d of result.discovered) {
        table.push([d.name, chalk.dim(d.path)]);
      }

      console.log(table.toString());
      console.log(chalk.dim(`\nRegister with: dispatch projects register <path> --type <type-id>`));
    });

  // dispatch projects archive <id>
  projects
    .command('archive <id>')
    .description('Archive a project (soft-delete)')
    .action(async (id: string) => {
      await api.delete(`/api/projects/${id}`);
      console.log(chalk.yellow(`Project archived.`));
    });

  // dispatch wake [project-id]
  program
    .command('wake [project-id]')
    .description('Reset heartbeat — triggers immediate agent check')
    .action(async (projectId?: string) => {
      if (projectId) {
        await api.post(`/api/projects/${projectId}/wake`);
        console.log(chalk.green(`Heartbeat reset for project ${projectId}`));
      } else {
        // Wake all active projects
        const projects = await api.get<Project[]>('/api/projects');
        for (const p of projects) {
          if (p.status === 'active') {
            await api.post(`/api/projects/${p.id}/wake`);
          }
        }
        console.log(chalk.green(`Heartbeat reset for ${projects.filter((p) => p.status === 'active').length} active projects`));
      }
    });
}
