import { watch, type FSWatcher } from 'chokidar';
import { basename } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';
import type { Config } from '../config.schema.js';
import { discoverProjects } from './discovery.js';

/**
 * Start a filesystem watcher on the discovery root.
 *
 * Watches for new/deleted immediate subdirectories and runs discovery
 * to reconcile the DB. Debounced at 1 second to batch rapid changes
 * (e.g., git clone creating multiple nested dirs).
 *
 * Returns the watcher instance so the daemon can close it on shutdown.
 */
export function startWatcher(db: Database, config: Config, logger: Logger): FSWatcher {
  const rootPath = config.discovery.root_path;
  const ignoreSet = new Set(config.discovery.ignore);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const runDiscovery = (): void => {
    discoverProjects(db, config).then((result) => {
      if (result.discovered.length > 0) {
        logger.info({ paths: result.discovered }, 'New folders discovered');
      }
      if (result.missing.length > 0) {
        logger.info({ paths: result.missing }, 'Folders marked as missing');
      }
      if (result.restored.length > 0) {
        logger.info({ paths: result.restored }, 'Folders restored from missing');
      }
    }).catch((err) => {
      logger.error({ err }, 'Discovery failed during watcher event');
    });
  };

  const debouncedDiscovery = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runDiscovery, 1000);
  };

  const watcher = watch(rootPath, {
    depth: 0, // Only immediate children of the root
    ignoreInitial: true, // Don't fire for existing folders (discovery handles that)
    followSymlinks: false, // Don't follow symlinks — prevents unexpected traversal (Review #5 L-03)
    ignored: (filePath: string, stats) => {
      // Ignore files (we only care about directories)
      if (stats?.isFile()) return true;
      // Ignore dotfiles/dotdirs — use basename for cross-platform (Review #5 F-02 / L-01)
      const name = basename(filePath);
      if (name.startsWith('.')) return true;
      // Ignore configured ignore list
      if (ignoreSet.has(name)) return true;
      return false;
    },
  });

  watcher.on('addDir', (path) => {
    logger.debug({ path }, 'Directory added');
    debouncedDiscovery();
  });

  watcher.on('unlinkDir', (path) => {
    logger.debug({ path }, 'Directory removed');
    debouncedDiscovery();
  });

  watcher.on('error', (err) => {
    logger.error({ err }, 'Watcher error');
  });

  return watcher;
}
