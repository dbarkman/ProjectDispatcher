// Platform detection — used by the installer and CLI to pick the right
// service management module.

import { platform } from 'node:os';

export type Platform = 'macos' | 'linux' | 'windows' | 'unsupported';

export function detectPlatform(): Platform {
  switch (platform()) {
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    case 'win32':
      return 'windows';
    default:
      return 'unsupported';
  }
}
