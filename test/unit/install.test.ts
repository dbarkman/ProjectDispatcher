import { describe, it, expect } from 'vitest';
import {
  parseInstallerFlags,
  manualStartHint,
  parseLaunchctlPid,
  parseSystemdPid,
} from '../../src/install-utils.js';

describe('parseInstallerFlags', () => {
  it('returns noBrowser: false with no flags', () => {
    const result = parseInstallerFlags(['node', 'install.js']);
    expect(result.noBrowser).toBe(false);
  });

  it('detects --no-browser flag', () => {
    const result = parseInstallerFlags(['node', 'install.js', '--no-browser']);
    expect(result.noBrowser).toBe(true);
  });

  it('detects --no-browser among other args', () => {
    const result = parseInstallerFlags(['node', 'install.js', '--verbose', '--no-browser']);
    expect(result.noBrowser).toBe(true);
  });
});

describe('manualStartHint', () => {
  it('returns dispatch daemon start for macOS', () => {
    expect(manualStartHint('macos')).toBe('dispatch daemon start');
  });

  it('returns dispatch daemon start for Linux', () => {
    expect(manualStartHint('linux')).toBe('dispatch daemon start');
  });

  it('returns node command for Windows', () => {
    expect(manualStartHint('windows')).toBe('node dist/daemon/index.js');
  });

  it('returns node command for unsupported', () => {
    expect(manualStartHint('unsupported')).toBe('node dist/daemon/index.js');
  });
});

describe('parseLaunchctlPid', () => {
  it('extracts pid from launchctl print output', () => {
    const output = `com.projectdispatcher.daemon = {
\tactive count = 1
\tpath = /Users/test/Library/LaunchAgents/com.projectdispatcher.daemon.plist
\tstate = running

\tprogram = /usr/local/bin/node
\targuments = {
\t\t/usr/local/bin/node
\t\t/usr/local/lib/node_modules/projectdispatcher/dist/daemon/index.js
\t}

\tpid = 48231
\texit status = 0
}`;
    expect(parseLaunchctlPid(output)).toBe(48231);
  });

  it('returns null when no pid in output', () => {
    const output = `com.projectdispatcher.daemon = {
\tactive count = 0
\tpath = /Users/test/Library/LaunchAgents/com.projectdispatcher.daemon.plist
\tstate = not running
}`;
    expect(parseLaunchctlPid(output)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseLaunchctlPid('')).toBeNull();
  });
});

describe('parseSystemdPid', () => {
  it('extracts pid from systemctl show output', () => {
    expect(parseSystemdPid('MainPID=12345')).toBe(12345);
  });

  it('returns null for MainPID=0 (not running)', () => {
    expect(parseSystemdPid('MainPID=0')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseSystemdPid('')).toBeNull();
  });
});
