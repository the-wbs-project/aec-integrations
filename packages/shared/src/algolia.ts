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

/**
 * Deployment-environment label, matching the Workers' `ENV` var (AECI-119).
 *
 * `stage2` (the TEMPORARY Stage 2 test tier, AECI-637) is here for TYPE reasons
 * only — **no `stage2_*` indexes exist and none are meant to.** That tier ships
 * without search: it holds no `ALGOLIA_*` secrets, and the shared Algolia app is
 * over its index quota anyway (`docs/environments.md` §10.4). But two call sites
 * assign the Worker's `ENV` straight into an `AlgoliaEnv` position —
 * `apps/api/src/lib/algolia-drift-deps.ts` `algoliaEnvFor()` and
 * `apps/api/src/routes/promote.ts` `syncAlgoliaAfterPromote()` — so this union
 * has to stay a superset of `Env['ENV']` or the API Worker does not compile.
 * Both are inert on that tier: without credentials the sync is a graceful no-op,
 * and the tier runs no crons at all. Remove with the rest of AECI-637 at teardown.
 */
export type AlgoliaEnv = 'development' | 'preview' | 'staging' | 'demo' | 'production' | 'stage2';

/**
 * Physical index-name prefix. `development` folds onto `preview` (there is no
 * `development_*` set), so the prefix space is exactly four (preview, staging,
 * demo, production). `demo` and `production` keep separate index sets — the demo
 * showcase must never read or write the live `production_*` indexes.
 *
 * `stage2` rides along for the same compile-only reason as `AlgoliaEnv` above —
 * `indexPrefixForEnv` passes every non-`development` label straight through — and
 * names no index set that has ever been created.
 */
export type AlgoliaIndexPrefix = 'preview' | 'staging' | 'demo' | 'production' | 'stage2';

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

/**
 * The launch locale. Its indexes are the bare `<prefix>_<entity>` set (no locale
 * suffix), so the default `en-US` run uses exactly the indexes the search-key
 * scope and the CI settings step already manage.
 */
export const DEFAULT_LOCALE = 'en-US';

/**
 * Physical index names for an env **and locale** (§7.6 multi-language readiness).
 * The default locale maps to the bare names (`staging_products`); any other
 * locale appends `_<locale>` (`staging_products_es`, `staging_products_fr`), so
 * the bulk/daily sync can populate parallel per-locale indexes without a rewrite
 * when additional locales are added. At launch only `en-US` exists, so this
 * returns `indexNamesFor(env)` unchanged.
 */
export function localizedIndexNamesFor(
  env: AlgoliaEnv,
  locale: string = DEFAULT_LOCALE,
): AlgoliaIndexNames {
  const base = indexNamesFor(env);
  if (locale === DEFAULT_LOCALE) return base;
  return {
    products: `${base.products}_${locale}`,
    vendors: `${base.vendors}_${locale}`,
    integrations: `${base.integrations}_${locale}`,
  };
}

/** The `aeci:<role>:<prefix>` description tag used to find/rotate a key. */
export function keyDescription(role: AlgoliaKeyRole, env: AlgoliaEnv): string {
  return `aeci:${role}:${indexPrefixForEnv(env)}`;
}

/**
 * Params for the **search-only** key — query-only (`['search']`), scoped to the
 * env's three primary indexes **and their sort replicas** (AECI-175; the browser
 * `connectSortBy` queries a replica directly, so the key must reach it or the
 * query 401s). This is the key surfaced to the browser for InstantSearch (3.9).
 * It can do nothing but search; it can never write or read settings.
 */
export function searchKeyParams(env: AlgoliaEnv): AlgoliaKeyParams {
  return {
    acl: ['search'],
    indexes: [...indexListFor(env), ...replicaNamesFor(env)],
    description: keyDescription('search', env),
  };
}

/**
 * Params for the **management** key — search/browse + index-mutation ACLs, scoped
 * to the env's three indexes. Stored as `ALGOLIA_ADMIN_KEY` per env for the sync
 * pipeline (3.5/3.6) and CI. `browse` is required by the orphan sweep (AECI-266),
 * which enumerates every objectID via the `/browse` endpoint — a separate ACL from
 * `search` (which only covers `/query`). Deliberately excludes the
 * destructive/global ACLs the root admin key carries (`deleteIndex`, `usage`,
 * `logs`, `analytics`, `seeUnretrievableAttributes`) so a leak can't drop indexes
 * or read the whole app — and so each env's key rotates independently
 * (CICD_PLAN §7.4/§7.5).
 */
export function managementKeyParams(env: AlgoliaEnv): AlgoliaKeyParams {
  return {
    acl: ['search', 'browse', 'addObject', 'deleteObject', 'editSettings', 'listIndexes'],
    // Includes the sort replicas (AECI-175) so the apply step can `setSettings`
    // each replica's `ranking`; without it the replica `setSettings` 403s.
    indexes: [...indexListFor(env), ...replicaNamesFor(env)],
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
  /** Replica index names linked to this **primary** index (AECI-175). Set at
   *  apply time from the env's physical names — `INDEX_SETTINGS` keeps the
   *  env-agnostic §7.3 shape, so this is absent on `indexSettingsFor()`. */
  replicas?: string[];
  /** Full `ranking` override — only set on a **replica** index to force its sort
   *  attribute (`asc(name)` / `desc(integration_count)`) ahead of Algolia's
   *  default criteria. The primary never overrides `ranking` (SEARCH_RANKING §2). */
  ranking?: string[];
};

// ---------------------------------------------------------------------------
// Replica sort indexes (AECI-175 / §4.6 per-tab sort)
// ---------------------------------------------------------------------------

/**
 * Algolia's default ranking criteria, kept after a replica's leading sort
 * attribute so a non-relevance sort still tie-breaks the §7.3 way.
 */
const DEFAULT_RANKING_TAIL = [
  'typo',
  'geo',
  'words',
  'filters',
  'proximity',
  'attribute',
  'exact',
  'custom',
] as const;

/**
 * One non-relevance sort exposed on a `/search` tab, realized as a **standard
 * Algolia replica** of the entity's primary index. The replica returns the same
 * records as its primary, re-ordered by `ranking` (sort attribute first). The
 * default `relevance` sort is **not** listed here — it is the primary index
 * itself.
 */
export type ReplicaSort = {
  /** Stable token used in the `?sort=` URL param and the i18n label key. */
  sort: string;
  /** Physical index-name suffix appended to the primary, e.g. `name_asc`. */
  suffix: string;
  /** The replica's full `ranking` — the sort criterion first, then defaults. */
  ranking: string[];
};

/**
 * Per-entity replica sorts (AECI-175). Products and Vendors each expose
 * "Most integrations" and "Name A–Z"; the Integrations tab is hidden on
 * `/search` (§7.5) so it has no sort UI and no replicas. Each extra option is a
 * full standard replica index — i.e. 4 replicas total — which Algolia keeps in
 * sync with its primary automatically (no extra sync work) at the cost of
 * duplicating the primary's records for quota/billing. See `SEARCH_RANKING.md`.
 */
const REPLICA_SORTS: Readonly<Record<IndexEntity, readonly ReplicaSort[]>> = {
  products: [
    {
      sort: 'integrations',
      suffix: 'integration_count_desc',
      ranking: ['desc(integration_count)', ...DEFAULT_RANKING_TAIL],
    },
    { sort: 'name', suffix: 'name_asc', ranking: ['asc(name)', ...DEFAULT_RANKING_TAIL] },
  ],
  vendors: [
    {
      sort: 'integrations',
      suffix: 'integration_count_desc',
      ranking: ['desc(integration_count)', ...DEFAULT_RANKING_TAIL],
    },
    { sort: 'name', suffix: 'name_asc', ranking: ['asc(company_name)', ...DEFAULT_RANKING_TAIL] },
  ],
  integrations: [],
};

/** The replica sorts an entity exposes on `/search` (empty for integrations). */
export function sortReplicasFor(entity: IndexEntity): readonly ReplicaSort[] {
  return REPLICA_SORTS[entity];
}

/** Physical replica index name: `<primary>_<suffix>` (e.g. `staging_products_name_asc`). */
export function replicaIndexName(baseName: string, suffix: string): string {
  return `${baseName}_${suffix}`;
}

/**
 * Every replica physical name for an env's canonical index set, in
 * entity → sort order. Used to widen the provisioned API keys' index scope and
 * by the provision/apply scripts. Mirrors `indexListFor` for the base indexes.
 */
export function replicaNamesFor(env: AlgoliaEnv): string[] {
  const names = indexNamesFor(env);
  return INDEX_ENTITIES.flatMap((entity) =>
    REPLICA_SORTS[entity].map((replica) => replicaIndexName(names[entity], replica.suffix)),
  );
}

/**
 * Numeric ranking weight per integration `mechanism_kind`, realizing the §7.3
 * priority `native > marketplace-app > iPaaS > api > webhook > partner` as a
 * `customRanking` signal. Algolia `customRanking` can only sort by a numeric or
 * boolean attribute, so the denormalized integrations record carries a derived
 * `mechanism_rank` (set by the transform from this map) — higher wins. An absent
 * or unknown kind ranks last (`0`). String-keyed (not typed to the enum) so this
 * file imports nothing; `IntegrationMechanismKindSchema` in `./api/integrations`
 * remains the source of truth for the *set* of valid kinds.
 *
 * `integrator` (AECI-698 / AECI-721) ties `partner` at 1 ON PURPOSE. It REPLACES
 * `partner` — an SI or consultancy built and maintains the edge, neither endpoint
 * vendor did — so the upstream re-key of ~117 rows is a CLASSIFICATION change, and
 * a classification-only migration must not silently re-rank the catalog
 * (`STAGE_1_5_SPEC.md` §13.5's own principle). Tying also means no existing weight
 * is renumbered, so no full reindex is forced for rank alone. Promoting
 * `integrator` above `partner` later is a separate, deliberate decision.
 */
export const MECHANISM_RANK: Readonly<Record<string, number>> = {
  native: 6,
  'marketplace-app': 5,
  iPaaS: 4,
  api: 3,
  webhook: 2,
  partner: 1,
  integrator: 1,
};

/**
 * Ranking weight for a **connector-evidenced pair** — a delivered edge that lives in
 * `connector_evidenced_pairs` rather than `integrations` (AECI-721 / §13.1's delivered
 * tier). Those rows carry no `mechanism_kind` at all: the table has no such column,
 * because once an edge is filed under the connector that delivers it, "which mechanism"
 * is answered by the lane rather than by a value.
 *
 * Fixed at `4` — the weight `iPaaS` carries — rather than falling through
 * `mechanismRank(null)` to `0`. Connector delivery is precisely what these rows ARE, so
 * ranking them as unknown would be wrong twice over: it would drop every migrated edge
 * to last place, and it would do so silently, as an artifact of an internal storage move.
 * Prod effect is bounded and named: the 1 migrating `iPaaS` row is rank-neutral, and the
 * 17 migrating `marketplace-app` rows demote 5 → 4 (`SEARCH_RANKING.md` §4).
 *
 * The pin to `MECHANISM_RANK.iPaaS` (asserted in the spec) is now permanently safe:
 * AECI-735 settled that `iPaaS` never leaves the vocabulary, so this constant cannot
 * be orphaned by a later retirement.
 */
export const CONNECTOR_EVIDENCED_MECHANISM_RANK = 4;

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
 *
 * Trades (AECI-545 / §5.5a) are the fourth taxonomy facet, and the two trade
 * attributes are deliberately asymmetric: `trades` is both searchable and
 * faceted, while `trade_aliases` is SEARCHABLE ONLY — flattened synonyms exist
 * to widen recall ("blacktop" → paving), and faceting them would put colloquial
 * duplicates in the refinement list. `trades` ranks above `trade_aliases`
 * because a canonical trade name is the stronger intent signal, and neither
 * touches `customRanking`: a trade tag is a factual claim about scope, never a
 * quality or commercial signal (no pay-for-placement). See `SEARCH_RANKING.md`
 * §3.1.
 */
const INDEX_SETTINGS: Readonly<Record<IndexEntity, IndexSettings>> = {
  products: {
    searchableAttributes: [
      'name',
      'vendor_name',
      'categories',
      'audiences',
      'phases',
      'trades',
      'trade_aliases',
      'unordered(description)',
    ],
    attributesForFaceting: [
      'searchable(categories)',
      'searchable(audiences)',
      'searchable(phases)',
      'searchable(trades)',
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
  /** Whether this index is the entity's primary or one of its sort replicas. */
  role: 'primary' | 'replica';
};

/**
 * Idempotently apply the managed settings (`indexSettingsFor`) to a specific set
 * of physical index names (one per entity). The locale-aware lower level used by
 * the sync scripts (3.5/3.6): pass `localizedIndexNamesFor(env, locale)` to
 * configure a per-locale index set, or `indexNamesFor(env)` for the canonical
 * (default-locale) set.
 *
 * Idempotent because `setSettings` overwrites the index config with the same
 * definition — re-running with an unchanged `INDEX_SETTINGS` is a no-op at the
 * search layer. The client is injected (see `AlgoliaSettingsClient`) so this
 * stays dependency-free.
 */
export async function applyIndexSettingsTo(
  client: AlgoliaSettingsClient,
  names: AlgoliaIndexNames,
): Promise<AppliedIndexSettings[]> {
  const applied: AppliedIndexSettings[] = [];
  for (const entity of INDEX_ENTITIES) {
    const primaryName = names[entity];
    const base = indexSettingsFor(entity);
    const replicas = sortReplicasFor(entity);
    const replicaNames = replicas.map((replica) => replicaIndexName(primaryName, replica.suffix));

    // 1. Primary — managed §7.2/§7.3 settings + the `replicas` link. Setting the
    //    `replicas` array is what creates/maintains the replica indexes; it is
    //    always written (an empty list detaches any stray replicas, keeping the
    //    config purely code-defined). Replica names derive from `primaryName`, so
    //    a per-locale `names` set (§7.6) gets per-locale replicas for free.
    const { taskID } = await client.setSettings({
      indexName: primaryName,
      indexSettings: { ...base, replicas: replicaNames },
    });
    if (client.waitForTask) {
      await client.waitForTask({ indexName: primaryName, taskID });
    }
    applied.push({ entity, indexName: primaryName, taskID, role: 'primary' });

    // 2. Each replica — same searchable/faceting/customRanking as the primary
    //    (so the facet sidebar keeps working under any sort), with its own
    //    `ranking` forcing the sort attribute first. Not forwarded: each
    //    replica's `ranking` is distinct.
    for (const replica of replicas) {
      const replicaName = replicaIndexName(primaryName, replica.suffix);
      const { taskID: replicaTaskID } = await client.setSettings({
        indexName: replicaName,
        indexSettings: {
          searchableAttributes: base.searchableAttributes,
          attributesForFaceting: base.attributesForFaceting,
          customRanking: base.customRanking,
          ranking: replica.ranking,
        },
      });
      if (client.waitForTask) {
        await client.waitForTask({ indexName: replicaName, taskID: replicaTaskID });
      }
      applied.push({ entity, indexName: replicaName, taskID: replicaTaskID, role: 'replica' });
    }
  }
  return applied;
}

/**
 * Idempotently apply the managed settings to all three of an environment's
 * canonical (default-locale) indexes. This is the single routine the CI "update
 * Algolia indexes" step (CICD §3.2) and the sync scripts (3.5/3.6) call for the
 * `en-US` index set; locale-specific runs go through `applyIndexSettingsTo`.
 */
export async function applyIndexSettings(
  client: AlgoliaSettingsClient,
  env: AlgoliaEnv,
): Promise<AppliedIndexSettings[]> {
  return applyIndexSettingsTo(client, indexNamesFor(env));
}
