import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export const ignores = {
  ignores: [
    '**/node_modules/**',
    '**/dist/**',
    '**/.angular/**',
    '**/.wrangler/**',
    '**/.agents/**',
    '**/.claude/**',
    '**/coverage/**',
    '**/playwright-report/**',
    '**/test-results/**',
    '**/*.min.js',
    '**/generated/**',
    '**/.vite/**',
    '**/worker-configuration.d.ts',
    '**/.dev.vars',
  ],
};

export const tsBase = [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2024,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];

export const prettierCompat = prettier;

export default [ignores, ...tsBase, prettier];
