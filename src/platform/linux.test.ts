import { describe, it, expect } from 'vitest';
import { buildUnit } from './linux.js';
import type { ServiceConfig } from './linux.js';

const config: ServiceConfig = {
  daemonEntryPath: '/opt/pd/dist/daemon/index.js',
  nodePath: '/usr/local/bin/node',
  logsDir: '/home/test/.tasks/logs',
  workingDir: '/home/test/.tasks',
};

describe('buildUnit', () => {
  it('produces a valid systemd unit with correct description', () => {
    const unit = buildUnit(config);
    expect(unit).toContain('Description=Project Dispatcher Daemon');
  });

  it('sets ExecStart to quoted node + daemon entry', () => {
    const unit = buildUnit(config);
    expect(unit).toContain(`ExecStart="${config.nodePath}" "${config.daemonEntryPath}"`);
  });

  it('handles paths with spaces in ExecStart', () => {
    const spaced = buildUnit({
      ...config,
      nodePath: '/opt/My Programs/node',
      daemonEntryPath: '/opt/Project Dispatcher/index.js',
    });
    expect(spaced).toContain('ExecStart="/opt/My Programs/node" "/opt/Project Dispatcher/index.js"');
  });

  it('configures Restart=on-failure with 5s delay', () => {
    const unit = buildUnit(config);
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('RestartSec=5');
  });

  it('sets WorkingDirectory', () => {
    const unit = buildUnit(config);
    expect(unit).toContain(`WorkingDirectory=${config.workingDir}`);
  });

  it('routes stdout and stderr to logs dir', () => {
    const unit = buildUnit(config);
    expect(unit).toContain('StandardOutput=append:');
    expect(unit).toContain('daemon-stdout.log');
    expect(unit).toContain('StandardError=append:');
    expect(unit).toContain('daemon-stderr.log');
  });

  it('sets NODE_ENV=production', () => {
    const unit = buildUnit(config);
    expect(unit).toContain('Environment=NODE_ENV=production');
  });

  it('includes Install section with default.target', () => {
    const unit = buildUnit(config);
    expect(unit).toContain('[Install]');
    expect(unit).toContain('WantedBy=default.target');
  });
});
