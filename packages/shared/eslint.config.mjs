import tseslint from 'typescript-eslint';
import { ignores, tsBase, prettierCompat, CONSTRAINT_IMPORTS } from '../../eslint.config.base.mjs';

/**
 * AECI-610 — the capability registry must import no zod.
 *
 * `src/entitlements.ts` is consumed by the lazy `/vendor` Angular route, and
 * this package's `package.json` records what one value import from an `api/*`
 * module already cost once: the entire schema set plus a 327 kB zod chunk
 * dragged into the Angular initial graph, shipped on every detail/browse page
 * (`STAGE_2_PAID_TIERS_SPEC.md` §3.1 / §10 R11).
 *
 * `api/*` is banned alongside `zod` itself because `no-restricted-imports` sees
 * only DIRECT imports — one hop through a wire-contract module reintroduces the
 * chunk with nothing to catch it. The dependency is one-way by design:
 * `api/admin-entitlements.ts` imports the tier ids FROM the registry.
 *
 * The `paths` / `patterns` from `CONSTRAINT_IMPORTS` are restated rather than
 * assumed: flat config REPLACES a rule's options per file rather than merging
 * them, so a block that set only the zod ban would silently drop the Prisma and
 * zone.js bans for this one file. Same trap `ANGULAR_STYLE_GUIDE.md` §24
 * documents for `apps/web`; `apps/web/src/eslint-config.spec.ts` asserts the
 * resolved config here so the restate can't rot.
 */
const [severity, constraintOptions] = CONSTRAINT_IMPORTS;

const NO_ZOD_IN_REGISTRY = {
  files: ['src/entitlements.ts'],
  rules: {
    'no-restricted-imports': [
      severity,
      {
        ...constraintOptions,
        patterns: [
          ...constraintOptions.patterns,
          {
            group: [
              'zod',
              'zod/*',
              './api/*',
              '../api/*',
              '@aeci/shared/api',
              '@aeci/shared/api/*',
            ],
            message:
              'The capability registry must import no zod and nothing from `api/*` — it ships in the lazy /vendor Angular route. Wire shapes belong in `src/api/admin-entitlements.ts`. See STAGE_2_PAID_TIERS_SPEC.md §3.1 (R11).',
          },
        ],
      },
    ],
  },
};

/**
 * AECI-304 — the version-diff engine must import no zod either.
 *
 * `STAGE_2_ATTESTATIONS_SPEC.md` §9.4 asked for this at the `aeci-515` merge, and
 * AECI-304 is that merge: `version-diff.ts` now imports `./entitlements`, and the
 * pair page reaches it as `@aeci/shared/version-diff` from a **lazy** route. The
 * `api/*` half of the ban is load-bearing in a second way here —
 * `src/api/product-pairs.ts` imports FROM this module, so an `./api/*` import back
 * would be an import cycle as well as a 327 kB zod regression.
 *
 * Its own block rather than a second entry in `NO_ZOD_IN_REGISTRY.files` so each
 * message names the module it is actually protecting.
 */
const NO_ZOD_IN_VERSION_DIFF = {
  files: ['src/version-diff.ts'],
  rules: {
    'no-restricted-imports': [
      severity,
      {
        ...constraintOptions,
        patterns: [
          ...constraintOptions.patterns,
          {
            group: [
              'zod',
              'zod/*',
              './api/*',
              '../api/*',
              '@aeci/shared/api',
              '@aeci/shared/api/*',
            ],
            message:
              'The version-diff engine must import no zod and nothing from `api/*` — it ships in the lazy product-pair Angular route, and `api/product-pairs.ts` imports FROM it. See STAGE_2_ATTESTATIONS_SPEC.md §9.4 / STAGE_2_PAID_TIERS_SPEC.md §3.1 (R11).',
          },
        ],
      },
    ],
  },
};

export default tseslint.config(
  ignores,
  ...tsBase,
  prettierCompat,
  NO_ZOD_IN_REGISTRY,
  NO_ZOD_IN_VERSION_DIFF,
);
