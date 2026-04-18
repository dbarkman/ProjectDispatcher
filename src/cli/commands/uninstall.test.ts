import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerUninstallCommands } from './uninstall.js';

describe('registerUninstallCommands', () => {
  it('registers uninstall command on program', () => {
    const program = new Command();
    registerUninstallCommands(program);
    const cmd = program.commands.find((c) => c.name() === 'uninstall');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toBe('Uninstall Project Dispatcher (stop service, remove files)');
  });

  it('has --yes and --delete-data options', () => {
    const program = new Command();
    registerUninstallCommands(program);
    const cmd = program.commands.find((c) => c.name() === 'uninstall')!;
    const opts = cmd.options.map((o) => o.long);
    expect(opts).toContain('--yes');
    expect(opts).toContain('--delete-data');
  });
});
