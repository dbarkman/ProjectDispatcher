import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');

describe('CLI --version', () => {
  it('matches package.json version exactly', () => {
    // Regression guard: 0.2.0 shipped with `.version('0.1.0')` hardcoded in
    // src/cli/index.ts. `dispatch --version` lied about what code was
    // actually installed. This test runs the CLI in-process and asserts the
    // printed version matches package.json. Prevents future drift.
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, 'package.json'), 'utf8'),
    ) as { version: string };

    const output = execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        join(repoRoot, 'src', 'cli', 'index.ts'),
        '--version',
      ],
      { encoding: 'utf8' },
    ).trim();

    expect(output).toBe(pkg.version);
  });
});
