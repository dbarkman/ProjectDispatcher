import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import type { ConfigRef } from '../../config.schema.js';
import { discoverProjects, folderDisplayName } from '../discovery.js';

export async function discoveryRoutes(
  app: FastifyInstance,
  db: Database,
  configRef: ConfigRef,
): Promise<void> {
  // GET /api/discovery — returns discovered (unregistered) folders
  app.get('/api/discovery', async () => {
    const result = await discoverProjects(db, configRef.current);
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
