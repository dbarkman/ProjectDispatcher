import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { runUninstall } from '../../commands/uninstall.js';

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

export function registerUninstallCommands(program: Command): void {
  program
    .command('uninstall')
    .description('Uninstall Project Dispatcher (stop service, remove files)')
    .option('--yes', 'Skip confirmation prompt')
    .option('--delete-data', 'Also delete the data directory (~/Development/.tasks)')
    .action(async (opts: { yes?: boolean; deleteData?: boolean }) => {
      if (!opts.yes) {
        const ok = await confirm('Uninstall Project Dispatcher? This will stop the daemon and remove the service. [y/N] ');
        if (!ok) {
          console.log('Aborted.');
          return;
        }
      }

      let deleteData = opts.deleteData ?? false;
      if (deleteData && !opts.yes) {
        const ok = await confirm('Also delete ALL data in ~/Development/.tasks/? This cannot be undone. [y/N] ');
        if (!ok) {
          deleteData = false;
        }
      }

      await runUninstall(deleteData);
    });
}
