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
    '**/.lighthouseci/**',
    '**/playwright-report/**',
    '**/test-results/**',
    '**/*.min.js',
    '**/generated/**',
    '**/.vite/**',
    '**/worker-configuration.d.ts',
    '**/.dev.vars',
  ],
};

/**
 * Files whose contents are developer-facing rather than shipped: their string
 * literals are fixtures and assertion messages, not product code or rendered
 * copy. Rules that ban a *value* (an em dash, a `dark:` class, a forbidden
 * `Vary`) exempt them; rules that ban a *dependency* (Prisma, zone.js) do not.
 */
const TEST_FILES = ['**/*.spec.ts', '**/*.harness.ts', '**/e2e/**'];

/**
 * AECI-549 — the mechanically-checkable half of CLAUDE.md §"Constraints that
 * aren't negotiable". These were prose, so compliance depended on an agent
 * having read the right file; anything statically expressible belongs in the
 * linter instead. See ANGULAR_STYLE_GUIDE.md §24 for the rule-to-constraint map.
 *
 * Division of labour: ESLint owns the TypeScript AST (imports, identifiers,
 * member access, string and template literals). It cannot see Tailwind class
 * strings inside external `.html` templates, nor selectors in `.css` — those go
 * to `apps/web/scripts/check-source-constraints.mjs`, the same grep-guard
 * precedent AECI-153 established for the RTL logical-property rule.
 */

/**
 * Drizzle over the native D1 binding is the only DB path (ADR 0016 / AECI-278).
 * Prisma, Accelerate, a pg adapter, and the Postgres connection vars are all
 * gone and must not come back.
 *
 * Both selectors are deliberately narrow. The identifier match is exact-name so
 * an unrelated symbol containing the substring is untouched, and the connection
 * vars are `^…$`-anchored so a *sentence* mentioning `DATABASE_URL` (a log line,
 * an error message, or a fixture line in this rule's own spec) does not trip —
 * only the bare env-var name or a `foo.DATABASE_URL` access does. Comments are
 * not AST nodes, so the ~60 "Prisma is gone" archaeology comments across
 * `apps/api` stay legal.
 */
const NO_PRISMA_OR_PG = [
  {
    selector: 'Identifier[name=/^(getPrisma|prismaFor|PrismaClient)$/]',
    message:
      'No Prisma. DB access is Drizzle over the D1 `DB` binding via getDb(env). See ADR 0016 / CLAUDE.md.',
  },
  {
    selector:
      'MemberExpression[property.name=/^(DATABASE_URL|DIRECT_URL)$/], Literal[value=/^(DATABASE_URL|DIRECT_URL)$/]',
    message:
      'No Postgres connection vars. The Worker reaches D1 through its native `DB` binding. See ADR 0016 / CLAUDE.md.',
  },
];

/**
 * Light only (Stage 1, AECI-226). No `dark:` Tailwind variant, no `.theme-dark`
 * block, no toggle. Dark returns with the Stage 2 vendor portal as a token-block
 * re-introduction, not as scattered `dark:` utilities.
 *
 * Boundary-anchored the same way as the RTL guard's `PHYSICAL_UTILITY`: the
 * leading class is start-of-line / whitespace / a stacked-variant colon (so
 * `md:dark:bg-x` matches) / quote / backtick (`\x60`, since a literal backtick
 * cannot appear inside the template literal that builds this source). The
 * trailing `[a-z[(-]` requires a real utility to follow the colon, which is what
 * keeps prose like `'light and dark: themes'` or `'Dark: A Novel'` from
 * matching while still catching `dark:[&>svg]:x`, `dark:(--token)`, and
 * `dark:-mt-2`.
 *
 * This covers `.ts` only — inline templates are template literals, so they are
 * in scope, but external `.html` and `.css` are not. `check-source-constraints.mjs`
 * owns those, and deliberately does NOT scan `.ts`, so nothing double-reports.
 */
const DARK_VARIANT = String.raw`(^|[\s:"'\x60])dark:[a-z[(-]`;
const NO_DARK_THEME = [
  {
    selector: `Literal[value=/${DARK_VARIANT}/], TemplateElement[value.raw=/${DARK_VARIANT}/]`,
    message:
      'No `dark:` variants. Stage 1 ships one light theme (AECI-226). See CLAUDE.md "Light only (Stage 1)".',
  },
  {
    selector: String.raw`Literal[value=/\.theme-dark\b/], TemplateElement[value.raw=/\.theme-dark\b/]`,
    message:
      'No `.theme-dark` block. Stage 1 ships one light theme (AECI-226). See CLAUDE.md "Light only (Stage 1)".',
  },
];

/**
 * `Vary: Accept-Language` is permitted — URL-prefix locale dispatch already
 * handles the actual variance. Any other value (`Cookie`, `User-Agent`, …)
 * fragments the edge cache without a corresponding `Cache-Tag` advantage.
 *
 * The `:not([arguments.1.value="Accept-Language"])` carve-out is why this is a
 * usable rule rather than a blanket ban on touching the header: the one real
 * write site (`apps/web/src/server/seo-headers.ts`) does a delete-then-set of
 * exactly the permitted value and stays clean. esquery indexes into `arguments`
 * by position, so `arguments.0` / `arguments.1` address the header name and
 * value directly.
 *
 * The object-literal form covers `new Headers({ vary: 'Cookie' })`; `key.name`
 * matches a bare key and `key.value` a quoted one.
 */
const NO_FORBIDDEN_VARY = [
  {
    selector:
      'CallExpression[callee.property.name=/^(set|append)$/][arguments.0.value=/^vary$/i]:not([arguments.1.value="Accept-Language"])',
    message:
      'Only `Vary: Accept-Language` is permitted; any other value fragments the edge cache. See docs/CACHE_STRATEGY.md.',
  },
  {
    selector:
      'Property[key.name=/^vary$/i]:not([value.value="Accept-Language"]), Property[key.value=/^vary$/i]:not([value.value="Accept-Language"])',
    message:
      'Only `Vary: Accept-Language` is permitted; any other value fragments the edge cache. See docs/CACHE_STRATEGY.md.',
  },
];

/**
 * `vendors.verified` is a DENORMALIZED MIRROR of `vendor_entitlements`
 * (`docs/STAGE_2_PAID_TIERS_SPEC.md` §2.1), not an independent flag. The invariant —
 * `verified = true` IFF an `active` entitlement row exists — is only safe under D1's
 * no-interactive-transactions model if BOTH sides move inside one `db.batch([...])`,
 * so exactly one module emits both: `apps/api/src/lib/vendor-entitlement.ts`.
 *
 * This is Guard 1. Guard 2 is the `entitlement_mirror_drift` data-quality check
 * (04:00 UTC), which catches what lint structurally cannot: hand-written D1 SQL
 * against a tier, the `apps/datatool` worker, and a backfill that ran on staging but
 * not demo.
 *
 * Shaped to the Drizzle CHAIN, not to the property name, and using the
 * `> ObjectExpression > Property` child combinator rather than `:has()` — that is what
 * keeps every real near-miss clean: `columns: { verified: true }` read projections
 * (`routes/admin-claims.ts`, `lib/drizzle-helpers.ts`, `lib/algolia-transforms.ts`);
 * `db.update(vendors).set(writeColumns)` (`routes/vendor.ts` — an Identifier argument,
 * and that path is separately allow-listed by `VENDOR_COLUMN_MAP`, which has no
 * `verified` entry); the `.set({ companyName, promotionStatus, … })` upsert in
 * `routes/promote.ts`; and Angular's `signal.set({ … })`, which has no
 * `.update(vendors)` callee.
 *
 * The `insert`/`values` twin closes the "create a vendor already verified with no
 * entitlement row" hole, which the `.set` selector alone would miss.
 *
 * Limitation (accepted): `db.update(schema.vendors)` would evade the exact-name match.
 * Nothing in the repo writes it that way, and Guard 2 covers what Guard 1 cannot see —
 * which is precisely why there are two guards.
 */
const MIRROR_WRITE_MESSAGE =
  '`vendors.verified` is a denormalized mirror of `vendor_entitlements`. Only apps/api/src/lib/vendor-entitlement.ts may write it, and never without the entitlement statement in the same db.batch. See docs/STAGE_2_PAID_TIERS_SPEC.md §2.1.';

const NO_DIRECT_VERIFIED_WRITE = [
  {
    selector:
      'CallExpression[callee.property.name="set"][callee.object.callee.property.name="update"][callee.object.arguments.0.name="vendors"] > ObjectExpression > Property[key.name="verified"]',
    message: MIRROR_WRITE_MESSAGE,
  },
  {
    selector:
      'CallExpression[callee.property.name="values"][callee.object.callee.property.name="insert"][callee.object.arguments.0.name="vendors"] > ObjectExpression > Property[key.name="verified"]',
    message: MIRROR_WRITE_MESSAGE,
  },
];

/**
 * Constraint selectors that apply to every file, tests included: importing or
 * naming a decommissioned dependency is a violation wherever it happens.
 */
export const CONSTRAINT_SYNTAX_ALL = [...NO_PRISMA_OR_PG];

/**
 * Constraint selectors that apply to shipped source only. Tests legitimately
 * construct a forbidden *value* as a fixture in order to prove the code rejects
 * it — `seo-headers.spec.ts` builds `Vary: Cookie` upstream responses precisely
 * to assert the middleware strips them.
 */
export const CONSTRAINT_SYNTAX_SOURCE_ONLY = [...NO_DARK_THEME, ...NO_FORBIDDEN_VARY];

/**
 * The sole-writer tier (AECI-609). A THIRD tier rather than an entry in
 * `CONSTRAINT_SYNTAX_SOURCE_ONLY`, because this is the only constraint with a
 * per-FILE exemption and flat config REPLACES a rule's options per file: folding the
 * exemption into the source-only block would silently strip `dark:` and `Vary` from
 * the exempted files too.
 */
export const CONSTRAINT_SYNTAX_MIRROR = [...NO_DIRECT_VERIFIED_WRITE];

/**
 * Files exempt from the sole-writer rule — now EXACTLY ONE.
 *
 * `lib/vendor-entitlement.ts` is the permanent, by-design writer (§2.1).
 *
 * `lib/vendor-grant.ts` used to be a second, TEMPORARY baseline carve-out: it still
 * emitted the `verified` flip when AECI-609 landed the rule. **AECI-612 (§6 step 1)
 * deleted that statement** — `grantSeatStatements` no longer names `vendors` at all,
 * and `approveClaim` composes `activateEntitlementStatements` into the same
 * `db.batch` instead — so the carve-out is gone and the rule now covers that file
 * like any other. Landing a rule scoped to the clean subset and widening it as the
 * rest is cleaned up is the documented lifecycle (`ANGULAR_STYLE_GUIDE.md` §24
 * "Rule lifecycle"); this is the widening step.
 *
 * `**\/`-prefixed so the glob resolves under both the package basePath (`eslint .`
 * inside `apps/api`, which is how `pnpm -r run lint` runs) and the repo root (editors)
 * — the same reason `TEST_FILES` uses them.
 */
export const MIRROR_WRITE_EXEMPT = ['**/lib/vendor-entitlement.ts'];

/**
 * Decommissioned and forbidden dependencies (CLAUDE.md): Prisma / Accelerate and
 * every pg adapter (ADR 0016 — the Worker reaches D1 natively), plus zone.js and
 * the two `@angular/core` symbols that would silently re-enable zone-based
 * change detection under the zoneless constraint.
 */
export const CONSTRAINT_IMPORTS = [
  'error',
  {
    paths: [
      {
        name: '@prisma/client',
        message:
          'Prisma is removed. Use Drizzle over the D1 `DB` binding via getDb(env). ADR 0016.',
      },
      {
        name: '@prisma/extension-accelerate',
        message:
          'Accelerate is removed. The Worker reaches D1 through its native binding. ADR 0016.',
      },
      {
        name: 'pg',
        message: 'No pg adapter on the Worker. Use Drizzle over the D1 binding. ADR 0016.',
      },
      {
        name: 'postgres',
        message: 'No pg adapter on the Worker. Use Drizzle over the D1 binding. ADR 0016.',
      },
      {
        name: '@neondatabase/serverless',
        message: 'No pg adapter on the Worker. Use Drizzle over the D1 binding. ADR 0016.',
      },
      {
        name: 'drizzle-orm/node-postgres',
        message: 'Use `drizzle-orm/d1`. The app DB is Cloudflare D1. ADR 0016.',
      },
      {
        name: 'drizzle-orm/postgres-js',
        message: 'Use `drizzle-orm/d1`. The app DB is Cloudflare D1. ADR 0016.',
      },
      { name: 'zone.js', message: 'Zoneless Angular. Use provideZonelessChangeDetection().' },
      {
        name: '@angular/core',
        importNames: ['NgZone', 'provideZoneChangeDetection'],
        message:
          'Zoneless Angular. Use provideZonelessChangeDetection(). See ANGULAR_STYLE_GUIDE.md §3.',
      },
    ],
    patterns: [
      {
        group: ['@prisma/*', 'zone.js/*'],
        message: 'Prisma and zone.js are removed (ADR 0016 / zoneless constraint).',
      },
    ],
  },
];

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
  {
    // Scoped to source extensions on purpose: the block above has no `files`
    // key, so it also applies to the `.html` templates apps/web lints. Running
    // esquery selectors written against the ESTree AST over Angular's template
    // AST would be meaningless, so these two blocks restrict themselves.
    files: ['**/*.ts', '**/*.mjs'],
    rules: {
      'no-restricted-imports': CONSTRAINT_IMPORTS,
      'no-restricted-syntax': ['error', ...CONSTRAINT_SYNTAX_ALL],
    },
  },
  {
    files: ['**/*.ts'],
    ignores: TEST_FILES,
    rules: {
      'no-restricted-syntax': ['error', ...CONSTRAINT_SYNTAX_ALL, ...CONSTRAINT_SYNTAX_SOURCE_ONLY],
    },
  },
  {
    // The sole-writer tier (AECI-609). Restates BOTH earlier tiers, so a file in
    // `MIRROR_WRITE_EXEMPT` falls back to the block above (all + source-only) and
    // loses only this one selector family — it does not fall off the constraint set
    // entirely. `eslint-config.spec.ts` asserts exactly that, because flat config
    // replacing rather than merging is the trap this repo has been bitten by before.
    files: ['**/*.ts'],
    ignores: [...TEST_FILES, ...MIRROR_WRITE_EXEMPT],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...CONSTRAINT_SYNTAX_ALL,
        ...CONSTRAINT_SYNTAX_SOURCE_ONLY,
        ...CONSTRAINT_SYNTAX_MIRROR,
      ],
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
      '@angular-eslint/prefer-inject': 'error',
      // Constructor-body inject() guard (style guide §9), plus the all-files
      // constraint tier restated from `tsBase`. The em-dash brand guard and the
      // source-only constraint tier are a separate, test-exempt config block
      // below. Restating is mandatory, not redundant — see the comment there.
      'no-restricted-syntax': ['error', NO_INJECT_IN_CONSTRUCTOR, ...CONSTRAINT_SYNTAX_ALL],
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
    // Em-dash brand guard + the source-only constraint tier (AECI-549) —
    // shipped UI source only. Test files are exempt: their describe()/it()
    // titles and assertion messages are developer-facing, not rendered copy,
    // and their fixtures deliberately build forbidden values (a `Vary: Cookie`
    // upstream response) to prove the code rejects them. This covers both
    // *.spec.ts and the shared *.harness.ts test helpers (describe()/it()
    // titles live there too once specs are de-duplicated onto a harness).
    //
    // Flat config replaces a rule's options per file rather than merging, so
    // this block restates EVERY selector that should apply here — the inject()
    // guard from the block above and the all-files constraint tier from
    // `tsBase`. Dropping one from this list silently disables it for every
    // non-test file in apps/web. `eslint-config.spec.ts` asserts the resolved
    // config so that regression cannot land quietly.
    files: ['**/*.ts'],
    ignores: TEST_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        NO_INJECT_IN_CONSTRUCTOR,
        ...CONSTRAINT_SYNTAX_ALL,
        ...CONSTRAINT_SYNTAX_SOURCE_ONLY,
        // apps/web has no Drizzle, but this block is the LAST writer for every
        // apps/web `.ts` file (the app config spreads angularBase after tsBase), so
        // omitting the mirror tier here would silently drop it. No exempt globs:
        // apps/web has no sole-writer file, and adding them would over-exempt.
        ...CONSTRAINT_SYNTAX_MIRROR,
        ...NO_EM_DASH_IN_COPY,
      ],
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
