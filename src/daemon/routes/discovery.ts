import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import type { Config } from '../../config.schema.js';
import { discoverProjects, folderDisplayName } from '../discovery.js';

/**
 * Discovery API — shows which folders are discovered but not yet registered.
 * Used by the CLI (`dispatch projects discover`) and eventually the UI.
 */
export async function discoveryRoutes(
  app: FastifyInstance,
  db: Database,
  config: Config,
): Promise<void> {
  // GET /api/discovery — returns discovered (unregistered) folders
  app.get('/api/discovery', async () => {
    const result = discoverProjects(db, config);
    return {
      discovered: result.discovered.map((path) => ({
        path,
        name: folderDisplayName(path),
      })),
      registered: result.registered.length,
      missing: result.missing.length,
    };
  });
}
