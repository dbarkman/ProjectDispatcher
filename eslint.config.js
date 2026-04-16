// ESLint 9 flat config. Kept minimal on purpose — we lean on TypeScript for
// most correctness and Prettier for formatting. Add rules only when we actually
// hit a class of bug we want to prevent, not preemptively.
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'scripts/**', 'src/ui/static/vendor/**'],
  },
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
);
