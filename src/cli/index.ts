#!/usr/bin/env node
// CLI entry point for Project Dispatcher (`dispatch` command).
//
// Commands:
//   dispatch projects list       — list all projects
//   dispatch projects register   — register a folder
//   dispatch wake [project]      — reset heartbeat
//   dispatch ticket new          — create a ticket
//   dispatch ticket list         — list tickets
//   dispatch ticket show <id>    — show ticket detail
//   dispatch ticket comment      — add a comment
//   dispatch ticket move         — move to a column
//   dispatch inbox               — shortcut for human-column tickets
//   dispatch daemon status       — daemon health check
//   dispatch update              — check for newer versions
//   dispatch uninstall           — remove service + optionally data

import { Command } from 'commander';
import { registerProjectCommands } from './commands/projects.js';
import { registerTicketCommands } from './commands/tickets.js';
import { registerDaemonCommands } from './commands/daemon.js';
import { registerUpdateCommands } from './commands/update.js';
import { registerUninstallCommands } from './commands/uninstall.js';

const program = new Command();

program
  .name('dispatch')
  .description('Project Dispatcher — async ticket-based orchestration for AI agents')
  .version('0.0.1');

registerProjectCommands(program);
registerTicketCommands(program);
registerDaemonCommands(program);
registerUpdateCommands(program);
registerUninstallCommands(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
