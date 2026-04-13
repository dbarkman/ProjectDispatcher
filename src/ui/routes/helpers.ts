import type { Database } from 'better-sqlite3';

/**
 * Shared helper for UI routes. Returns the inbox count so every page
 * can display the badge in the sidebar. (Review #9 L4)
 */
export function getInboxCount(db: Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tickets t
       JOIN projects p ON p.id = t.project_id
       WHERE t."column" = 'human' AND p.status != 'archived'`,
    )
    .get() as { n: number };
  return row.n;
}
