// Copy non-TypeScript assets into dist/ after `tsc` runs.
// Kept deliberately small: one pair per line, no abstraction, no config.
// Add a new line here when a new asset directory needs to ship with the build.
import { cp } from 'node:fs/promises';

const pairs = [['src/db/migrations', 'dist/db/migrations']];

for (const [from, to] of pairs) {
  await cp(from, to, { recursive: true, force: true });
  console.log(`copied ${from} -> ${to}`);
}
