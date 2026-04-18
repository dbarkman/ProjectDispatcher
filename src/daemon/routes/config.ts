import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readFile, writeFile } from 'node:fs/promises';
import { reloadConfig, DEFAULT_CONFIG_PATH } from '../../config.js';
import { configSchema, type ConfigRef, CONFIG_RESTART_REQUIRED } from '../../config.schema.js';

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
    const raw = z.record(z.string(), z.unknown()).parse(request.body);
    const patch = expandDotKeys(raw);

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

    const restartRequired = changesRestartRequiredField(patch);

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

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * htmx json-enc sends flat dotted keys ("agents.max_concurrent_per_project": "3").
 * Expand them into nested objects and coerce string values to native types
 * so they pass Zod validation. Already-nested objects pass through unchanged.
 */
function expandDotKeys(
  flat: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(flat)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const value = flat[key];
    const dotIndex = key.indexOf('.');
    if (dotIndex !== -1) {
      const section = key.substring(0, dotIndex);
      const field = key.substring(dotIndex + 1);
      if (DANGEROUS_KEYS.has(section) || DANGEROUS_KEYS.has(field)) continue;
      const existing = result[section];
      if (
        typeof existing === 'object' &&
        existing !== null &&
        !Array.isArray(existing)
      ) {
        (existing as Record<string, unknown>)[field] = coerceValue(value);
      } else {
        result[section] = { [field]: coerceValue(value) };
      }
    } else if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      const existing = result[key];
      if (
        typeof existing === 'object' &&
        existing !== null &&
        !Array.isArray(existing)
      ) {
        result[key] = {
          ...(existing as Record<string, unknown>),
          ...(value as Record<string, unknown>),
        };
      } else {
        result[key] = value;
      }
    } else {
      result[key] = coerceValue(value);
    }
  }
  return result;
}

function coerceValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && !isNaN(Number(value))) return Number(value);
  return value;
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
