import { describe, expect, it } from 'vitest';

import {
  applyIndexSettings,
  applyIndexSettingsTo,
  DEFAULT_LOCALE,
  DOCS_INDEX_NAMES,
  DOCS_INDEX_SETTINGS,
  docsIndexNameFor,
  docsIndexWriterFor,
  sharedManagementKeyParams,
  sharedSearchKeyParams,
  syncDocsIndex,
  type DocsIndexClient,
  type DocsSearchRecord,
  INDEX_ENTITIES,
  indexListFor,
  indexNamesFor,
  indexPrefixForEnv,
  indexSettingsFor,
  keyDescription,
  localizedIndexNamesFor,
  managementKeyParams,
  CONNECTOR_EVIDENCED_MECHANISM_RANK,
  MECHANISM_RANK,
  mechanismRank,
  replicaIndexName,
  replicaNamesFor,
  searchKeyParams,
  sortReplicasFor,
  type AlgoliaEnv,
  type AlgoliaSettingsClient,
  type IndexSettings,
} from './algolia';

describe('INDEX_ENTITIES', () => {
  it('is the three entity indexes in a stable order', () => {
    expect(INDEX_ENTITIES).toEqual(['products', 'vendors', 'integrations']);
  });
});

describe('indexPrefixForEnv', () => {
  it('folds development onto the staging index set (AECI-1268)', () => {
    expect(indexPrefixForEnv('development')).toBe('staging');
  });

  it('folds a stale non-tier label (a retired ENV=preview) onto staging, never a deleted set', () => {
    expect(indexPrefixForEnv('preview' as AlgoliaEnv)).toBe('staging');
  });

  it('maps staging/demo/production to themselves', () => {
    expect(indexPrefixForEnv('staging')).toBe('staging');
    expect(indexPrefixForEnv('demo')).toBe('demo');
    expect(indexPrefixForEnv('production')).toBe('production');
  });
});

describe('indexNamesFor', () => {
  it('produces <prefix>_<entity> names per environment', () => {
    expect(indexNamesFor('staging')).toEqual({
      products: 'staging_products',
      vendors: 'staging_vendors',
      integrations: 'staging_integrations',
    });
    expect(indexNamesFor('production')).toEqual({
      products: 'production_products',
      vendors: 'production_vendors',
      integrations: 'production_integrations',
    });
  });

  it('uses the staging_* set for development (the preview_* set retired, AECI-1268)', () => {
    expect(indexNamesFor('development')).toEqual(indexNamesFor('staging'));
  });

  it('keeps demo on its own index set, separate from production (the showcase must never touch live indexes)', () => {
    expect(indexNamesFor('demo')).toEqual({
      products: 'demo_products',
      vendors: 'demo_vendors',
      integrations: 'demo_integrations',
    });
    expect(indexNamesFor('demo')).not.toEqual(indexNamesFor('production'));
  });
});

describe('indexListFor', () => {
  it('returns the three names in INDEX_ENTITIES order', () => {
    expect(indexListFor('production')).toEqual([
      'production_products',
      'production_vendors',
      'production_integrations',
    ]);
  });
});

describe('localizedIndexNamesFor', () => {
  it('returns the bare canonical names for the default locale', () => {
    expect(DEFAULT_LOCALE).toBe('en-US');
    expect(localizedIndexNamesFor('staging', 'en-US')).toEqual(indexNamesFor('staging'));
    // Defaulting the locale arg is equivalent to passing en-US.
    expect(localizedIndexNamesFor('production')).toEqual(indexNamesFor('production'));
  });

  it('suffixes every index with _<locale> for a non-default locale (§7.6)', () => {
    expect(localizedIndexNamesFor('staging', 'es')).toEqual({
      products: 'staging_products_es',
      vendors: 'staging_vendors_es',
      integrations: 'staging_integrations_es',
    });
    expect(localizedIndexNamesFor('production', 'fr')).toEqual({
      products: 'production_products_fr',
      vendors: 'production_vendors_fr',
      integrations: 'production_integrations_fr',
    });
  });

  it('folds development onto the staging set before suffixing', () => {
    expect(localizedIndexNamesFor('development', 'es')).toEqual(
      localizedIndexNamesFor('staging', 'es'),
    );
  });
});

describe('keyDescription', () => {
  it('tags by role and index prefix (development folds to staging)', () => {
    expect(keyDescription('search', 'staging')).toBe('aeci:search:staging');
    expect(keyDescription('management', 'production')).toBe('aeci:management:production');
    expect(keyDescription('search', 'development')).toBe('aeci:search:staging');
  });
});

describe('searchKeyParams', () => {
  it('is query-only and scoped to the env indexes + their sort replicas (AECI-175)', () => {
    const params = searchKeyParams('staging');
    expect(params.acl).toEqual(['search']);
    expect(params.indexes).toEqual([
      'staging_products',
      'staging_vendors',
      'staging_integrations',
      'staging_products_created_desc',
      'staging_products_name_asc',
      'staging_products_updated_desc',
      'staging_products_rating_desc',
      'staging_products_reviews_desc',
      'staging_vendors_name_asc',
      'staging_docs',
    ]);
    expect(params.description).toBe('aeci:search:staging');
  });

  it('caps requests per IP per hour, because the key ships in every page', () => {
    expect(searchKeyParams('production').maxQueriesPerIPPerHour).toBe(500);
    expect(sharedSearchKeyParams().maxQueriesPerIPPerHour).toBe(500);
  });

  it('leaves the server-side management keys uncapped', () => {
    expect(managementKeyParams('production').maxQueriesPerIPPerHour).toBeUndefined();
    expect(sharedManagementKeyParams().maxQueriesPerIPPerHour).toBeUndefined();
  });

  it('grants no write or settings ACL', () => {
    const { acl } = searchKeyParams('production');
    for (const forbidden of ['addObject', 'deleteObject', 'editSettings', 'deleteIndex']) {
      expect(acl).not.toContain(forbidden);
    }
  });
});

describe('managementKeyParams', () => {
  it('grants search + index-mutation ACLs scoped to the env indexes + sort replicas', () => {
    const params = managementKeyParams('production');
    expect(params.acl).toEqual([
      'search',
      'browse',
      'addObject',
      'deleteObject',
      'editSettings',
      'listIndexes',
    ]);
    expect(params.indexes).toEqual([
      'production_products',
      'production_vendors',
      'production_integrations',
      'production_products_created_desc',
      'production_products_name_asc',
      'production_products_updated_desc',
      'production_products_rating_desc',
      'production_products_reviews_desc',
      'production_vendors_name_asc',
      'production_docs',
    ]);
    expect(params.description).toBe('aeci:management:production');
  });

  it('excludes the destructive/global ACLs the root admin key carries', () => {
    const { acl } = managementKeyParams('staging');
    for (const forbidden of [
      'deleteIndex',
      'usage',
      'logs',
      'analytics',
      'seeUnretrievableAttributes',
    ]) {
      expect(acl).not.toContain(forbidden);
    }
  });

  it('is scoped to indexes, never the whole app', () => {
    for (const env of ['staging', 'demo', 'production'] as AlgoliaEnv[]) {
      expect(managementKeyParams(env).indexes).not.toContain('*');
      expect(searchKeyParams(env).indexes).not.toContain('*');
    }
  });
});

// ---------------------------------------------------------------------------
// AECI-175 — replica sort indexes
// ---------------------------------------------------------------------------

describe('sortReplicasFor', () => {
  // Products mirror the /products sort list, same tokens, same order
  // (`productSortOptions()`), so `?sort=` means the same on both pages.
  it('exposes the five /products sorts for products and "Name A–Z" for vendors', () => {
    expect(sortReplicasFor('products').map((s) => s.sort)).toEqual([
      'created',
      'name',
      'updated',
      'rating',
      'reviews',
    ]);
    expect(sortReplicasFor('products').map((s) => s.suffix)).toEqual([
      'created_desc',
      'name_asc',
      'updated_desc',
      'rating_desc',
      'reviews_desc',
    ]);
    expect(sortReplicasFor('vendors').map((s) => s.sort)).toEqual(['name']);
    expect(sortReplicasFor('vendors').map((s) => s.suffix)).toEqual(['name_asc']);
  });

  // AECI-636: no replica may sort on an integration or product count again. A
  // count of integrations rewards shallow connectors. `review_count` is allowed
  // since 2026-10-26: "Most reviewed" is a sort the reader picks, the same one
  // /products already offers, and `review_count` already sits in the default
  // ranking by the 2026-09-22 ruling (`SEARCH_RANKING.md` §3.1).
  it('no replica ranks on integration_count or product_count', () => {
    for (const entity of INDEX_ENTITIES) {
      for (const replica of sortReplicasFor(entity)) {
        expect(replica.suffix).not.toMatch(/integration|product_count/);
        for (const criterion of replica.ranking) {
          expect(criterion).not.toMatch(/integration_count|product_count/);
        }
      }
    }
  });

  it('leads each replica ranking with its sort attribute, then Algolia defaults', () => {
    const tail = ['typo', 'geo', 'words', 'filters', 'proximity', 'attribute', 'exact', 'custom'];
    expect(sortReplicasFor('products').map((r) => r.ranking)).toEqual([
      ['desc(created_at_ts)', ...tail],
      ['asc(name_sort)', ...tail],
      ['desc(updated_at_ts)', ...tail],
      ['desc(rating_sort)', ...tail],
      ['desc(review_count)', ...tail],
    ]);
    expect(sortReplicasFor('vendors')[0]!.ranking).toEqual(['asc(company_name_sort)', ...tail]);
  });

  // AECI-825 — Algolia orders a string attribute by lexicographical Unicode order,
  // so ranking on the DISPLAY name puts every capital ahead of every lowercase
  // letter. The A–Z replicas must rank on the precomputed folded key instead. This
  // asserts the negative because the regression is silent: the sort keeps working,
  // it is just wrong, and no request fails.
  it('ranks A–Z on the folded sort key, never on the display attribute', () => {
    const productsAz = sortReplicasFor('products').find((r) => r.sort === 'name')!;
    expect(productsAz.ranking[0]).toBe('asc(name_sort)');
    expect(productsAz.ranking).not.toContain('asc(name)');
    expect(sortReplicasFor('vendors')[0]!.ranking[0]).toBe('asc(company_name_sort)');
    expect(sortReplicasFor('vendors')[0]!.ranking).not.toContain('asc(company_name)');
  });

  it('gives the hidden integrations tab no replicas (§7.5)', () => {
    expect(sortReplicasFor('integrations')).toEqual([]);
  });
});

describe('replicaIndexName / replicaNamesFor', () => {
  it('joins primary + suffix', () => {
    expect(replicaIndexName('staging_products', 'name_asc')).toBe('staging_products_name_asc');
  });

  it('lists every replica physical name for an env in entity → sort order', () => {
    expect(replicaNamesFor('staging')).toEqual([
      'staging_products_created_desc',
      'staging_products_name_asc',
      'staging_products_updated_desc',
      'staging_products_rating_desc',
      'staging_products_reviews_desc',
      'staging_vendors_name_asc',
    ]);
    expect(replicaNamesFor('development')).toEqual(replicaNamesFor('staging'));
  });
});

// ---------------------------------------------------------------------------
// AECI-137 — index settings as code
// ---------------------------------------------------------------------------

describe('indexSettingsFor', () => {
  it('products: ranks by listing_tier then review_count (AECI-636 PR-B)', () => {
    const s = indexSettingsFor('products');
    expect(s.customRanking).toEqual(['desc(listing_tier)', 'desc(review_count)']);
  });

  // AECI-636: integration evidence ranks the integrations index only. Products
  // and vendors never consume a count of integrations or of products again. The
  // counts stay faceted (a filter is the buyer's intent), just not ranked.
  it('products & vendors: customRanking names neither integration_count nor product_count', () => {
    for (const entity of ['products', 'vendors'] as const) {
      const s = indexSettingsFor(entity);
      expect(s.customRanking[0]).toBe('desc(listing_tier)');
      for (const attr of s.customRanking) {
        expect(attr).not.toMatch(/integration_count|product_count/);
      }
    }
  });

  it('products: facets categories/audiences/phases/trades/vendor_name/has_api_docs/integration_count (§7.2)', () => {
    const s = indexSettingsFor('products');
    expect(s.attributesForFaceting).toEqual([
      'searchable(categories)',
      'searchable(audiences)',
      'searchable(phases)',
      'searchable(trades)',
      'searchable(vendor_name)',
      'has_api_docs',
      'integration_count',
    ]);
    // Ordered — earlier = higher textual priority (SEARCH_RANKING.md §3.1). name
    // leads; the trade name outranks its colloquial aliases, and both outrank the
    // long description.
    expect(s.searchableAttributes).toEqual([
      'name',
      'vendor_name',
      'categories',
      'audiences',
      'phases',
      'trades',
      'trade_aliases',
      'unordered(description)',
    ]);
  });

  it('products: trade_aliases is searchable but NEVER faceted (AECI-545)', () => {
    const s = indexSettingsFor('products');
    expect(s.searchableAttributes).toContain('trade_aliases');
    for (const attr of s.attributesForFaceting) {
      expect(attr).not.toContain('trade_aliases');
    }
  });

  it('products: trades add no custom-ranking signal (no pay-for-placement)', () => {
    const s = indexSettingsFor('products');
    for (const attr of s.customRanking) {
      expect(attr).not.toMatch(/trade/i);
    }
  });

  it('vendors: ranks by listing_tier only; facets HQ/founded/product_count (§7.2, AECI-636 PR-B)', () => {
    const s = indexSettingsFor('vendors');
    expect(s.customRanking).toEqual(['desc(listing_tier)']);
    expect(s.attributesForFaceting).toEqual([
      'searchable(headquarters)',
      'founded_year',
      'product_count',
      'integration_count',
    ]);
    expect(s.searchableAttributes[0]).toBe('company_name');
  });

  it('integrations: ranks by mechanism_rank; facets mechanism_kind/direction/source/target (§7.2/§7.3)', () => {
    const s = indexSettingsFor('integrations');
    expect(s.customRanking).toEqual(['desc(mechanism_rank)']);
    expect(s.attributesForFaceting).toEqual([
      'mechanism_kind',
      'direction',
      'searchable(source_product_name)',
      'searchable(target_product_name)',
    ]);
  });

  it('never references the renamed "discipline" facet (AECI-121 → audiences)', () => {
    for (const entity of INDEX_ENTITIES) {
      const s = indexSettingsFor(entity);
      const all = [...s.searchableAttributes, ...s.attributesForFaceting, ...s.customRanking];
      for (const attr of all) {
        expect(attr).not.toMatch(/disciplin/i);
      }
    }
  });
});

describe('mechanismRank', () => {
  it('orders native > marketplace-app > iPaaS > api > webhook > partner (§7.3)', () => {
    expect(MECHANISM_RANK).toEqual({
      native: 6,
      'marketplace-app': 5,
      iPaaS: 4,
      api: 3,
      webhook: 2,
      partner: 1,
      integrator: 1,
    });
    const ordered = ['native', 'marketplace-app', 'iPaaS', 'api', 'webhook', 'partner'];
    for (let i = 1; i < ordered.length; i++) {
      expect(mechanismRank(ordered[i - 1]!)).toBeGreaterThan(mechanismRank(ordered[i]!));
    }
  });

  it('ties `integrator` with the `partner` it replaces (AECI-698 / AECI-721)', () => {
    // The tie is the point, not a placeholder. AECI-698 re-keys ~117 `partner`
    // rows to `integrator` upstream; that is a CLASSIFICATION change, and a
    // classification-only migration must not silently re-rank the catalog
    // (`STAGE_1_5_SPEC.md` §13.5's own principle). Tying also renumbers nothing,
    // so no full reindex is forced for rank alone. Promoting `integrator` above
    // `partner` is a separate, deliberate decision — assert the tie so making it
    // has to be a deliberate edit here too.
    expect(mechanismRank('integrator')).toBe(mechanismRank('partner'));
  });

  it('pins the connector-evidenced rank to the iPaaS weight, not the unknown fallback', () => {
    // A `connector_evidenced_pairs` row has no `mechanism_kind` at all, so a
    // record built through `mechanismRank(null)` would rank 0 — every
    // connector-delivered edge buried at the bottom of the index as an artifact
    // of which table we chose to store it in. AECI-721 pins it to 4 instead.
    expect(CONNECTOR_EVIDENCED_MECHANISM_RANK).toBe(MECHANISM_RANK.iPaaS);
    expect(CONNECTOR_EVIDENCED_MECHANISM_RANK).toBeGreaterThan(mechanismRank(null));
  });

  it('ranks an absent / unknown kind last (0)', () => {
    expect(mechanismRank(null)).toBe(0);
    expect(mechanismRank(undefined)).toBe(0);
    expect(mechanismRank('not-a-mechanism')).toBe(0);
  });
});

describe('applyIndexSettings', () => {
  type Call = { indexName: string; indexSettings: IndexSettings };

  function makeClient(): { client: AlgoliaSettingsClient; calls: Call[]; waited: string[] } {
    const calls: Call[] = [];
    const waited: string[] = [];
    let taskID = 100;
    const client: AlgoliaSettingsClient = {
      async setSettings(args) {
        calls.push({ indexName: args.indexName, indexSettings: args.indexSettings });
        return { taskID: ++taskID };
      },
      async waitForTask(args) {
        waited.push(args.indexName);
        return undefined;
      },
    };
    return { client, calls, waited };
  }

  const RANKING_TAIL = [
    'typo',
    'geo',
    'words',
    'filters',
    'proximity',
    'attribute',
    'exact',
    'custom',
  ];

  it('applies primary settings + links/configures each primary’s sort replicas', async () => {
    const { client, calls, waited } = makeClient();
    const applied = await applyIndexSettings(client, 'staging');

    // Primary first, then its replicas, per entity (products, vendors, integrations).
    expect(calls.map((c) => c.indexName)).toEqual([
      'staging_products',
      'staging_products_created_desc',
      'staging_products_name_asc',
      'staging_products_updated_desc',
      'staging_products_rating_desc',
      'staging_products_reviews_desc',
      'staging_vendors',
      'staging_vendors_name_asc',
      'staging_integrations',
    ]);

    // Primary carries the §7.2/§7.3 settings + a `replicas` link to its replicas.
    expect(calls[0]!.indexSettings).toEqual({
      ...indexSettingsFor('products'),
      replicas: [
        'staging_products_created_desc',
        'staging_products_name_asc',
        'staging_products_updated_desc',
        'staging_products_rating_desc',
        'staging_products_reviews_desc',
      ],
    });
    // The hidden integrations primary links an empty replica set.
    expect(calls[8]!.indexSettings).toEqual({
      ...indexSettingsFor('integrations'),
      replicas: [],
    });

    // A replica inherits the primary's searchable/facet/customRanking and adds
    // its own `ranking` (sort attribute first).
    const base = indexSettingsFor('products');
    expect(calls[2]!.indexSettings).toEqual({
      searchableAttributes: base.searchableAttributes,
      attributesForFaceting: base.attributesForFaceting,
      customRanking: base.customRanking,
      ranking: ['asc(name_sort)', ...RANKING_TAIL],
    });

    // waitForTask is awaited per index (primary + replicas) when provided.
    expect(waited).toEqual(calls.map((c) => c.indexName));

    expect(applied).toEqual([
      { entity: 'products', indexName: 'staging_products', taskID: 101, role: 'primary' },
      {
        entity: 'products',
        indexName: 'staging_products_created_desc',
        taskID: 102,
        role: 'replica',
      },
      { entity: 'products', indexName: 'staging_products_name_asc', taskID: 103, role: 'replica' },
      {
        entity: 'products',
        indexName: 'staging_products_updated_desc',
        taskID: 104,
        role: 'replica',
      },
      {
        entity: 'products',
        indexName: 'staging_products_rating_desc',
        taskID: 105,
        role: 'replica',
      },
      {
        entity: 'products',
        indexName: 'staging_products_reviews_desc',
        taskID: 106,
        role: 'replica',
      },
      { entity: 'vendors', indexName: 'staging_vendors', taskID: 107, role: 'primary' },
      { entity: 'vendors', indexName: 'staging_vendors_name_asc', taskID: 108, role: 'replica' },
      { entity: 'integrations', indexName: 'staging_integrations', taskID: 109, role: 'primary' },
    ]);
  });

  it('folds development onto the staging index set (primaries + replicas)', async () => {
    const { client, calls } = makeClient();
    await applyIndexSettings(client, 'development');
    expect(calls.map((c) => c.indexName)).toEqual([
      'staging_products',
      'staging_products_created_desc',
      'staging_products_name_asc',
      'staging_products_updated_desc',
      'staging_products_rating_desc',
      'staging_products_reviews_desc',
      'staging_vendors',
      'staging_vendors_name_asc',
      'staging_integrations',
    ]);
  });

  it('works when the client exposes no waitForTask', async () => {
    const calls: Call[] = [];
    const client: AlgoliaSettingsClient = {
      async setSettings(args) {
        calls.push({ indexName: args.indexName, indexSettings: args.indexSettings });
        return { taskID: 1 };
      },
    };
    // 3 primaries + 6 replicas (5 product sorts, vendors A–Z).
    await expect(applyIndexSettings(client, 'production')).resolves.toHaveLength(9);
    expect(calls.map((c) => c.indexName)).toEqual([
      'production_products',
      'production_products_created_desc',
      'production_products_name_asc',
      'production_products_updated_desc',
      'production_products_rating_desc',
      'production_products_reviews_desc',
      'production_vendors',
      'production_vendors_name_asc',
      'production_integrations',
    ]);
  });

  it('applyIndexSettingsTo derives replicas from an explicit (per-locale) index set', async () => {
    const { client, calls } = makeClient();
    const applied = await applyIndexSettingsTo(client, localizedIndexNamesFor('staging', 'es'));
    expect(calls.map((c) => c.indexName)).toEqual([
      'staging_products_es',
      'staging_products_es_created_desc',
      'staging_products_es_name_asc',
      'staging_products_es_updated_desc',
      'staging_products_es_rating_desc',
      'staging_products_es_reviews_desc',
      'staging_vendors_es',
      'staging_vendors_es_name_asc',
      'staging_integrations_es',
    ]);
    expect(applied.map((a) => a.entity)).toEqual([
      'products',
      'products',
      'products',
      'products',
      'products',
      'products',
      'vendors',
      'vendors',
      'integrations',
    ]);
  });
});

// ---------------------------------------------------------------------------
// AECI-1270 — the docs search index
// ---------------------------------------------------------------------------

describe('docsIndexNameFor', () => {
  it('maps every label to the docs index it reads', () => {
    expect(docsIndexNameFor('development')).toBe('staging_docs');
    expect(docsIndexNameFor('staging')).toBe('staging_docs');
    expect(docsIndexNameFor('production')).toBe('production_docs');
  });

  it('points demo at production_docs, unlike its demo_* entity set', () => {
    expect(docsIndexNameFor('demo')).toBe('production_docs');
    expect(indexPrefixForEnv('demo')).toBe('demo');
  });

  it('folds a stale label onto staging_docs', () => {
    expect(docsIndexNameFor('preview' as AlgoliaEnv)).toBe('staging_docs');
  });

  it('never adds docs to INDEX_ENTITIES, which the D1 sync and sweep loop over', () => {
    expect(INDEX_ENTITIES as readonly string[]).not.toContain('docs');
    for (const env of ['staging', 'demo', 'production'] as AlgoliaEnv[]) {
      expect(indexListFor(env).some((name) => name.endsWith('_docs'))).toBe(false);
    }
  });
});

describe('docsIndexWriterFor', () => {
  it('names the writable index for staging and production', () => {
    expect(docsIndexWriterFor('staging')).toBe('staging_docs');
    expect(docsIndexWriterFor('production')).toBe('production_docs');
  });

  it('throws for demo and development, so neither can ever push', () => {
    expect(() => docsIndexWriterFor('demo')).toThrow(/never writes/);
    expect(() => docsIndexWriterFor('development')).toThrow(/never writes/);
  });
});

describe('docs index in the per-tier keys', () => {
  it('adds the docs index each tier reads to its search key', () => {
    expect(searchKeyParams('staging').indexes).toContain('staging_docs');
    expect(searchKeyParams('demo').indexes).toContain('production_docs');
    expect(searchKeyParams('production').indexes).toContain('production_docs');
  });

  it('adds the docs index to the management key on writer tiers only', () => {
    expect(managementKeyParams('staging').indexes).toContain('staging_docs');
    expect(managementKeyParams('production').indexes).toContain('production_docs');
    const demo = managementKeyParams('demo').indexes;
    expect(demo.some((name) => name.endsWith('_docs'))).toBe(false);
  });
});

describe('shared keys', () => {
  const everyIndex = [
    ...(['staging', 'demo', 'production'] as AlgoliaEnv[]).flatMap((env) => [
      ...indexListFor(env),
      ...replicaNamesFor(env),
    ]),
    'staging_docs',
    'production_docs',
  ];

  it('the shared search key is query-only and lists every tier index by name', () => {
    const params = sharedSearchKeyParams();
    expect(params.acl).toEqual(['search']);
    expect(params.indexes).toEqual(everyIndex);
    expect(params.description).toBe('aeci:search:shared');
  });

  it('the shared management key has the per-tier ACL over every tier index', () => {
    const params = sharedManagementKeyParams();
    expect(params.acl).toEqual(managementKeyParams('staging').acl);
    expect(params.indexes).toEqual(everyIndex);
    expect(params.description).toBe('aeci:management:shared');
    expect(params.acl).not.toContain('deleteIndex');
  });

  it('never uses a wildcard', () => {
    for (const params of [sharedSearchKeyParams(), sharedManagementKeyParams()]) {
      expect(params.indexes.some((name) => name.includes('*'))).toBe(false);
    }
  });

  it('has no duplicate index names', () => {
    const { indexes } = sharedSearchKeyParams();
    expect(new Set(indexes).size).toBe(indexes.length);
    expect(DOCS_INDEX_NAMES).toEqual(['staging_docs', 'production_docs']);
  });
});

describe('syncDocsIndex', () => {
  const record = (objectID: string, order: number): DocsSearchRecord => ({
    objectID,
    guide: 'help',
    section: 'Reviewer guide',
    page_title: 'Writing a review',
    heading: objectID,
    url: objectID,
    content: 'text',
    order,
  });

  function makeClient(existing: string[]): { client: DocsIndexClient; log: string[] } {
    const log: string[] = [];
    let taskID = 0;
    const client: DocsIndexClient = {
      async setSettings({ indexName, indexSettings }) {
        log.push(`settings ${indexName} ${JSON.stringify(indexSettings)}`);
        return { taskID: ++taskID };
      },
      async saveObjects({ objects }) {
        log.push(`save ${objects.map((o) => o['objectID']).join(',')}`);
        return [{ taskID: ++taskID }];
      },
      async browseObjects({ aggregator }) {
        log.push('browse');
        aggregator({ hits: existing.map((objectID) => ({ objectID })) });
        return undefined;
      },
      async deleteObjects({ objectIDs }) {
        log.push(`delete ${objectIDs.join(',')}`);
        return [{ taskID: ++taskID }];
      },
      async waitForTask({ taskID: id }) {
        log.push(`wait ${id}`);
        return undefined;
      },
    };
    return { client, log };
  }

  it('saves every record, then deletes only the stale ids', async () => {
    const { client, log } = makeClient(['/docs/a', '/docs/old', '/docs/b#gone']);
    const result = await syncDocsIndex(client, 'staging_docs', [
      record('/docs/a', 1),
      record('/docs/b', 2),
    ]);
    expect(result).toEqual({ index: 'staging_docs', records: 2, saved: 2, deleted: 2 });
    expect(log).toEqual([
      `settings staging_docs ${JSON.stringify(DOCS_INDEX_SETTINGS)}`,
      'wait 1',
      'save /docs/a,/docs/b',
      'wait 2',
      'browse',
      'delete /docs/old,/docs/b#gone',
      'wait 3',
    ]);
  });

  it('saves before it deletes, and skips the delete when nothing is stale', async () => {
    const { client, log } = makeClient(['/docs/a']);
    const result = await syncDocsIndex(client, 'production_docs', [record('/docs/a', 1)]);
    expect(result.deleted).toBe(0);
    expect(log.some((line) => line.startsWith('delete'))).toBe(false);
    expect(log.findIndex((line) => line.startsWith('save'))).toBeLessThan(log.indexOf('browse'));
  });

  it('refuses a build with duplicate objectIDs before any call', async () => {
    const { client, log } = makeClient([]);
    await expect(
      syncDocsIndex(client, 'staging_docs', [record('/docs/a', 1), record('/docs/a', 2)]),
    ).rejects.toThrow(/duplicate objectIDs/);
    expect(log).toEqual([]);
  });

  it('manages the documented settings', () => {
    expect(DOCS_INDEX_SETTINGS).toEqual({
      searchableAttributes: ['heading', 'page_title', 'content'],
      attributesForFaceting: ['filterOnly(guide)'],
      attributesToSnippet: ['content:24'],
      snippetEllipsisText: '…',
      customRanking: ['asc(order)'],
    });
  });
});
