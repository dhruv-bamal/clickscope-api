// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Allow an intentionally-unused parameter or destructured variable
      // when it's prefixed with `_` (e.g. the `_req` in an Express
      // handler that never reads the request).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  // Must be last: turns off any ESLint stylistic rule that would
  // conflict with Prettier, so the two tools never fight over formatting.
  eslintConfigPrettier,
);
