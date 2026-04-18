import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readPidFile, isProcessAlive, isDaemonRunning } from '../../src/daemon/pidfile.js';

describe('PID file lock logic', () => {
  let pidPath: string;

  beforeEach(() => {
    pidPath = join(tmpdir(), `test-daemon-${randomUUID()}.pid`);
  });

  afterEach(() => {
    try { unlinkSync(pidPath); } catch { /* may not exist */ }
  });

  describe('readPidFile', () => {
    it('returns null when no PID file exists', () => {
      expect(readPidFile(pidPath)).toBeNull();
    });

    it('reads a valid PID from file', () => {
      writeFileSync(pidPath, '12345', 'utf8');
      expect(readPidFile(pidPath)).toBe(12345);
    });

    it('returns null for non-numeric PID content', () => {
      writeFileSync(pidPath, 'notapid', 'utf8');
      expect(readPidFile(pidPath)).toBeNull();
    });
  });

  describe('isProcessAlive', () => {
    it('detects current process as alive', () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it('detects dead process (high PID unlikely to exist)', () => {
      expect(isProcessAlive(2_000_000_000)).toBe(false);
    });
  });

  describe('isDaemonRunning', () => {
    it('returns not running when no PID file', () => {
      const result = isDaemonRunning(pidPath);
      expect(result).toEqual({ running: false, pid: null });
    });

    it('returns running when PID file points to live process', () => {
      writeFileSync(pidPath, String(process.pid), 'utf8');
      const result = isDaemonRunning(pidPath);
      expect(result).toEqual({ running: true, pid: process.pid });
    });

    it('returns not running when PID file is stale', () => {
      writeFileSync(pidPath, '2000000000', 'utf8');
      const result = isDaemonRunning(pidPath);
      expect(result).toEqual({ running: false, pid: 2_000_000_000 });
    });
  });
});
