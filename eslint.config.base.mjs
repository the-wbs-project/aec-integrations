import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';
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

/**
 * Shared Angular + TypeScript rule set for Angular apps in this monorepo
 * (apps/web, apps/stack-test). Spread into each app's config alongside
 * `tsBase`; per-app configs add their own selector prefixes and globals.
 *
 * Enforces the contract documented in `ANGULAR_STYLE_GUIDE.md`. See §24
 * (Appendix: ESLint enforcement matrix) for the rule-to-section mapping.
 */
export const angularBase = [
  {
    files: ['**/*.ts'],
    extends: [...angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-inferrable-types': 'warn',

      '@angular-eslint/prefer-standalone': 'error',
      '@angular-eslint/prefer-on-push-component-change-detection': 'error',
      '@angular-eslint/prefer-inject': 'error',
      // `@angular-eslint/prefer-inject` catches constructor-parameter DI but
      // does NOT catch `inject()` called inside a constructor body instead of
      // at field initialization. This rule closes that gap. Style guide §9.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'MethodDefinition[kind="constructor"] CallExpression[callee.name="inject"]',
          message:
            'Call inject() at field initialization, not inside the constructor body. See ANGULAR_STYLE_GUIDE.md §9.',
        },
      ],
      '@angular-eslint/prefer-host-metadata-property': 'error',
      '@angular-eslint/prefer-signal-model': 'error',
      '@angular-eslint/prefer-output-emitter-ref': 'error',
      '@angular-eslint/prefer-output-readonly': 'error',
      '@angular-eslint/computed-must-return': 'error',
      '@angular-eslint/no-input-rename': 'error',
      '@angular-eslint/no-output-rename': 'error',
      '@angular-eslint/use-lifecycle-interface': 'error',
      '@angular-eslint/no-empty-lifecycle-method': 'error',
      '@angular-eslint/no-async-lifecycle-method': 'error',
      '@angular-eslint/use-injectable-provided-in': 'error',

      '@angular-eslint/component-class-suffix': 'off',
      '@angular-eslint/directive-class-suffix': 'off',
    },
  },
  {
    files: ['**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
    rules: {
      '@angular-eslint/template/prefer-control-flow': 'error',
      '@angular-eslint/template/prefer-at-empty': 'error',
      '@angular-eslint/template/prefer-at-else': 'error',
      '@angular-eslint/template/use-track-by-function': 'error',
      '@angular-eslint/template/prefer-class-binding': 'error',
      '@angular-eslint/template/prefer-ngsrc': 'error',
      '@angular-eslint/template/no-any': 'error',
    },
  },
];

export default [ignores, ...tsBase, prettier];
