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
 *   - sync (3.5/3.6) and `/search` (3.9) once they land,
 *   - `scripts/algolia/push-docs.mjs` (CI; the docs search index, AECI-1270).
 *
 * The docs index helpers (`docsIndexNameFor`, `syncDocsIndex`, the shared-key
 * params) sit beside `INDEX_ENTITIES`, never inside it. See the "Product docs
 * search" block below.
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
 * **This union must stay a superset of `Env['ENV']`** (`apps/api/src/env.ts`), or
 * the API Worker does not compile: two call sites assign the Worker's `ENV`
 * straight into an `AlgoliaEnv` position — `algoliaEnvFor()` in
 * `apps/api/src/lib/algolia-drift-deps.ts` and `syncAlgoliaAfterPromote()` in
 * `apps/api/src/routes/promote.ts`. Adding a tier to the Worker union without
 * adding it here is 2 × TS2322; the reverse is harmless. Membership here is a
 * COMPILE fact, not a claim that an index set exists — `indexPrefixForEnv` will
 * happily name a prefix nobody ever provisioned.
 */
export type AlgoliaEnv = 'development' | 'staging' | 'demo' | 'production';

/**
 * Physical index-name prefix. `development` folds onto `staging` (there is no
 * `development_*` set), so the prefix space is exactly three (staging, demo,
 * production). `demo` and `production` keep separate index sets — the demo
 * showcase must never read or write the live `production_*` indexes.
 *
 * The `preview_*` set retired with the per-PR preview tier (AECI-1268, ruled
 * 2026-10-10). Local runs now READ `staging_*`; every Worker write path refuses
 * to mutate it from a local run unless `ALGOLIA_ALLOW_LOCAL_WRITES` opts in
 * (`apps/api/src/lib/algolia-write-guard.ts`).
 */
export type AlgoliaIndexPrefix = 'staging' | 'demo' | 'production';

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
  /**
   * Per-IP hourly request cap. Set on the browser-facing SEARCH keys only: the
   * key ships in every page, and on the paid plan every request past the free
   * allowance is billed, so one address cannot run up a bill. Absent (no cap)
   * on the management keys, which only our servers and CI use.
   */
  maxQueriesPerIPPerHour?: number;
};

/**
 * The search keys' per-IP hourly cap (2026-10-26). A visitor typing and
 * scrolling for an hour makes about 100–200 calls, so real use never meets it;
 * one abusive address is held to about 12K a day.
 */
export const SEARCH_KEY_MAX_QUERIES_PER_IP_PER_HOUR = 500;

/** The role a provisioned key plays. */
export type AlgoliaKeyRole = 'search' | 'management';

/**
 * Map an `ENV` label to its index prefix. `development` (bare `wrangler dev`,
 * tests) folds onto `staging_*` so local/unscoped runs search the staging index
 * set rather than minting a fourth one — matching the `/api/version` convention
 * where the unset state reports `development` (CICD_PLAN §7.5).
 *
 * Any label that is not a deployed tier also folds onto `staging`. That covers a
 * stale `ENV=preview` left in a local `.dev.vars` after the preview tier retired
 * (AECI-1268): it reads `staging_*` instead of naming a deleted `preview_*` set.
 */
export function indexPrefixForEnv(env: AlgoliaEnv): AlgoliaIndexPrefix {
  return env === 'demo' || env === 'production' ? env : 'staging';
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
    // The docs index the tier READS (AECI-1270). Demo reads `production_docs`.
    indexes: [...indexListFor(env), ...replicaNamesFor(env), docsIndexNameFor(env)],
    description: keyDescription('search', env),
    maxQueriesPerIPPerHour: SEARCH_KEY_MAX_QUERIES_PER_IP_PER_HOUR,
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
    // The docs index only on a tier that WRITES it (AECI-1270). Demo reads
    // `production_docs` but never writes it, so its key does not reach it.
    indexes: [
      ...indexListFor(env),
      ...replicaNamesFor(env),
      ...(isDocsWriterPrefix(indexPrefixForEnv(env)) ? [docsIndexNameFor(env)] : []),
    ],
    description: keyDescription('management', env),
  };
}

// ---------------------------------------------------------------------------
// Product docs search (AECI-1270)
//
// Deliberately OUTSIDE `INDEX_ENTITIES`. The D1 sync, the drift check, the
// orphan sweep and `applyIndexSettingsTo` all loop over that list, and none of
// them may touch the docs index: its records come from the bundled Markdown,
// not from D1, and only `scripts/algolia/push-docs.mjs` writes them.
// ---------------------------------------------------------------------------

/** The two physical docs indexes. There is no `demo_docs`. */
export type DocsIndexName = 'staging_docs' | 'production_docs';

/** Both docs indexes, staging first. */
export const DOCS_INDEX_NAMES: readonly DocsIndexName[] = ['staging_docs', 'production_docs'];

function isDocsWriterPrefix(prefix: AlgoliaIndexPrefix): boolean {
  return prefix !== 'demo';
}

/**
 * The docs index a tier READS. `production` and `demo` read `production_docs`;
 * everything else (staging, development, a stale label) reads `staging_docs`.
 *
 * Deliberately NOT `indexPrefixForEnv`, which keeps demo on its own `demo_*`
 * set. The docs are the same Markdown on every tier, so demo showing the
 * production docs is correct, and a `demo_docs` index would only spend an index
 * slot (`SEARCH_RANKING.md` §5a). Demo never writes it: see `docsIndexWriterFor`.
 */
export function docsIndexNameFor(env: AlgoliaEnv): DocsIndexName {
  return env === 'production' || env === 'demo' ? 'production_docs' : 'staging_docs';
}

/**
 * The docs index a tier may WRITE: `staging_docs` for `staging`,
 * `production_docs` for `production`. Throws for `demo`, which reads
 * `production_docs` and must never write it, and for `development`, so a local
 * run can never push. The push script goes through this, never through
 * `docsIndexNameFor`.
 */
export function docsIndexWriterFor(env: AlgoliaEnv): DocsIndexName {
  if (env === 'staging') return 'staging_docs';
  if (env === 'production') return 'production_docs';
  throw new Error(
    `docs search: env "${env}" never writes a docs index. Only staging and production push; demo reads production_docs.`,
  );
}

/** One docs search record: a page lede or one `h2` section (with its `h3`s). */
export type DocsSearchRecord = {
  /** `<path>` for a lede, `<path>#<anchor>` for a section. Unique. */
  objectID: string;
  /** Which guide the page belongs to: `help` (General) or `vendor`. */
  guide: 'help' | 'vendor';
  /** The section label, e.g. "Reviewer guide". */
  section: string;
  page_title: string;
  /** The `h2` text, or the page title for a lede. */
  heading: string;
  /** Site-absolute: `/docs/<section>/<slug>` plus `#<anchor>` for a section. */
  url: string;
  /** Plain text, entities decoded, capped near 8 KB. */
  content: string;
  /** Global reading order: guide, section, page, then position in the page. */
  order: number;
};

/** The docs index's managed settings. Its own shape: it has snippets and no replicas. */
export type DocsIndexSettings = {
  searchableAttributes: string[];
  attributesForFaceting: string[];
  attributesToSnippet: string[];
  snippetEllipsisText: string;
  customRanking: string[];
};

/**
 * Settings for both docs indexes. A heading match outranks a title match,
 * which outranks body text. `guide` is filter-only: the box always filters on
 * it and never shows it as a facet. Ties keep reading order.
 */
export const DOCS_INDEX_SETTINGS: Readonly<DocsIndexSettings> = {
  searchableAttributes: ['heading', 'page_title', 'content'],
  attributesForFaceting: ['filterOnly(guide)'],
  attributesToSnippet: ['content:24'],
  snippetEllipsisText: '…',
  customRanking: ['asc(order)'],
};

/**
 * The slice of the `algoliasearch` v5 client `syncDocsIndex` needs, declared
 * structurally so this module never imports `algoliasearch`.
 */
export type DocsIndexClient = {
  setSettings(args: {
    indexName: string;
    indexSettings: DocsIndexSettings;
  }): Promise<{ taskID: number }>;
  saveObjects(args: {
    indexName: string;
    objects: Record<string, unknown>[];
  }): Promise<readonly { taskID: number }[]>;
  browseObjects(args: {
    indexName: string;
    browseParams: { attributesToRetrieve: string[]; hitsPerPage: number };
    aggregator: (response: { hits: readonly { objectID: string }[] }) => void;
  }): Promise<unknown>;
  deleteObjects(args: {
    indexName: string;
    objectIDs: string[];
  }): Promise<readonly { taskID: number }[]>;
  waitForTask(args: { indexName: string; taskID: number }): Promise<unknown>;
};

/** What one docs sync did. */
export type DocsSyncResult = {
  index: string;
  records: number;
  saved: number;
  deleted: number;
};

/**
 * Brings one docs index in line with `records`: settings, then save every
 * record, then browse the index and delete any id the build no longer has.
 *
 * Save BEFORE delete, and wait on each step, so there is no moment when a
 * page that still exists is missing from search. Never `replaceAllObjects`:
 * its temporary index takes a slot the app does not have
 * (`SEARCH_RANKING.md` §5a) and falls outside the scoped management key.
 */
export async function syncDocsIndex(
  client: DocsIndexClient,
  indexName: DocsIndexName,
  records: readonly DocsSearchRecord[],
): Promise<DocsSyncResult> {
  const ids = new Set(records.map((record) => record.objectID));
  if (ids.size !== records.length) {
    throw new Error(`docs search: duplicate objectIDs in the ${indexName} build`);
  }

  const settings = await client.setSettings({
    indexName,
    indexSettings: { ...DOCS_INDEX_SETTINGS },
  });
  await client.waitForTask({ indexName, taskID: settings.taskID });

  const saves = await client.saveObjects({
    indexName,
    objects: records.map((record) => ({ ...record })),
  });
  for (const { taskID } of saves) await client.waitForTask({ indexName, taskID });

  const stale: string[] = [];
  await client.browseObjects({
    indexName,
    browseParams: { attributesToRetrieve: ['objectID'], hitsPerPage: 1000 },
    aggregator: (response) => {
      for (const hit of response.hits) if (!ids.has(hit.objectID)) stale.push(hit.objectID);
    },
  });

  if (stale.length > 0) {
    const deletes = await client.deleteObjects({ indexName, objectIDs: stale });
    for (const { taskID } of deletes) await client.waitForTask({ indexName, taskID });
  }

  return {
    index: indexName,
    records: records.length,
    saved: records.length,
    deleted: stale.length,
  };
}

// ---------------------------------------------------------------------------
// Shared keys (AECI-1270)
//
// GitHub Actions holds ONE `ALGOLIA_SEARCH_KEY` and ONE `ALGOLIA_ADMIN_KEY` for
// every tier, so the key behind each must reach every tier's indexes. These
// list every index by name. Never `*`: a wildcard would also cover any index
// created later, by anyone.
// ---------------------------------------------------------------------------

/** The deployed tiers whose index sets the shared keys cover. */
const SHARED_KEY_TIERS = ['staging', 'demo', 'production'] as const satisfies readonly AlgoliaEnv[];

/** Every base index and replica on the three tiers, then both docs indexes. */
function sharedIndexList(): string[] {
  return [
    ...SHARED_KEY_TIERS.flatMap((env) => [...indexListFor(env), ...replicaNamesFor(env)]),
    ...DOCS_INDEX_NAMES,
  ];
}

/** The shared query-only key: `ALGOLIA_SEARCH_KEY` on every tier. */
export function sharedSearchKeyParams(): AlgoliaKeyParams {
  return {
    acl: [...searchKeyParams('staging').acl],
    indexes: sharedIndexList(),
    description: 'aeci:search:shared',
    maxQueriesPerIPPerHour: SEARCH_KEY_MAX_QUERIES_PER_IP_PER_HOUR,
  };
}

/** The shared management key: `ALGOLIA_ADMIN_KEY` in CI and on every API Worker. */
export function sharedManagementKeyParams(): AlgoliaKeyParams {
  return {
    acl: [...managementKeyParams('staging').acl],
    indexes: sharedIndexList(),
    description: 'aeci:management:shared',
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
   *  attribute (`asc(name_sort)` / `asc(company_name_sort)`) ahead of Algolia's
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
 * records as its primary, re-ordered by `ranking` (sort attribute first). Every
 * `/search` sort is a replica: the primary's relevance order is not an option
 * (ruled 2026-10-26, AECI-1486), and each tab opens on its first entry here.
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
 * Per-entity replica sorts (AECI-175). Products expose the five `/products`
 * sorts (Newest, Name A–Z, Recently updated, Highest rated, Most reviewed;
 * 2026-10-26). Vendors expose "Name A–Z". The Integrations tab is hidden on
 * `/search` (§7.5) so it has no sort UI and no replicas. Each option is a full
 * standard replica index, 6 per tier, which Algolia keeps in sync with its
 * primary automatically (no extra sync work) at the cost of duplicating the
 * primary's records. Standard, not virtual, because only a standard replica
 * orders strictly by the attribute, as `/products` does. The app moved to the
 * Grow plan (50 indexes) for these on 2026-10-26. See `SEARCH_RANKING.md` §5a.
 *
 * **The "Most integrations" replicas (`*_integration_count_desc`) are retired**
 * (AECI-636 PR-B): a count of integrations rewards exactly the shallow,
 * oversold connectors AECi exists to warn buyers about. Removing an entry here
 * only DETACHES that replica from its primary on the next apply — it survives as
 * a standalone index that still counts against the quota, and the CI key has no
 * `deleteIndex` ACL, so an operator deletes it by hand (`SEARCH_RANKING.md` §5a).
 * Do not re-add one to roll back: at the index cap Algolia refuses to create it
 * and the whole settings step fails. Roll back `customRanking` alone instead.
 *
 * **Adding a replica needs a key update first.** The search and management keys
 * list their indexes by name, so a new replica is unreachable (search 401s, the
 * deploy's `setSettings` 403s) until `scripts/algolia/provision.mjs --shared`
 * re-syncs the keys' index lists.
 *
 * **The A–Z replicas rank on `name_sort` / `company_name_sort`, NOT on the display
 * name** (AECI-825). Algolia orders a string attribute by lexicographical Unicode
 * order, so `asc(name)` put every capital ahead of every lowercase letter —
 * `ADP Workforce Now` before `Access Coins Evo`, `eSUB` after `Zoho`. Algolia
 * exposes no case-insensitive collation, so the key is precomputed on the record
 * instead (`algoliaSortKey` in `./algolia-records`). Changing either `ranking`
 * back to the display attribute reintroduces the defect silently — the sort still
 * "works", it is just wrong.
 */
const REPLICA_SORTS: Readonly<Record<IndexEntity, readonly ReplicaSort[]>> = {
  // Same tokens and order as the /products sort list (`productSortOptions()`),
  // so `?sort=` means the same thing on both pages (2026-10-26). Each ranks on
  // a field built by `productSortFields` in `./algolia-records`.
  products: [
    {
      sort: 'created',
      suffix: 'created_desc',
      ranking: ['desc(created_at_ts)', ...DEFAULT_RANKING_TAIL],
    },
    { sort: 'name', suffix: 'name_asc', ranking: ['asc(name_sort)', ...DEFAULT_RANKING_TAIL] },
    {
      sort: 'updated',
      suffix: 'updated_desc',
      ranking: ['desc(updated_at_ts)', ...DEFAULT_RANKING_TAIL],
    },
    {
      sort: 'rating',
      suffix: 'rating_desc',
      ranking: ['desc(rating_sort)', ...DEFAULT_RANKING_TAIL],
    },
    {
      sort: 'reviews',
      suffix: 'reviews_desc',
      ranking: ['desc(review_count)', ...DEFAULT_RANKING_TAIL],
    },
  ],
  vendors: [
    {
      sort: 'name',
      suffix: 'name_asc',
      ranking: ['asc(company_name_sort)', ...DEFAULT_RANKING_TAIL],
    },
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
 *
 * Ranking (AECI-636 PR-B): products and vendors tie-break on `listing_tier`
 * first — a content-only completeness tier (`./listing-tier`), 2 or 1, OMITTED
 * on a thin listing so it sorts last. It reads no plan, entitlement or verified
 * field, despite the word "tier" (`entitlements.spec.ts` block 4 proves it).
 * `integration_count` and `product_count` left `customRanking`: a count of
 * integrations rewards shallow connectors, and a count of products rewards
 * SKU-splitting. Both stay on the records and as facets, because a filter is the
 * buyer's intent rather than our verdict. Products keep `desc(review_count)` as
 * the tail by Chris's ruling of 2026-09-22; it departs from the 2026-08-23
 * decision ("a shrunk average, never a count") and is recorded on AECI-636.
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
    customRanking: ['desc(listing_tier)', 'desc(review_count)'],
  },
  vendors: {
    searchableAttributes: ['company_name', 'unordered(description)', 'headquarters'],
    attributesForFaceting: [
      'searchable(headquarters)',
      'founded_year',
      'product_count',
      'integration_count',
    ],
    customRanking: ['desc(listing_tier)'],
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
