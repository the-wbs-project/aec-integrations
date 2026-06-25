import { describe, expect, it } from 'vitest';

import {
  applyIndexSettings,
  applyIndexSettingsTo,
  DEFAULT_LOCALE,
  INDEX_ENTITIES,
  indexListFor,
  indexNamesFor,
  indexPrefixForEnv,
  indexSettingsFor,
  keyDescription,
  localizedIndexNamesFor,
  managementKeyParams,
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
  it('folds development onto the preview index set', () => {
    expect(indexPrefixForEnv('development')).toBe('preview');
  });

  it('maps preview/staging/production to themselves', () => {
    expect(indexPrefixForEnv('preview')).toBe('preview');
    expect(indexPrefixForEnv('staging')).toBe('staging');
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

  it('uses the preview_* set for both preview and development', () => {
    expect(indexNamesFor('preview')).toEqual({
      products: 'preview_products',
      vendors: 'preview_vendors',
      integrations: 'preview_integrations',
    });
    expect(indexNamesFor('development')).toEqual(indexNamesFor('preview'));
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

  it('folds development onto the preview set before suffixing', () => {
    expect(localizedIndexNamesFor('development', 'es')).toEqual(
      localizedIndexNamesFor('preview', 'es'),
    );
  });
});

describe('keyDescription', () => {
  it('tags by role and index prefix (development folds to preview)', () => {
    expect(keyDescription('search', 'staging')).toBe('aeci:search:staging');
    expect(keyDescription('management', 'production')).toBe('aeci:management:production');
    expect(keyDescription('search', 'development')).toBe('aeci:search:preview');
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
      'staging_products_integration_count_desc',
      'staging_products_name_asc',
      'staging_vendors_integration_count_desc',
      'staging_vendors_name_asc',
    ]);
    expect(params.description).toBe('aeci:search:staging');
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
      'production_products_integration_count_desc',
      'production_products_name_asc',
      'production_vendors_integration_count_desc',
      'production_vendors_name_asc',
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
    for (const env of ['preview', 'staging', 'production'] as AlgoliaEnv[]) {
      expect(managementKeyParams(env).indexes).not.toContain('*');
      expect(searchKeyParams(env).indexes).not.toContain('*');
    }
  });
});

// ---------------------------------------------------------------------------
// AECI-175 — replica sort indexes
// ---------------------------------------------------------------------------

describe('sortReplicasFor', () => {
  it('exposes "Most integrations" + "Name A–Z" for products & vendors', () => {
    for (const entity of ['products', 'vendors'] as const) {
      const sorts = sortReplicasFor(entity);
      expect(sorts.map((s) => s.sort)).toEqual(['integrations', 'name']);
      expect(sorts.map((s) => s.suffix)).toEqual(['integration_count_desc', 'name_asc']);
    }
  });

  it('leads each replica ranking with its sort attribute, then Algolia defaults', () => {
    const tail = ['typo', 'geo', 'words', 'filters', 'proximity', 'attribute', 'exact', 'custom'];
    const products = sortReplicasFor('products');
    expect(products[0]!.ranking).toEqual(['desc(integration_count)', ...tail]);
    expect(products[1]!.ranking).toEqual(['asc(name)', ...tail]);
    // Vendors sort their name field by its real attribute name.
    expect(sortReplicasFor('vendors')[1]!.ranking).toEqual(['asc(company_name)', ...tail]);
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
      'staging_products_integration_count_desc',
      'staging_products_name_asc',
      'staging_vendors_integration_count_desc',
      'staging_vendors_name_asc',
    ]);
    expect(replicaNamesFor('development')).toEqual(replicaNamesFor('preview'));
  });
});

// ---------------------------------------------------------------------------
// AECI-137 — index settings as code
// ---------------------------------------------------------------------------

describe('indexSettingsFor', () => {
  it('products: ranks by integration_count then review_count (§7.3)', () => {
    const s = indexSettingsFor('products');
    expect(s.customRanking).toEqual(['desc(integration_count)', 'desc(review_count)']);
  });

  it('products: facets categories/audiences/phases/vendor_name/has_api_docs/integration_count (§7.2)', () => {
    const s = indexSettingsFor('products');
    expect(s.attributesForFaceting).toEqual([
      'searchable(categories)',
      'searchable(audiences)',
      'searchable(phases)',
      'searchable(vendor_name)',
      'has_api_docs',
      'integration_count',
    ]);
    // name is the most important searchable attribute (first).
    expect(s.searchableAttributes[0]).toBe('name');
    expect(s.searchableAttributes).toContain('audiences');
  });

  it('vendors: ranks by integration_count then product_count; facets HQ/founded/product_count (§7.2/§7.3)', () => {
    const s = indexSettingsFor('vendors');
    expect(s.customRanking).toEqual(['desc(integration_count)', 'desc(product_count)']);
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
    });
    const ordered = ['native', 'marketplace-app', 'iPaaS', 'api', 'webhook', 'partner'];
    for (let i = 1; i < ordered.length; i++) {
      expect(mechanismRank(ordered[i - 1]!)).toBeGreaterThan(mechanismRank(ordered[i]!));
    }
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
      'staging_products_integration_count_desc',
      'staging_products_name_asc',
      'staging_vendors',
      'staging_vendors_integration_count_desc',
      'staging_vendors_name_asc',
      'staging_integrations',
    ]);

    // Primary carries the §7.2/§7.3 settings + a `replicas` link to its replicas.
    expect(calls[0]!.indexSettings).toEqual({
      ...indexSettingsFor('products'),
      replicas: ['staging_products_integration_count_desc', 'staging_products_name_asc'],
    });
    // The hidden integrations primary links an empty replica set.
    expect(calls[6]!.indexSettings).toEqual({
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
      ranking: ['asc(name)', ...RANKING_TAIL],
    });

    // waitForTask is awaited per index (primary + replicas) when provided.
    expect(waited).toEqual(calls.map((c) => c.indexName));

    expect(applied).toEqual([
      { entity: 'products', indexName: 'staging_products', taskID: 101, role: 'primary' },
      {
        entity: 'products',
        indexName: 'staging_products_integration_count_desc',
        taskID: 102,
        role: 'replica',
      },
      { entity: 'products', indexName: 'staging_products_name_asc', taskID: 103, role: 'replica' },
      { entity: 'vendors', indexName: 'staging_vendors', taskID: 104, role: 'primary' },
      {
        entity: 'vendors',
        indexName: 'staging_vendors_integration_count_desc',
        taskID: 105,
        role: 'replica',
      },
      { entity: 'vendors', indexName: 'staging_vendors_name_asc', taskID: 106, role: 'replica' },
      { entity: 'integrations', indexName: 'staging_integrations', taskID: 107, role: 'primary' },
    ]);
  });

  it('folds development onto the preview index set (primaries + replicas)', async () => {
    const { client, calls } = makeClient();
    await applyIndexSettings(client, 'development');
    expect(calls.map((c) => c.indexName)).toEqual([
      'preview_products',
      'preview_products_integration_count_desc',
      'preview_products_name_asc',
      'preview_vendors',
      'preview_vendors_integration_count_desc',
      'preview_vendors_name_asc',
      'preview_integrations',
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
    // 3 primaries + 4 replicas.
    await expect(applyIndexSettings(client, 'production')).resolves.toHaveLength(7);
    expect(calls.map((c) => c.indexName)).toEqual([
      'production_products',
      'production_products_integration_count_desc',
      'production_products_name_asc',
      'production_vendors',
      'production_vendors_integration_count_desc',
      'production_vendors_name_asc',
      'production_integrations',
    ]);
  });

  it('applyIndexSettingsTo derives replicas from an explicit (per-locale) index set', async () => {
    const { client, calls } = makeClient();
    const applied = await applyIndexSettingsTo(client, localizedIndexNamesFor('staging', 'es'));
    expect(calls.map((c) => c.indexName)).toEqual([
      'staging_products_es',
      'staging_products_es_integration_count_desc',
      'staging_products_es_name_asc',
      'staging_vendors_es',
      'staging_vendors_es_integration_count_desc',
      'staging_vendors_es_name_asc',
      'staging_integrations_es',
    ]);
    expect(applied.map((a) => a.entity)).toEqual([
      'products',
      'products',
      'products',
      'vendors',
      'vendors',
      'vendors',
      'integrations',
    ]);
  });
});
