import { z } from 'zod';
import { CLAUDE_MODELS } from './types.js';

/**
 * Canonical list of top-level config sections. Used by the env-var
 * overlay logic in `config.ts` to resolve multi-word section names like
 * `claude_cli` unambiguously (longest-prefix match). Kept as a `const`
 * tuple so TypeScript can narrow to the literal union.
 *
 * If you add a section to `configSchema`, add it here too. Two places
 * to keep in sync, but the list is short and obvious enough that drift
 * is cheap to catch.
 */
export const CONFIG_SECTION_NAMES = [
  'heartbeat',
  'agents',
  'ui',
  'retention',
  'discovery',
  'claude_cli',
  'ai',
] as const;

export type ConfigSectionName = (typeof CONFIG_SECTION_NAMES)[number];

/**
 * Full dispatch config schema. Every field has a default, so parsing an
 * empty object `{}` yields a valid fully-populated config. The defaults
 * mirror DESIGN.md §17.
 *
 * Nested `.prefault({})` wrappers are required so that parsing a config
 * that omits a whole section (e.g. `{ ui: { port: 8080 } }`) still fills
 * in the missing sections from their own defaults rather than failing
 * with "required". `.prefault()` (Zod 4) injects `{}` as the *input* to
 * the section schema when the field is absent, so the inner `.default()`
 * values fire as usual. `.default({})` is stricter in Zod 4 and would
 * require a fully-populated default object here.
 */
export const configSchema = z.object({
  heartbeat: z
    .object({
      base_interval_seconds: z.number().int().positive().default(300),
      max_interval_seconds: z.number().int().positive().default(86400),
      backoff_multiplier: z.number().positive().default(2),
    })
    .prefault({}),
  agents: z
    .object({
      max_concurrent_per_project: z.number().int().positive().default(3),
      max_concurrent_global: z.number().int().positive().default(10),
      default_timeout_minutes: z.number().int().positive().default(30),
      // Circuit breaker: if an agent has run this many times on a ticket
      // without the ticket moving to a different column, stop spawning and
      // auto-move to human. Prevents overnight token burn from stuck agents.
      circuit_breaker_max_runs: z.number().int().positive().default(3),
    })
    .prefault({}),
  ui: z
    .object({
      port: z.number().int().min(1024).max(65535).default(5757),
      auto_open_on_install: z.boolean().default(true),
      theme: z.enum(['dark', 'light']).default('dark'),
    })
    .prefault({}),
  retention: z
    .object({
      transcript_days: z.number().int().positive().default(30),
      log_days: z.number().int().positive().default(7),
      backup_count: z.number().int().positive().default(14),
    })
    .prefault({}),
  discovery: z
    .object({
      root_path: z.string().default('~/Development'),
      ignore: z.array(z.string()).default(['.tasks', 'Archive', 'tmp']),
    })
    .prefault({}),
  claude_cli: z
    .object({
      binary_path: z.string().default('claude'),
      default_model: z.enum(CLAUDE_MODELS).default('claude-sonnet-4-6'),
    })
    .prefault({}),
  ai: z
    .object({
      provider: z.enum(['claude']).default('claude'),
      auth_method: z.enum(['oauth', 'api_key', 'custom']).optional(),
      api_key: z.string().optional(),
      base_url: z.string().url().optional(),
      default_model: z.enum(CLAUDE_MODELS).default('claude-sonnet-4-6'),
    })
    .prefault({}),
});

export type Config = z.infer<typeof configSchema>;
