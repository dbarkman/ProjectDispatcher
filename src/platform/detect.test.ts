import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:os', () => ({
  platform: vi.fn(),
}));

import { platform } from 'node:os';
import { detectPlatform } from './detect.js';

const mockPlatform = vi.mocked(platform);

describe('detectPlatform', () => {
  beforeEach(() => {
    mockPlatform.mockReset();
  });

  it('returns macos on darwin', () => {
    mockPlatform.mockReturnValue('darwin');
    expect(detectPlatform()).toBe('macos');
  });

  it('returns linux on linux', () => {
    mockPlatform.mockReturnValue('linux');
    expect(detectPlatform()).toBe('linux');
  });

  it('returns windows on win32', () => {
    mockPlatform.mockReturnValue('win32');
    expect(detectPlatform()).toBe('windows');
  });

  it('returns unsupported for unknown platforms', () => {
    mockPlatform.mockReturnValue('freebsd' as NodeJS.Platform);
    expect(detectPlatform()).toBe('unsupported');
  });
});
