// Copy non-TypeScript assets into dist/ after `tsc` runs.
// Kept deliberately small: one pair per line, no abstraction, no config.
// Add a new line here when a new asset directory needs to ship with the build.
//
// NOTE: paths are relative to cwd. This script is always invoked via
// `npm run build`, which sets cwd to the package root — do not run it
// from anywhere else or it will silently copy nothing.
import { chmod, cp } from 'node:fs/promises';

const bins = [
  'dist/cli/index.js',
  'dist/install.js',
];

const pairs = [
  ['src/db/migrations', 'dist/db/migrations'],
  ['src/prompts/defaults', 'dist/prompts/defaults'],
  ['src/ui/templates', 'dist/ui/templates'],
  ['src/ui/static', 'dist/ui/static'],
  ['src/cli/ticket.cjs', 'dist/cli/ticket.cjs'], // Agent ticket CLI (CJS, not compiled by tsc)
];

for (const [from, to] of pairs) {
  await cp(from, to, { recursive: true, force: true });
  console.log(`copied ${from} -> ${to}`);
}

for (const bin of bins) {
  await chmod(bin, 0o755);
  console.log(`chmod 755 ${bin}`);
}
