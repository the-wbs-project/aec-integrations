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
 * (apps/web). Spread into each app's config alongside
 * `tsBase`; per-app configs add their own selector prefixes and globals.
 *
 * Enforces the contract documented in `ANGULAR_STYLE_GUIDE.md`. See §24
 * (Appendix: ESLint enforcement matrix) for the rule-to-section mapping.
 */
const NO_INJECT_IN_CONSTRUCTOR = {
  // `@angular-eslint/prefer-inject` catches constructor-parameter DI but does
  // NOT catch `inject()` called inside a constructor body instead of at field
  // initialization. This selector closes that gap. Style guide §9.
  selector: 'MethodDefinition[kind="constructor"] CallExpression[callee.name="inject"]',
  message:
    'Call inject() at field initialization, not inside the constructor body. See ANGULAR_STYLE_GUIDE.md §9.',
};

/**
 * Brand voice (PRODUCT.md / DESIGN.md): no em dashes in user-visible copy.
 * Flags the em dash (U+2014) in string and inline-template literals — the only
 * places rendered copy lives in this app. Comments aren't literals, so they
 * stay allowed; the rule is also scoped (below) to exclude test files, whose
 * describe()/it() titles and assertion messages are developer-facing, not
 * rendered. The companion `--` rule can't be linted: `(--token)` Tailwind
 * arbitrary-property syntax is pervasive in class strings, so a blanket `--`
 * match would be all false positives — `--` stays enforced by code review.
 */
const NO_EM_DASH_IN_COPY = [
  {
    selector: 'Literal[value=/—/]',
    message:
      'No em dashes (—) in copy. Use commas, colons, semicolons, periods, or parentheses. See PRODUCT.md / DESIGN.md.',
  },
  {
    selector: 'TemplateElement[value.raw=/—/]',
    message:
      'No em dashes (—) in copy. Use commas, colons, semicolons, periods, or parentheses. See PRODUCT.md / DESIGN.md.',
  },
];

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
      // Constructor-body inject() guard (style guide §9). The em-dash brand
      // guard is a separate, test-exempt config block below (NO_EM_DASH_IN_COPY).
      'no-restricted-syntax': ['error', NO_INJECT_IN_CONSTRUCTOR],
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
    // Em-dash brand guard — shipped UI source only. Test files are exempt:
    // their describe()/it() titles and assertion messages are developer-facing,
    // not rendered copy. The exemption covers *.spec.ts plus *.harness.ts shared
    // test helpers (registered by thin specs; never collected as their own copy)
    // and e2e. Flat config replaces a rule's options per file rather than
    // merging, so this block restates the inject() guard alongside the em-dash
    // selectors (otherwise the guard above is dropped for these files).
    files: ['**/*.ts'],
    ignores: ['**/*.spec.ts', '**/*.harness.ts', '**/e2e/**'],
    rules: {
      'no-restricted-syntax': ['error', NO_INJECT_IN_CONSTRUCTOR, ...NO_EM_DASH_IN_COPY],
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
