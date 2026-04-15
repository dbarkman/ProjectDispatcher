import type { Database } from 'better-sqlite3';

/**
 * Derive a short identifier from a project name. Used both as a sensible
 * default in the registration UI and as the post-migration backfill
 * source for migration 004.
 *
 * Rules (in order — first match wins):
 *   1. CamelCase / PascalCase: take every uppercase letter, lowercase it.
 *      "ProjectDispatcher" → "pd"
 *      "HandyManagerHub"   → "hmh"
 *      "iOS"               → "ios"
 *   2. Word-separated (hyphen / underscore / space): take first letter of
 *      each word.
 *      "my-cool-app"       → "mca"
 *      "data lake v2"      → "dlv"
 *   3. Otherwise (single lowercase token, no separators, no caps):
 *      take the first 3 alphanumeric chars.
 *      "myproject"         → "myp"
 *      "x"                 → "x"
 *
 * Always returns lowercase, [a-z0-9] only. Empty input → "p" (project).
 */
export function deriveAbbreviation(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'p';

  const upperLetters = trimmed.match(/[A-Z]/g);
  if (upperLetters && upperLetters.length >= 2) {
    return upperLetters.join('').toLowerCase().slice(0, 6);
  }

  if (/[\s\-_]/.test(trimmed)) {
    const initials = trimmed
      .split(/[\s\-_]+/)
      .filter(Boolean)
      .map((w) => w[0] ?? '')
      .join('')
      .replace(/[^a-zA-Z0-9]/g, '')
      .toLowerCase();
    if (initials.length >= 2) return initials.slice(0, 6);
  }

  // Fall through — single uppercase letter (rule 1 needs ≥2) or all-lowercase
  // single-word: take first 3 alnum chars.
  const fallback = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 3);
  return fallback || 'p';
}

/**
 * Resolve a unique abbreviation against the active (non-archived) projects.
 * If the base is taken, append a digit suffix and try again until free.
 *   "pd" taken → "pd2"; "pd2" taken → "pd3"; ...
 *
 * Caller should run inside a transaction to avoid TOCTOU between the lookup
 * and the eventual INSERT.
 */
export function uniqueAbbreviation(db: Database, base: string): string {
  const stmt = db.prepare(
    "SELECT 1 FROM projects WHERE abbreviation = ? AND status != 'archived' LIMIT 1",
  );
  if (!stmt.get(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}${n}`;
    if (!stmt.get(candidate)) return candidate;
  }
  // 999 collisions on the same root would be operator-error; fail loud.
  throw new Error(`No free abbreviation under ${base} after 999 attempts`);
}

/**
 * Compose the human-readable ticket id used everywhere in the UI:
 *   `<abbreviation>-<sequence_number>`  e.g. "pd-1", "hmh-42".
 *
 * Both inputs come from rows the daemon controls; nothing user-supplied
 * lands here unescaped. Keep this trivial — display is the only consumer.
 */
export function formatTicketDisplayId(
  abbreviation: string,
  sequenceNumber: number,
): string {
  return `${abbreviation}-${sequenceNumber}`;
}
