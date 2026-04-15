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
 *      "iOS"               → "os"   (only uppercase letters count; leading 'i' dropped)
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
 * Used at create-time where a derived default may collide with an existing
 * project — auto-suffix is the right UX. For updates use isAbbreviationTaken
 * directly so explicit user input collisions surface as 409s instead of
 * silently rewriting the user's choice. Caller wraps in a transaction to
 * close the TOCTOU window between lookup and INSERT/UPDATE.
 */
export function uniqueAbbreviation(db: Database, base: string): string {
  if (!isAbbreviationTaken(db, base)) return base;
  // n=2..999 inclusive = 998 suffix attempts. 998 collisions on the same
  // root means somebody is fuzzing or operator made a mistake; fail loud.
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}${n}`;
    if (!isAbbreviationTaken(db, candidate)) return candidate;
  }
  throw new Error(`No free abbreviation under ${base} after 998 attempts`);
}

/**
 * Check whether an abbreviation is already claimed by an active project.
 * Used by updateProject to surface explicit-collision as a 409 — silently
 * suffixing a user's typed value to "pd5" without telling them is hostile UX.
 * @param excludeProjectId — pass the project being updated so its own row
 * doesn't count as a collision against itself.
 */
export function isAbbreviationTaken(
  db: Database,
  abbreviation: string,
  excludeProjectId?: string,
): boolean {
  if (excludeProjectId) {
    return Boolean(
      db
        .prepare(
          "SELECT 1 FROM projects WHERE abbreviation = ? AND status != 'archived' AND id != ? LIMIT 1",
        )
        .get(abbreviation, excludeProjectId),
    );
  }
  return Boolean(
    db
      .prepare("SELECT 1 FROM projects WHERE abbreviation = ? AND status != 'archived' LIMIT 1")
      .get(abbreviation),
  );
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
