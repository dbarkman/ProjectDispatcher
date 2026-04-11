import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from './logger.js';

// NOTE: createLogger's development-mode path uses pino-pretty via a
// worker-thread transport. Creating that transport from inside a vitest
// run leaves the worker lingering, which can hang the test runner. We
// don't exercise the dev path from tests — manual verification via
// `NODE_ENV=development` plus running the daemon is sufficient. The
// production path (file-based JSON) is the one that matters for CI and
// is tested rigorously below.

describe('createLogger (production mode)', () => {
  const tmpDirs: string[] = [];
  let prevNodeEnv: string | undefined;

  beforeEach(() => {
    prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = prevNodeEnv;
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function mkTmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pd-logger-test-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('creates the logs directory if it does not exist', () => {
    const dir = mkTmp();
    const logsDir = join(dir, 'nested', 'logs');
    expect(existsSync(logsDir)).toBe(false);

    createLogger(logsDir);
    expect(existsSync(logsDir)).toBe(true);
  });

  it('writes a JSON-formatted log line to a daily-named file', () => {
    const dir = mkTmp();
    const logger = createLogger(dir);

    logger.info({ project: 'test-project', component: 'unit-test' }, 'hello');

    const today = new Date().toISOString().slice(0, 10);
    const logPath = join(dir, `daemon-${today}.log`);
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, 'utf8');
    const firstLine = content.split('\n').find((l) => l.trim().length > 0);
    expect(firstLine).toBeDefined();

    const parsed = JSON.parse(firstLine!) as Record<string, unknown>;
    expect(parsed.msg).toBe('hello');
    expect(parsed.project).toBe('test-project');
    expect(parsed.component).toBe('unit-test');
    expect(parsed.level).toBe(30); // pino info level number
    expect(typeof parsed.time).toBe('string'); // ISO time string
  });

  it('child loggers inherit parent bindings', () => {
    const dir = mkTmp();
    const logger = createLogger(dir);
    const child = logger.child({ component: 'scheduler' });

    child.info({ project_id: 'p1' }, 'tick');

    const today = new Date().toISOString().slice(0, 10);
    const logPath = join(dir, `daemon-${today}.log`);
    const content = readFileSync(logPath, 'utf8');
    const line = content.split('\n').find((l) => l.includes('"msg":"tick"'));
    expect(line).toBeDefined();

    const parsed = JSON.parse(line!) as Record<string, unknown>;
    expect(parsed.component).toBe('scheduler');
    expect(parsed.project_id).toBe('p1');
    expect(parsed.msg).toBe('tick');
  });

  it('logs below the configured level are filtered out', () => {
    const dir = mkTmp();
    const logger = createLogger(dir);

    logger.debug('this should be filtered'); // below 'info' in prod
    logger.info('this should appear');

    const today = new Date().toISOString().slice(0, 10);
    const logPath = join(dir, `daemon-${today}.log`);
    const content = readFileSync(logPath, 'utf8');

    expect(content).not.toContain('this should be filtered');
    expect(content).toContain('this should appear');
  });
});
