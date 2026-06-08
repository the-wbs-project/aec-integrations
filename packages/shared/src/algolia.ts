/**
 * Algolia index-naming + API-key provisioning parameters (AECI-134 / Phase 3.1).
 *
 * Pure data helpers — no `algoliasearch` import, no I/O. The single source of
 * truth for:
 *   - the per-environment physical index names (`<env>_products`, …), and
 *   - the ACL + index-scope shape of the two standalone API keys the operator
 *     mints per env via `scripts/algolia/provision.mjs`.
 *
 * Consumers:
 *   - `scripts/algolia/provision.mjs` (operator-run; creates indexes + mints keys),
 *   - the SSR Worker's `algolia-bootstrap-inject.ts` (surfaces the public index
 *     names + search key to the browser),
 *   - sync (3.5/3.6) and `/search` (3.9) once they land.
 *
 * Scope is index *names* + key *topology* ONLY. Searchable attributes, facets,
 * and ranking are set in 3.2; sync in 3.5/3.6; InstantSearch UI in 3.9.
 *
 * Spec: `STAGE_1_SPEC.md` §7.1 (three indexes), `CICD_PLAN.md` §2.2 (per-env
 * index sets), §7.4 (rotate keys independently per env), §7.5 (topology).
 * ADR 0006.
 */

/** Deployment-environment label, matching the Workers' `ENV` var (AECI-119). */
export type AlgoliaEnv = 'development' | 'preview' | 'staging' | 'production';

/**
 * Physical index-name prefix. `development` folds onto `preview` (there is no
 * `development_*` set), so the prefix space is exactly three.
 */
export type AlgoliaIndexPrefix = 'preview' | 'staging' | 'production';

/** The three entity indexes, in a stable order. */
export const INDEX_ENTITIES = ['products', 'vendors', 'integrations'] as const;
export type IndexEntity = (typeof INDEX_ENTITIES)[number];

/** Physical index names for an environment, keyed by entity. */
export type AlgoliaIndexNames = Record<IndexEntity, string>;

/** ACL + index-scope + description for an `addApiKey` call. */
export type AlgoliaKeyParams = {
  /** Algolia ACL list (e.g. `['search']`). */
  acl: string[];
  /** Index names this key is restricted to — never `['*']` for these keys. */
  indexes: string[];
  /** Stable `aeci:<role>:<prefix>` tag the provision script keys idempotency off. */
  description: string;
};

/** The role a provisioned key plays. */
export type AlgoliaKeyRole = 'search' | 'management';

/**
 * Map an `ENV` label to its index prefix. `development` (bare `wrangler dev`,
 * tests) folds onto `preview_*` so local/unscoped runs ride the preview index
 * set rather than minting a fourth one — matching the DD-tag + `/api/version`
 * convention where the unset state reports `development`. Previews get a
 * dedicated `preview_*` set (CICD_PLAN §2.1).
 */
export function indexPrefixForEnv(env: AlgoliaEnv): AlgoliaIndexPrefix {
  return env === 'development' ? 'preview' : env;
}

/** Physical index names for an env, e.g. `{ products: 'staging_products', … }`. */
export function indexNamesFor(env: AlgoliaEnv): AlgoliaIndexNames {
  const prefix = indexPrefixForEnv(env);
  return {
    products: `${prefix}_products`,
    vendors: `${prefix}_vendors`,
    integrations: `${prefix}_integrations`,
  };
}

/** Ordered list of the three physical index names for an env. */
export function indexListFor(env: AlgoliaEnv): string[] {
  const names = indexNamesFor(env);
  return INDEX_ENTITIES.map((entity) => names[entity]);
}

/** The `aeci:<role>:<prefix>` description tag used to find/rotate a key. */
export function keyDescription(role: AlgoliaKeyRole, env: AlgoliaEnv): string {
  return `aeci:${role}:${indexPrefixForEnv(env)}`;
}

/**
 * Params for the **search-only** key — query-only (`['search']`), scoped to the
 * env's three indexes. This is the key surfaced to the browser for InstantSearch
 * (3.9). It can do nothing but search; it can never write or read settings.
 */
export function searchKeyParams(env: AlgoliaEnv): AlgoliaKeyParams {
  return {
    acl: ['search'],
    indexes: indexListFor(env),
    description: keyDescription('search', env),
  };
}

/**
 * Params for the **management** key — search + index-mutation ACLs, scoped to
 * the env's three indexes. Stored as `ALGOLIA_ADMIN_KEY` per env for the sync
 * pipeline (3.5/3.6) and CI. Deliberately excludes the destructive/global ACLs
 * the root admin key carries (`deleteIndex`, `usage`, `logs`, `analytics`,
 * `seeUnretrievableAttributes`) so a leak can't drop indexes or read the whole
 * app — and so each env's key rotates independently (CICD_PLAN §7.4/§7.5).
 */
export function managementKeyParams(env: AlgoliaEnv): AlgoliaKeyParams {
  return {
    acl: ['search', 'addObject', 'deleteObject', 'editSettings', 'listIndexes'],
    indexes: indexListFor(env),
    description: keyDescription('management', env),
  };
}
