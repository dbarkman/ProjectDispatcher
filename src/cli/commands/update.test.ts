import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { registerUpdateCommands } from './update.js';

describe('registerUpdateCommands', () => {
  it('registers update command on program', () => {
    const program = new Command();
    registerUpdateCommands(program);
    const cmd = program.commands.find((c) => c.name() === 'update');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toBe('Check for newer versions of Project Dispatcher');
  });
});
