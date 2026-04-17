import { describe, it, expect } from 'vitest';
import { buildPlist, xmlEscape } from './macos.js';
import type { ServiceConfig } from './macos.js';

const config: ServiceConfig = {
  daemonEntryPath: '/opt/pd/dist/daemon/index.js',
  nodePath: '/usr/local/bin/node',
  logsDir: '/home/test/.tasks/logs',
  workingDir: '/home/test/.tasks',
};

describe('buildPlist', () => {
  it('produces valid XML plist with correct label', () => {
    const plist = buildPlist(config);
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain('<string>com.projectdispatcher.daemon</string>');
  });

  it('sets ProgramArguments to node + daemon entry', () => {
    const plist = buildPlist(config);
    expect(plist).toContain(`<string>${config.nodePath}</string>`);
    expect(plist).toContain(`<string>${config.daemonEntryPath}</string>`);
  });

  it('sets KeepAlive and RunAtLoad to true', () => {
    const plist = buildPlist(config);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
  });

  it('sets WorkingDirectory', () => {
    const plist = buildPlist(config);
    expect(plist).toContain(`<key>WorkingDirectory</key>`);
    expect(plist).toContain(`<string>${config.workingDir}</string>`);
  });

  it('routes stdout and stderr to logs dir', () => {
    const plist = buildPlist(config);
    expect(plist).toContain('<key>StandardOutPath</key>');
    expect(plist).toContain('daemon-stdout.log');
    expect(plist).toContain('<key>StandardErrorPath</key>');
    expect(plist).toContain('daemon-stderr.log');
  });

  it('includes PATH and HOME in environment', () => {
    const plist = buildPlist(config);
    expect(plist).toContain('<key>PATH</key>');
    expect(plist).toContain('<key>HOME</key>');
    expect(plist).toContain('<key>NODE_ENV</key>');
    expect(plist).toContain('<string>production</string>');
  });

  it('escapes XML special chars in paths', () => {
    const plist = buildPlist({
      ...config,
      workingDir: '/opt/A&B<C>D',
    });
    expect(plist).toContain('<string>/opt/A&amp;B&lt;C&gt;D</string>');
    expect(plist).not.toContain('<string>/opt/A&B<C>D</string>');
  });
});

describe('xmlEscape', () => {
  it('escapes ampersands', () => {
    expect(xmlEscape('a&b')).toBe('a&amp;b');
  });

  it('escapes angle brackets', () => {
    expect(xmlEscape('<foo>')).toBe('&lt;foo&gt;');
  });

  it('escapes double quotes', () => {
    expect(xmlEscape('"test"')).toBe('&quot;test&quot;');
  });

  it('leaves clean strings unchanged', () => {
    expect(xmlEscape('/usr/local/bin/node')).toBe('/usr/local/bin/node');
  });
});
