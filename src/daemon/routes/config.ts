import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';
import { reloadConfig, DEFAULT_CONFIG_PATH } from '../../config.js';
import { configSchema, type Config, type ConfigRef, CONFIG_RESTART_REQUIRED } from '../../config.schema.js';

export async function configRoutes(
  app: FastifyInstance,
  configRef: ConfigRef,
  configPath: string = DEFAULT_CONFIG_PATH,
): Promise<void> {
  // GET /api/config — returns the current effective config
  app.get('/api/config', async () => {
    return configRef.current;
  });

  // PATCH /api/config — update the config file, validate, reload
  app.patch('/api/config', async (request, reply) => {
    const patch = z.record(z.string(), z.unknown()).parse(request.body);

    let current: Record<string, unknown>;
    try {
      const text = await readFile(configPath, 'utf8');
      current = JSON.parse(text) as Record<string, unknown>;
    } catch {
      current = {};
    }

    const merged = deepMerge(current, patch);

    const result = configSchema.safeParse(merged);
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      return reply.status(400).send({ error: 'Invalid config', issues });
    }

    await writeFile(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');

    const reloaded = reloadConfig(configPath);
    configRef.current = reloaded;

    const restartRequired = changesRestartRequiredField(configRef.current, patch);

    return { ...reloaded, restart_required: restartRequired };
  });

  // POST /api/config/reload — force a reload from disk
  app.post('/api/config/reload', async () => {
    const reloaded = reloadConfig(configPath);
    configRef.current = reloaded;
    return { status: 'reloaded', config: reloaded };
  });
}

/**
 * Check whether any keys in the patch touch a restart-required field.
 * Handles both flat dot-paths and nested objects.
 */
function changesRestartRequiredField(
  _config: Config,
  patch: Record<string, unknown>,
): boolean {
  for (const topKey of Object.keys(patch)) {
    const value = patch[topKey];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const subKey of Object.keys(value as Record<string, unknown>)) {
        if (CONFIG_RESTART_REQUIRED.has(`${topKey}.${subKey}`)) return true;
      }
    } else {
      if (CONFIG_RESTART_REQUIRED.has(topKey)) return true;
    }
  }
  return false;
}

/**
 * Shallow-ish merge for config objects (one level of nesting).
 *
 * Defense in depth: `Object.hasOwn` check prevents prototype pollution
 * via `__proto__` keys.
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
