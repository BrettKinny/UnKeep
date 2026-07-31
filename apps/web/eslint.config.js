import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['.svelte-kit/', 'build/', 'dist/']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs['flat/recommended'],
  {
    files: ['**/*.{js,ts,svelte}'],
    languageOptions: {
      globals: globals.browser
    },
    rules: {
      // TypeScript already reports undefined names in typed sources.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': 'warn',
      // Svelte's reactive declarations are reported as false positives.
      'prefer-const': 'off',
      // Existing lists use stable domain ids where available; adding keys is a
      // separate rendering optimisation rather than a baseline correctness fix.
      'svelte/require-each-key': 'off',
      'svelte/no-unused-svelte-ignore': 'off',
      // Mutable Maps used for internal timers are not rendered state.
      'svelte/prefer-svelte-reactivity': 'off'
    }
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser
    }
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser
      }
    }
  }
);
