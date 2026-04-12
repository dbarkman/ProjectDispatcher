import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeFile } from 'node:fs/promises';
import { loadConfig, reloadConfig, DEFAULT_CONFIG_PATH } from '../../config.js';
import { configSchema, type Config } from '../../config.schema.js';

/**
 * Config API routes. Reads and writes the daemon config file.
 *
 * The `getConfig` getter and `setConfig` setter close over the same
 * mutable `config` binding in `http.ts`, so PATCH/reload updates are
 * immediately visible to subsequent GET requests and to other routes
 * that read `config` (like the health check). (Code Review #4 F-04)
 */
export async function configRoutes(
  app: FastifyInstance,
  getConfig: () => Config,
  setConfig: (c: Config) => void,
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<void> {
  // GET /api/config — returns the current effective config
  app.get('/api/config', async () => {
    return getConfig();
  });

  // PATCH /api/config — update the config file, validate, reload
  app.patch('/api/config', async (request, reply) => {
    // Zod-parse the body BEFORE deepMerge to prevent prototype pollution
    // and to reject non-object inputs (null, string, array) with a 400
    // instead of a 500 TypeError. (Code Review #4 F-02, Security Review #4 MEDIUM)
    const patch = z.record(z.string(), z.unknown()).parse(request.body);

    // Read current file config as the merge base
    let current: Record<string, unknown>;
    try {
      const loaded = loadConfig(configPath);
      current = loaded as unknown as Record<string, unknown>;
    } catch {
      current = {};
    }

    const merged = deepMerge(current, patch);

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

    // Reload and update the daemon's effective config
    const reloaded = reloadConfig(configPath);
    setConfig(reloaded);
    return reloaded;
  });

  // POST /api/config/reload — force a reload from disk
  app.post('/api/config/reload', async () => {
    const reloaded = reloadConfig(configPath);
    setConfig(reloaded);
    return { status: 'reloaded', config: reloaded };
  });
}

/**
 * Shallow-ish merge for config objects (one level of nesting).
 *
 * Defense in depth: `Object.hasOwn` check prevents prototype pollution
 * via `__proto__` keys. Even though the caller Zod-parses the input,
 * this guard costs nothing and catches the case if anyone calls
 * deepMerge directly in the future. (Security Review #4 MEDIUM)
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(source, key)) continue;

    const value = source[key];
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
