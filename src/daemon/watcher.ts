import { watch, type FSWatcher } from 'chokidar';
import { basename } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { Logger } from 'pino';
import type { ConfigRef } from '../config.schema.js';
import { discoverProjects } from './discovery.js';

/**
 * Start a filesystem watcher on the discovery root.
 *
 * Watches for new/deleted immediate subdirectories and runs discovery
 * to reconcile the DB. Debounced at 1 second to batch rapid changes.
 *
 * The chokidar watcher path is captured at start-time and won't change
 * until restart. Discovery calls inside the callback read
 * configRef.current so ignore-list changes take effect immediately.
 */
export function startWatcher(db: Database, configRef: ConfigRef, logger: Logger): FSWatcher {
  const rootPath = configRef.current.discovery.root_path;
  const ignoreSet = new Set(configRef.current.discovery.ignore);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const runDiscovery = (): void => {
    discoverProjects(db, configRef.current).then((result) => {
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
    depth: 0,
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (filePath: string, stats) => {
      if (stats?.isFile()) return true;
      const name = basename(filePath);
      if (name.startsWith('.')) return true;
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
