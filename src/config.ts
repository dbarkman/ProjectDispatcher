import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  configSchema,
  CONFIG_SECTION_NAMES,
  type Config,
  type ConfigSectionName,
} from './config.schema.js';

/**
 * Default on-disk location of the dispatch config file. Resolved via
 * `os.homedir()` so it works cross-platform without hardcoded paths.
 */
export const DEFAULT_CONFIG_PATH = join(homedir(), 'Development', '.tasks', 'config.json');

/**
 * Expand a leading `~/` in a path to the user's home directory.
 *   - `~` alone         → homedir
 *   - `~/foo`           → join(homedir, 'foo')
 *   - `~other/foo`      → unchanged (not our convention)
 *   - anything else     → unchanged
 *
 * Cross-platform via `os.homedir()`.
 */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Load and validate the dispatch config.
 *
 * Order of operations:
 *   1. Read the config file if it exists, else start with `{}`.
 *   2. Overlay any `DISPATCH_*` environment variables on top of the file
 *      contents (env wins over file).
 *   3. Validate the merged object with the Zod schema, which fills in
 *      all defaults for any omitted fields.
 *   4. Post-process: expand `~/` in `discovery.root_path`.
 *
 * Missing file → full defaults (not an error). Invalid JSON or invalid
 * fields → throws with a message naming the specific field that failed.
 * Per our coding principles, startup-time config validation refuses to
 * proceed on bad input — the daemon should crash loud at boot rather
 * than limp along and fail at the first request.
 *
 * Sync file I/O is deliberate: this runs at daemon startup, before the
 * server binds. Same carve-out as `runMigrations()`.
 */
export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): Config {
  let raw: unknown = {};

  if (existsSync(configPath)) {
    const text = readFileSync(configPath, 'utf8');
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `Failed to parse config file at ${configPath}: ${(err as Error).message}`,
      );
    }
  }

  const withEnv = applyEnvOverrides(raw);

  const result = configSchema.safeParse(withEnv);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid config at ${configPath}:\n${issues}`);
  }

  const config = result.data;
  config.discovery.root_path = expandHome(config.discovery.root_path);

  return config;
}

/**
 * Re-read and re-validate the config from disk. Semantically identical to
 * `loadConfig()` — exists as a separate name for call-site clarity (e.g.
 * the daemon handling a SIGHUP for hot reload). No shared state between
 * calls; the caller owns whichever handle they want to keep.
 */
export function reloadConfig(configPath: string = DEFAULT_CONFIG_PATH): Config {
  return loadConfig(configPath);
}

/**
 * Overlay `DISPATCH_*` env vars onto a parsed config object.
 *
 * Convention: `DISPATCH_<SECTION>_<KEY>` maps to `config.<section>.<key>`
 * with both parts lowercased. Multi-word section names (`claude_cli`)
 * are resolved by longest-prefix match against `CONFIG_SECTION_NAMES`,
 * so `DISPATCH_CLAUDE_CLI_BINARY_PATH` routes to `claude_cli.binary_path`
 * and not the incorrect `claude.cli_binary_path`.
 *
 * Values are coerced from strings by `coerceEnvValue()`. Zod handles the
 * final type check — this function just does the cheap coercion so env
 * vars can hit numeric, boolean, and array-typed fields.
 */
function applyEnvOverrides(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    // Pass through — let Zod fail with a clear error on non-object shape.
    return raw;
  }

  const out = structuredClone(raw) as Record<string, unknown>;

  for (const [envKey, envValue] of Object.entries(process.env)) {
    if (!envKey.startsWith('DISPATCH_') || envValue === undefined) continue;

    const parsed = parseEnvKey(envKey);
    if (!parsed) continue;
    const { section, key } = parsed;

    if (typeof out[section] !== 'object' || out[section] === null || Array.isArray(out[section])) {
      out[section] = {};
    }
    const sectionObj = out[section] as Record<string, unknown>;
    sectionObj[key] = coerceEnvValue(envValue);
  }

  return out;
}

/**
 * Parse a `DISPATCH_<SECTION>_<KEY>` env var into (section, key) parts.
 * Uses longest-prefix match against the known section names to handle
 * multi-word sections (`claude_cli`) correctly.
 *
 * Returns null if the env var doesn't resolve to a known section.
 */
function parseEnvKey(envKey: string): { section: ConfigSectionName; key: string } | null {
  const stripped = envKey.slice('DISPATCH_'.length).toLowerCase();

  // Longest sections first so `claude_cli_binary_path` matches `claude_cli`
  // before a hypothetical `claude` section would.
  const sortedSections = [...CONFIG_SECTION_NAMES].sort((a, b) => b.length - a.length);

  for (const section of sortedSections) {
    if (stripped.startsWith(section + '_')) {
      return {
        section,
        key: stripped.slice(section.length + 1),
      };
    }
  }
  return null;
}

/**
 * Coerce an env var string to a typed value.
 *
 *   - Strings beginning with `[` or `{` are attempted as `JSON.parse`
 *     (lets env vars carry arrays and nested objects).
 *   - `"true"` / `"false"` → boolean
 *   - Pure integer strings → number
 *   - Decimal strings → number
 *   - Anything else → string as-is
 *
 * Zod validates the final shape, so this is allowed to be lossy — worst
 * case the user sees a clear Zod error naming the field.
 */
function coerceEnvValue(value: string): unknown {
  if (value.startsWith('[') || value.startsWith('{')) {
    try {
      return JSON.parse(value);
    } catch {
      // Fall through to scalar coercion.
    }
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  return value;
}
