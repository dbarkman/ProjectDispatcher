import type { FastifyInstance } from 'fastify';
import { writeFile } from 'node:fs/promises';
import { loadConfig, reloadConfig, DEFAULT_CONFIG_PATH } from '../../config.js';
import { configSchema } from '../../config.schema.js';

/**
 * Config API routes. Reads and writes the daemon config file.
 *
 * Note: these routes operate on the file, not on an in-memory singleton.
 * The daemon's "current effective config" is whatever was loaded at startup
 * (or last reload). To make a PATCH take effect, either POST /api/config/reload
 * after, or the daemon restarts. In practice, the PATCH handler writes the
 * file and then reloads automatically — but the "effective" config is always
 * whatever the daemon is currently using, not what's on disk.
 *
 * For MVP this is fine: the daemon holds one config ref, and these routes
 * read/write the file. The daemon's SIGHUP handler (when wired in MVP-06+)
 * calls reloadConfig() to pick up changes.
 */
export async function configRoutes(
  app: FastifyInstance,
  getEffectiveConfig: () => ReturnType<typeof loadConfig>,
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<void> {
  // GET /api/config — returns the current effective config
  app.get('/api/config', async () => {
    return getEffectiveConfig();
  });

  // PATCH /api/config — update the config file, validate, reload
  app.patch('/api/config', async (request, reply) => {
    const patch = request.body;

    // Read current file, merge patch, validate the result
    let current: Record<string, unknown>;
    try {
      const loaded = loadConfig(configPath);
      current = loaded as unknown as Record<string, unknown>;
    } catch {
      current = {};
    }

    const merged = deepMerge(current, patch as Record<string, unknown>);

    // Validate the merged config — if invalid, reject without writing
    const result = configSchema.safeParse(merged);
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      return reply.status(400).send({ error: 'Invalid config', issues });
    }

    // Write the merged config to disk
    await writeFile(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');

    // Reload so the daemon picks it up
    const reloaded = reloadConfig(configPath);
    return reloaded;
  });

  // POST /api/config/reload — force a reload from disk
  app.post('/api/config/reload', async () => {
    const config = reloadConfig(configPath);
    return { status: 'reloaded', config };
  });
}

/** Simple shallow-ish merge for config objects (one level of nesting). */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = {
        ...(result[key] as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      };
    } else {
      result[key] = value;
    }
  }
  return result;
}
