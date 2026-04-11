import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG_PATH, expandHome, loadConfig, reloadConfig } from './config.js';

describe('expandHome', () => {
  it('expands `~` alone to homedir', () => {
    expect(expandHome('~')).toBe(homedir());
  });

  it('expands `~/foo` to join(homedir, foo)', () => {
    expect(expandHome('~/Development')).toBe(join(homedir(), 'Development'));
  });

  it('leaves absolute paths unchanged', () => {
    expect(expandHome('/tmp/foo')).toBe('/tmp/foo');
  });

  it('leaves relative paths unchanged', () => {
    expect(expandHome('foo/bar')).toBe('foo/bar');
  });

  it('does not expand `~other/...` (not our convention)', () => {
    expect(expandHome('~other/foo')).toBe('~other/foo');
  });
});

describe('DEFAULT_CONFIG_PATH', () => {
  it('resolves to ~/Development/.tasks/config.json via homedir()', () => {
    expect(DEFAULT_CONFIG_PATH).toBe(join(homedir(), 'Development', '.tasks', 'config.json'));
  });
});

describe('loadConfig', () => {
  const tmpDirs: string[] = [];
  const envKeysToCleanup = new Set<string>();

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const key of envKeysToCleanup) {
      delete process.env[key];
    }
    envKeysToCleanup.clear();
  });

  function mkTmp(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pd-config-test-'));
    tmpDirs.push(dir);
    return dir;
  }

  function setEnv(key: string, value: string): void {
    envKeysToCleanup.add(key);
    process.env[key] = value;
  }

  it('returns full defaults when the config file does not exist', () => {
    const dir = mkTmp();
    const config = loadConfig(join(dir, 'nonexistent.json'));

    expect(config.heartbeat.base_interval_seconds).toBe(300);
    expect(config.heartbeat.max_interval_seconds).toBe(86400);
    expect(config.heartbeat.backoff_multiplier).toBe(2);
    expect(config.agents.max_concurrent_per_project).toBe(3);
    expect(config.agents.max_concurrent_global).toBe(10);
    expect(config.agents.default_timeout_minutes).toBe(30);
    expect(config.ui.port).toBe(5757);
    expect(config.ui.auto_open_on_install).toBe(true);
    expect(config.ui.theme).toBe('dark');
    expect(config.retention.transcript_days).toBe(30);
    expect(config.retention.log_days).toBe(7);
    expect(config.retention.backup_count).toBe(14);
    expect(config.discovery.root_path).toBe(join(homedir(), 'Development'));
    expect(config.discovery.ignore).toEqual(['.tasks', 'Archive', 'tmp']);
    expect(config.claude_cli.binary_path).toBe('claude');
    expect(config.claude_cli.default_model).toBe('claude-sonnet-4-6');
  });

  it('merges partial file values with defaults for omitted fields', () => {
    const dir = mkTmp();
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        ui: { port: 8080 },
        discovery: { root_path: '/custom/path' },
      }),
    );
    const config = loadConfig(path);

    expect(config.ui.port).toBe(8080);
    expect(config.ui.auto_open_on_install).toBe(true); // default preserved
    expect(config.ui.theme).toBe('dark'); // default preserved
    expect(config.discovery.root_path).toBe('/custom/path');
    expect(config.heartbeat.base_interval_seconds).toBe(300); // untouched section uses defaults
  });

  it('throws with a field-specific error on invalid config value', () => {
    const dir = mkTmp();
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ ui: { port: -1 } }));

    expect(() => loadConfig(path)).toThrow(/ui\.port/);
  });

  it('throws with a path-specific error on malformed JSON', () => {
    const dir = mkTmp();
    const path = join(dir, 'config.json');
    writeFileSync(path, '{ not valid json }');

    expect(() => loadConfig(path)).toThrow(/Failed to parse/);
  });

  it('rejects an unknown Claude model in claude_cli.default_model', () => {
    const dir = mkTmp();
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ claude_cli: { default_model: 'claude-opus-4-7' } }));

    expect(() => loadConfig(path)).toThrow(/claude_cli\.default_model/);
  });

  it('expands `~/` in discovery.root_path after parsing', () => {
    const dir = mkTmp();
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ discovery: { root_path: '~/custom-dev' } }));

    const config = loadConfig(path);
    expect(config.discovery.root_path).toBe(join(homedir(), 'custom-dev'));
  });

  it('applies DISPATCH_UI_PORT env override', () => {
    const dir = mkTmp();
    setEnv('DISPATCH_UI_PORT', '5858');

    const config = loadConfig(join(dir, 'nonexistent.json'));
    expect(config.ui.port).toBe(5858);
  });

  it('applies DISPATCH_CLAUDE_CLI_BINARY_PATH (multi-word section)', () => {
    const dir = mkTmp();
    setEnv('DISPATCH_CLAUDE_CLI_BINARY_PATH', '/opt/claude');

    const config = loadConfig(join(dir, 'nonexistent.json'));
    expect(config.claude_cli.binary_path).toBe('/opt/claude');
  });

  it('coerces "false" to boolean for boolean fields', () => {
    const dir = mkTmp();
    setEnv('DISPATCH_UI_AUTO_OPEN_ON_INSTALL', 'false');

    const config = loadConfig(join(dir, 'nonexistent.json'));
    expect(config.ui.auto_open_on_install).toBe(false);
  });

  it('parses JSON-array env values for list fields', () => {
    const dir = mkTmp();
    setEnv('DISPATCH_DISCOVERY_IGNORE', '[".tasks","Archive","node_modules"]');

    const config = loadConfig(join(dir, 'nonexistent.json'));
    expect(config.discovery.ignore).toEqual(['.tasks', 'Archive', 'node_modules']);
  });

  it('env override takes precedence over file value', () => {
    const dir = mkTmp();
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ ui: { port: 3000 } }));
    setEnv('DISPATCH_UI_PORT', '5858');

    const config = loadConfig(path);
    expect(config.ui.port).toBe(5858);
  });
});

describe('reloadConfig', () => {
  it('picks up changes when the file has been rewritten between calls', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pd-reload-test-'));
    try {
      const path = join(dir, 'config.json');

      writeFileSync(path, JSON.stringify({ ui: { port: 5757 } }));
      const first = loadConfig(path);
      expect(first.ui.port).toBe(5757);

      writeFileSync(path, JSON.stringify({ ui: { port: 8080 } }));
      const second = reloadConfig(path);
      expect(second.ui.port).toBe(8080);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
