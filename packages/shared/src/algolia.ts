/**
 * Algolia index naming, API-key provisioning params, and index settings as code
 * (AECI-134 / Phase 3.1 + AECI-137 / Phase 3.2).
 *
 * No `algoliasearch` import; the only I/O (`applyIndexSettings`) goes through a
 * caller-injected client, so this module stays dependency-free and importable by
 * the operator/CI `.mjs` scripts via Node TS type-stripping. The single source of
 * truth for:
 *   - the per-environment physical index names (`<env>_products`, …),
 *   - the ACL + index-scope shape of the two standalone API keys the operator
 *     mints per env via `scripts/algolia/provision.mjs`, and
 *   - the per-index settings (searchable attributes, faceting, custom ranking)
 *     applied idempotently to every env via `applyIndexSettings`.
 *
 * Consumers:
 *   - `scripts/algolia/provision.mjs` (operator-run; creates indexes + mints keys),
 *   - `scripts/algolia/apply-settings.mjs` (operator/CI; applies the settings),
 *   - the SSR Worker's `algolia-bootstrap-inject.ts` (surfaces the public index
 *     names + search key to the browser),
 *   - sync (3.5/3.6) and `/search` (3.9) once they land.
 *
 * Record *shapes* (the denormalized Zod schemas) live in `./algolia-records`,
 * kept separate so `zod` never enters the `.mjs` type-strip graph. The
 * Supabase-row → record transform is `apps/api/src/lib/algolia-transforms.ts`.
 *
 * Spec: `STAGE_1_SPEC.md` §7.1 (three indexes + record shapes), §7.2 (faceting),
 * §7.3 (ranking); `CICD_PLAN.md` §2.2 (per-env index sets), §7.4 (rotate keys
 * independently per env), §7.5 (topology), §3.2 (the CI apply step). ADR 0006.
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

// ---------------------------------------------------------------------------
// Index settings as code (AECI-137 / Phase 3.2)
// ---------------------------------------------------------------------------

/**
 * The subset of Algolia index settings this project manages as code. Mirrors the
 * `algoliasearch` `IndexSettings` shape but is declared locally so this module
 * stays dependency-free (importable by the operator/CI `.mjs` scripts via Node
 * type-stripping, exactly like the naming/key helpers above).
 */
export type IndexSettings = {
  /** Full-text-searchable attributes, in priority order. `unordered(attr)` makes
   *  match position within that attribute irrelevant. */
  searchableAttributes: string[];
  /** Facetable attributes. `searchable(attr)` enables facet-value search on a
   *  refinement list; bare numeric attrs are faceted for range/bucket widgets. */
  attributesForFaceting: string[];
  /** Tie-breaker ranking applied after Algolia's default criteria, each
   *  `asc(attr)` / `desc(attr)` over a numeric or boolean attribute. */
  customRanking: string[];
};

/**
 * Numeric ranking weight per integration `mechanism_kind`, realizing the §7.3
 * priority `native > marketplace-app > iPaaS > api > webhook > partner` as a
 * `customRanking` signal. Algolia `customRanking` can only sort by a numeric or
 * boolean attribute, so the denormalized integrations record carries a derived
 * `mechanism_rank` (set by the transform from this map) — higher wins. An absent
 * or unknown kind ranks last (`0`). String-keyed (not typed to the enum) so this
 * file imports nothing; `IntegrationMechanismKindSchema` in `./api/integrations`
 * remains the source of truth for the *set* of valid kinds.
 */
export const MECHANISM_RANK: Readonly<Record<string, number>> = {
  native: 6,
  'marketplace-app': 5,
  iPaaS: 4,
  api: 3,
  webhook: 2,
  partner: 1,
};

/** Ranking weight for a `mechanism_kind`; `null`/`undefined`/unknown → `0`. */
export function mechanismRank(kind: string | null | undefined): number {
  if (kind == null) return 0;
  return MECHANISM_RANK[kind] ?? 0;
}

/**
 * Per-entity index settings per `STAGE_1_SPEC.md` §7.2 (faceting) and §7.3
 * (ranking). The single definition the apply routine, the sync pipeline
 * (3.5/3.6), and the CI step (CICD §3.2) all share.
 *
 * Faceting notes: `integration_count` (products/vendors), `founded_year`, and
 * `product_count` are faceted as bare numeric attributes so the `/search` UI
 * (3.9) can build range/bucket widgets over them — e.g. the §7.2 integration
 * buckets `0 / 1–10 / 11–50 / 51+` are `ais-numeric-menu` items over the numeric
 * attribute, not a stored field. `searchable(attr)` allows typing to filter a
 * long refinement list (categories, audiences, headquarters, product names).
 */
const INDEX_SETTINGS: Readonly<Record<IndexEntity, IndexSettings>> = {
  products: {
    searchableAttributes: [
      'name',
      'vendor_name',
      'categories',
      'audiences',
      'phases',
      'unordered(description)',
    ],
    attributesForFaceting: [
      'searchable(categories)',
      'searchable(audiences)',
      'searchable(phases)',
      'searchable(vendor_name)',
      'has_api_docs',
      'integration_count',
    ],
    customRanking: ['desc(integration_count)', 'desc(review_count)'],
  },
  vendors: {
    searchableAttributes: ['company_name', 'unordered(description)', 'headquarters'],
    attributesForFaceting: [
      'searchable(headquarters)',
      'founded_year',
      'product_count',
      'integration_count',
    ],
    customRanking: ['desc(integration_count)', 'desc(product_count)'],
  },
  integrations: {
    searchableAttributes: [
      'source_product_name',
      'target_product_name',
      'mechanism_name',
      'unordered(description)',
    ],
    attributesForFaceting: [
      'mechanism_kind',
      'direction',
      'searchable(source_product_name)',
      'searchable(target_product_name)',
    ],
    customRanking: ['desc(mechanism_rank)'],
  },
};

/** The managed index settings for one entity (§7.2 faceting, §7.3 ranking). */
export function indexSettingsFor(entity: IndexEntity): IndexSettings {
  return INDEX_SETTINGS[entity];
}

/**
 * The minimal slice of the `algoliasearch` v5 client `applyIndexSettings` needs.
 * Declared structurally (dependency injection) so this module never imports
 * `algoliasearch` — the operator/CI scripts and the sync Worker each construct
 * their own client and pass it in. `waitForTask` is optional: when present we
 * block until Algolia has applied the settings (deterministic for CI).
 */
export type AlgoliaSettingsClient = {
  setSettings(args: {
    indexName: string;
    indexSettings: IndexSettings;
    forwardToReplicas?: boolean;
  }): Promise<{ taskID: number }>;
  waitForTask?(args: { indexName: string; taskID: number }): Promise<unknown>;
};

/** Result of applying settings to one index. */
export type AppliedIndexSettings = {
  entity: IndexEntity;
  indexName: string;
  taskID: number;
};

/**
 * Idempotently apply the managed settings (`indexSettingsFor`) to all three of an
 * environment's indexes. This is the single routine the CI "update Algolia
 * indexes" step (CICD §3.2) and the sync scripts (3.5/3.6) both call.
 *
 * Idempotent because `setSettings` overwrites the index config with the same
 * definition — re-running with an unchanged `INDEX_SETTINGS` is a no-op at the
 * search layer. The client is injected (see `AlgoliaSettingsClient`) so this
 * stays dependency-free.
 */
export async function applyIndexSettings(
  client: AlgoliaSettingsClient,
  env: AlgoliaEnv,
): Promise<AppliedIndexSettings[]> {
  const names = indexNamesFor(env);
  const applied: AppliedIndexSettings[] = [];
  for (const entity of INDEX_ENTITIES) {
    const indexName = names[entity];
    const { taskID } = await client.setSettings({
      indexName,
      indexSettings: indexSettingsFor(entity),
    });
    if (client.waitForTask) {
      await client.waitForTask({ indexName, taskID });
    }
    applied.push({ entity, indexName, taskID });
  }
  return applied;
}
