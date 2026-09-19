// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '*.mjs'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // tsc's own noUnusedLocals/noUnusedParameters already cover this and
      // understand the codebase's export-only-for-tests patterns better.
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
