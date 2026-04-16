/**
 * Strips the `::archived::<uuid>` suffix that archiveProject() appends
 * to a project's path for UNIQUE-constraint tombstoning. The raw DB
 * value is kept intact — this is display-only.
 */
export function displayPath(path: string): string {
  const idx = path.indexOf('::archived::');
  return idx === -1 ? path : path.slice(0, idx);
}
