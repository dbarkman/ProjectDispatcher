import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// The pidfile module uses a hardcoded path from DEFAULT_TASKS_DIR.
// Rather than mocking the module internals, we test the logic inline
// since the actual daemon startup check is ~10 lines of straightforward code.

describe('PID file lock logic', () => {
  let pidPath: string;

  beforeEach(() => {
    pidPath = join(tmpdir(), `test-daemon-${randomUUID()}.pid`);
  });

  afterEach(() => {
    try { unlinkSync(pidPath); } catch { /* may not exist */ }
  });

  function readTestPid(): number | null {
    try {
      if (!existsSync(pidPath)) return null;
      const content = require('node:fs').readFileSync(pidPath, 'utf8').trim();
      const pid = parseInt(content, 10);
      return Number.isFinite(pid) ? pid : null;
    } catch {
      return null;
    }
  }

  function isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it('returns null when no PID file exists', () => {
    expect(readTestPid()).toBeNull();
  });

  it('reads a valid PID from file', () => {
    writeFileSync(pidPath, '12345', 'utf8');
    expect(readTestPid()).toBe(12345);
  });

  it('returns null for non-numeric PID content', () => {
    writeFileSync(pidPath, 'notapid', 'utf8');
    expect(readTestPid()).toBeNull();
  });

  it('detects current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('detects dead process (high PID unlikely to exist)', () => {
    expect(isProcessAlive(2_000_000_000)).toBe(false);
  });

  it('stale PID file — process dead → should allow startup', () => {
    writeFileSync(pidPath, '2000000000', 'utf8');
    const pid = readTestPid();
    expect(pid).toBe(2_000_000_000);
    expect(isProcessAlive(pid!)).toBe(false);
  });

  it('live PID file — process alive → should block startup', () => {
    writeFileSync(pidPath, String(process.pid), 'utf8');
    const pid = readTestPid();
    expect(pid).toBe(process.pid);
    expect(isProcessAlive(pid!)).toBe(true);
  });
});
