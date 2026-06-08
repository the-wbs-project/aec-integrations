import { describe, expect, it } from 'vitest';

import {
  INDEX_ENTITIES,
  indexListFor,
  indexNamesFor,
  indexPrefixForEnv,
  keyDescription,
  managementKeyParams,
  searchKeyParams,
  type AlgoliaEnv,
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

describe('keyDescription', () => {
  it('tags by role and index prefix (development folds to preview)', () => {
    expect(keyDescription('search', 'staging')).toBe('aeci:search:staging');
    expect(keyDescription('management', 'production')).toBe('aeci:management:production');
    expect(keyDescription('search', 'development')).toBe('aeci:search:preview');
  });
});

describe('searchKeyParams', () => {
  it('is query-only and scoped to the env indexes', () => {
    const params = searchKeyParams('staging');
    expect(params.acl).toEqual(['search']);
    expect(params.indexes).toEqual(['staging_products', 'staging_vendors', 'staging_integrations']);
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
  it('grants search + index-mutation ACLs scoped to the env indexes', () => {
    const params = managementKeyParams('production');
    expect(params.acl).toEqual([
      'search',
      'addObject',
      'deleteObject',
      'editSettings',
      'listIndexes',
    ]);
    expect(params.indexes).toEqual([
      'production_products',
      'production_vendors',
      'production_integrations',
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
