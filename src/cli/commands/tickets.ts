import type { Command } from 'commander';
import Table from 'cli-table3';
import chalk from 'chalk';
import { api } from '../api-client.js';

interface Ticket {
  id: string;
  project_id: string;
  title: string;
  body: string | null;
  column: string;
  priority: string;
  tags: string | null;
  claimed_by_run_id: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface TicketComment {
  id: string;
  type: string;
  author: string;
  body: string | null;
  meta: string | null;
  created_at: number;
}

interface TicketWithComments extends Ticket {
  comments: TicketComment[];
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function priorityColor(priority: string): string {
  switch (priority) {
    case 'urgent': return chalk.red(priority);
    case 'high': return chalk.yellow(priority);
    case 'normal': return chalk.white(priority);
    case 'low': return chalk.dim(priority);
    default: return priority;
  }
}

function commentTypeColor(type: string): string {
  switch (type) {
    case 'finding': return chalk.red(`[${type}]`);
    case 'block': return chalk.yellow(`[${type}]`);
    case 'complete': return chalk.green(`[${type}]`);
    case 'move': return chalk.cyan(`[${type}]`);
    case 'journal': return chalk.dim(`[${type}]`);
    default: return chalk.white(`[${type}]`);
  }
}

export function registerTicketCommands(program: Command): void {
  const ticket = program
    .command('ticket')
    .description('Manage tickets');

  // dispatch ticket list
  ticket
    .command('list')
    .description('List tickets')
    .option('--project <id>', 'Filter by project ID')
    .option('--column <column>', 'Filter by column')
    .option('--priority <priority>', 'Filter by priority')
    .action(async (opts: { project?: string; column?: string; priority?: string }) => {
      const params = new URLSearchParams();
      if (opts.project) params.set('project', opts.project);
      if (opts.column) params.set('column', opts.column);
      if (opts.priority) params.set('priority', opts.priority);
      const query = params.toString() ? `?${params.toString()}` : '';

      const data = await api.get<Ticket[]>(`/api/tickets${query}`);

      if (data.length === 0) {
        console.log(chalk.dim('No tickets found.'));
        return;
      }

      const table = new Table({
        head: ['ID', 'Title', 'Column', 'Priority', 'Age'],
        style: { head: ['cyan'] },
        colWidths: [10, 40, 18, 10, 10],
      });

      for (const t of data) {
        table.push([
          chalk.dim(shortId(t.id)),
          t.title.length > 37 ? t.title.slice(0, 37) + '...' : t.title,
          t.column,
          priorityColor(t.priority),
          relativeTime(t.updated_at),
        ]);
      }

      console.log(table.toString());
    });

  // dispatch ticket show <id>
  ticket
    .command('show <id>')
    .description('Show ticket detail with full comment thread')
    .action(async (id: string) => {
      const t = await api.get<TicketWithComments>(`/api/tickets/${id}`);

      console.log(chalk.bold(t.title));
      console.log(`  Column: ${t.column} | Priority: ${priorityColor(t.priority)} | Created: ${relativeTime(t.created_at)}`);
      console.log(`  Project: ${chalk.dim(t.project_id)} | ID: ${chalk.dim(t.id)}`);
      if (t.body) {
        console.log(`\n${t.body}`);
      }
      if (t.claimed_by_run_id) {
        console.log(chalk.yellow(`\n  Claimed by run: ${shortId(t.claimed_by_run_id)}`));
      }

      if (t.comments.length > 0) {
        console.log(chalk.dim('\n--- Thread ---\n'));
        for (const c of t.comments) {
          const time = relativeTime(c.created_at);
          console.log(`${commentTypeColor(c.type)} ${chalk.bold(c.author)} ${chalk.dim(time)}`);
          if (c.body) {
            const lines = c.body.split('\n');
            for (const line of lines) {
              console.log(`  ${line}`);
            }
          }
          console.log('');
        }
      }
    });

  // dispatch ticket new --project <id> --title "..." [--body "..."] [--column <col>]
  ticket
    .command('new')
    .description('Create a new ticket')
    .requiredOption('--project <id>', 'Project ID')
    .requiredOption('--title <title>', 'Ticket title')
    .option('--body <body>', 'Ticket body/description')
    .option('--column <column>', 'Initial column (default: human)')
    .option('--priority <priority>', 'Priority: low, normal, high, urgent')
    .action(async (opts: { project: string; title: string; body?: string; column?: string; priority?: string }) => {
      const t = await api.post<Ticket>('/api/tickets', {
        project_id: opts.project,
        title: opts.title,
        body: opts.body,
        column: opts.column,
        priority: opts.priority,
      });
      console.log(chalk.green(`Ticket created: ${shortId(t.id)} "${t.title}" in column ${t.column}`));
    });

  // dispatch ticket comment <id> <text>
  ticket
    .command('comment <id> <text>')
    .description('Add a comment to a ticket')
    .option('--type <type>', 'Comment type (default: comment)')
    .action(async (id: string, text: string, opts: { type?: string }) => {
      await api.post(`/api/tickets/${id}/comments`, {
        type: opts.type ?? 'comment',
        author: 'human',
        body: text,
      });
      console.log(chalk.green('Comment added.'));
    });

  // dispatch ticket move <id> <column>
  ticket
    .command('move <id> <column>')
    .description('Move a ticket to a different column')
    .option('--comment <text>', 'Add a comment with the move')
    .action(async (id: string, column: string, opts: { comment?: string }) => {
      await api.post(`/api/tickets/${id}/move`, {
        to_column: column,
        comment: opts.comment,
        author: 'human',
      });
      console.log(chalk.green(`Ticket moved to '${column}'.`));
    });

  // dispatch inbox — shortcut for human-column tickets
  program
    .command('inbox')
    .description('Show all tickets in human columns (your inbox)')
    .action(async () => {
      const data = await api.get<Ticket[]>('/api/tickets?column=human');

      if (data.length === 0) {
        console.log(chalk.green('Inbox is empty — all clear!'));
        return;
      }

      console.log(chalk.bold(`Inbox: ${data.length} ticket(s) waiting\n`));

      const table = new Table({
        head: ['ID', 'Title', 'Priority', 'Age'],
        style: { head: ['cyan'] },
        colWidths: [10, 50, 10, 10],
      });

      for (const t of data) {
        table.push([
          chalk.dim(shortId(t.id)),
          t.title.length > 47 ? t.title.slice(0, 47) + '...' : t.title,
          priorityColor(t.priority),
          relativeTime(t.updated_at),
        ]);
      }

      console.log(table.toString());
    });
}
