import { describe, it, expect } from 'vitest';
import { coerceTextareaArrays } from './config.js';

describe('coerceTextareaArrays', () => {
  it('splits newline-delimited string into array', () => {
    const patch: Record<string, unknown> = {
      discovery: { ignore: '.tasks\nArchive\ntmp' },
    };
    coerceTextareaArrays(patch);
    expect((patch.discovery as Record<string, unknown>).ignore).toEqual([
      '.tasks',
      'Archive',
      'tmp',
    ]);
  });

  it('trims whitespace from each line', () => {
    const patch: Record<string, unknown> = {
      discovery: { ignore: '  .tasks  \n  Archive  ' },
    };
    coerceTextareaArrays(patch);
    expect((patch.discovery as Record<string, unknown>).ignore).toEqual([
      '.tasks',
      'Archive',
    ]);
  });

  it('filters empty lines', () => {
    const patch: Record<string, unknown> = {
      discovery: { ignore: '.tasks\n\n\nArchive\n' },
    };
    coerceTextareaArrays(patch);
    expect((patch.discovery as Record<string, unknown>).ignore).toEqual([
      '.tasks',
      'Archive',
    ]);
  });

  it('produces empty array from empty string', () => {
    const patch: Record<string, unknown> = {
      discovery: { ignore: '' },
    };
    coerceTextareaArrays(patch);
    expect((patch.discovery as Record<string, unknown>).ignore).toEqual([]);
  });

  it('produces empty array from whitespace-only string', () => {
    const patch: Record<string, unknown> = {
      discovery: { ignore: '  \n  \n  ' },
    };
    coerceTextareaArrays(patch);
    expect((patch.discovery as Record<string, unknown>).ignore).toEqual([]);
  });

  it('leaves non-string values untouched', () => {
    const arr = ['.tasks', 'Archive'];
    const patch: Record<string, unknown> = {
      discovery: { ignore: arr },
    };
    coerceTextareaArrays(patch);
    expect((patch.discovery as Record<string, unknown>).ignore).toBe(arr);
  });

  it('no-ops when discovery section absent', () => {
    const patch: Record<string, unknown> = { ui: { port: 8080 } };
    coerceTextareaArrays(patch);
    expect(patch).toEqual({ ui: { port: 8080 } });
  });
});
