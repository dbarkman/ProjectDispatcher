import type { Command } from 'commander';
import { runUpdate } from '../../commands/update.js';

export function registerUpdateCommands(program: Command): void {
  program
    .command('update')
    .description('Check for newer versions of Project Dispatcher')
    .action(async () => {
      await runUpdate();
    });
}
