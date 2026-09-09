import { describe, expect, it } from 'vitest';

import {
  AlgoliaIntegrationRecordSchema,
  AlgoliaProductRecordSchema,
  AlgoliaVendorRecordSchema,
  algoliaSortKey,
  flattenTradeAliases,
} from './algolia-records';

const PRODUCT = {
  objectID: '11111111-1111-4111-8111-111111111111',
  name: 'Procore',
  slug: 'procore',
  description: 'Construction management platform.',
  vendor_name: 'Procore Technologies',
  vendor_slug: 'procore-technologies',
  categories: ['Project Management', 'Document Control'],
  audiences: ['Construction Management'],
  phases: ['Construction', 'Closeout & Operations'],
  trades: ['Paving & Asphalt'],
  trade_aliases: ['Blacktop', 'Asphalt Paving'],
  name_sort: 'procore',
  integration_count: 342,
  review_count: 0,
  rating_overall_avg: null,
  has_api_docs: true,
  logo_url: 'https://cdn.brandfetch.io/procore.png',
};

const VENDOR = {
  objectID: '22222222-2222-4222-8222-222222222222',
  company_name: 'Procore Technologies',
  company_name_sort: 'procore technologies',
  slug: 'procore-technologies',
  verified: true,
  description: null,
  headquarters: 'Carpinteria, CA',
  founded_year: 2003,
  product_count: 8,
  integration_count: 412,
  logo_url: null,
};

const INTEGRATION = {
  objectID: '33333333-3333-4333-8333-333333333333',
  source_product_name: 'Procore',
  source_product_slug: 'procore',
  target_product_name: 'Autodesk Construction Cloud',
  target_product_slug: 'autodesk-construction-cloud',
  mechanism_kind: 'native',
  mechanism_name: 'Procore App',
  direction: 'bidirectional',
  description: null,
  mechanism_rank: 6,
};

describe('AlgoliaProductRecordSchema', () => {
  it('accepts a valid denormalized product record (§7.1)', () => {
    expect(AlgoliaProductRecordSchema.parse(PRODUCT)).toEqual(PRODUCT);
  });

  it('allows a null primary vendor and null rating/logo', () => {
    const record = {
      ...PRODUCT,
      vendor_name: null,
      vendor_slug: null,
      rating_overall_avg: null,
      logo_url: null,
    };
    expect(() => AlgoliaProductRecordSchema.parse(record)).not.toThrow();
  });

  it('rejects a non-uuid objectID and a malformed logo_url', () => {
    expect(() => AlgoliaProductRecordSchema.parse({ ...PRODUCT, objectID: 'procore' })).toThrow();
    expect(() => AlgoliaProductRecordSchema.parse({ ...PRODUCT, logo_url: 'not-a-url' })).toThrow();
  });

  it('rejects a negative count', () => {
    expect(() => AlgoliaProductRecordSchema.parse({ ...PRODUCT, integration_count: -1 })).toThrow();
  });

  it('defaults trades / trade_aliases to [] (records indexed before AECI-545)', () => {
    const { trades: _t, trade_aliases: _a, ...stale } = PRODUCT;
    const record = AlgoliaProductRecordSchema.parse(stale);
    expect(record.trades).toEqual([]);
    expect(record.trade_aliases).toEqual([]);
  });

  // AECI-825 — the field the `name_asc` replica ranks on. REQUIRED on purpose:
  // the datatool's raw-SQL builder has no compile-time link to this type, and a
  // default would let it omit the key, sort every product to the top of A–Z, and
  // fail nothing. This parse is the guard, so it has to be able to fail.
  it('REJECTS a record missing name_sort (a forgotten builder field must fail loud)', () => {
    const { name_sort: _n, ...missing } = PRODUCT;
    expect(() => AlgoliaProductRecordSchema.parse(missing)).toThrow();
    expect(() => AlgoliaProductRecordSchema.parse({ ...PRODUCT, name_sort: '' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// AECI-545 — trade_aliases flattening (shared by BOTH record builders)
// ---------------------------------------------------------------------------

describe('flattenTradeAliases', () => {
  it('flattens every linked trade’s aliases in order', () => {
    expect(
      flattenTradeAliases(
        ['Paving & Asphalt', 'Earthwork & Sitework'],
        [
          ['Blacktop', 'Asphalt Paving'],
          ['Dirt Work', 'Earthmoving'],
        ],
      ),
    ).toEqual(['Blacktop', 'Asphalt Paving', 'Dirt Work', 'Earthmoving']);
  });

  it('drops aliases that repeat a canonical trade name (already in `trades`)', () => {
    expect(flattenTradeAliases(['Roofing'], [['Roofing', 'Roofer']])).toEqual(['Roofer']);
  });

  it('dedupes an alias shared by two trades', () => {
    expect(
      flattenTradeAliases(
        ['Glazing & Curtain Wall', 'Framing'],
        [['Curtain Wall'], ['Curtain Wall', 'Carpentry']],
      ),
    ).toEqual(['Curtain Wall', 'Carpentry']);
  });

  it('skips null / undefined / non-array groups (aliases is a nullable JSON column)', () => {
    expect(flattenTradeAliases(['Roofing', 'Concrete'], [null, undefined])).toEqual([]);
    expect(
      flattenTradeAliases(['Roofing'], ['not-an-array' as unknown as string[], ['Roofer']]),
    ).toEqual(['Roofer']);
  });

  it('drops empty strings and non-string entries', () => {
    expect(flattenTradeAliases([], [['', 'Roofer', 7 as unknown as string]])).toEqual(['Roofer']);
  });

  it('returns [] for an untagged product (the sparse-by-design common case)', () => {
    expect(flattenTradeAliases([], [])).toEqual([]);
  });
});

describe('AlgoliaVendorRecordSchema', () => {
  it('accepts a valid denormalized vendor record (§7.1)', () => {
    expect(AlgoliaVendorRecordSchema.parse(VENDOR)).toEqual(VENDOR);
  });

  it('allows null headquarters / founded_year / logo', () => {
    const record = { ...VENDOR, headquarters: null, founded_year: null, logo_url: null };
    expect(() => AlgoliaVendorRecordSchema.parse(record)).not.toThrow();
  });

  it('rejects a missing company_name', () => {
    const { company_name: _omit, ...rest } = VENDOR;
    expect(() => AlgoliaVendorRecordSchema.parse(rest)).toThrow();
  });

  // AECI-825 — same strictness rule as the product record's `name_sort`.
  it('rejects a missing company_name_sort', () => {
    const { company_name_sort: _omit, ...rest } = VENDOR;
    expect(() => AlgoliaVendorRecordSchema.parse(rest)).toThrow();
  });

  it('carries the verified flag through (AECI-529)', () => {
    expect(AlgoliaVendorRecordSchema.parse(VENDOR).verified).toBe(true);
  });

  it('defaults verified to false when omitted (records indexed before AECI-529)', () => {
    const { verified: _omit, ...rest } = VENDOR;
    expect(AlgoliaVendorRecordSchema.parse(rest).verified).toBe(false);
  });
});

describe('AlgoliaIntegrationRecordSchema', () => {
  it('accepts a valid denormalized integration record (§7.1)', () => {
    expect(AlgoliaIntegrationRecordSchema.parse(INTEGRATION)).toEqual(INTEGRATION);
  });

  it('allows null mechanism_kind / direction (with mechanism_rank 0)', () => {
    const record = { ...INTEGRATION, mechanism_kind: null, direction: null, mechanism_rank: 0 };
    expect(() => AlgoliaIntegrationRecordSchema.parse(record)).not.toThrow();
  });

  it('rejects an out-of-enum mechanism_kind / direction', () => {
    expect(() =>
      AlgoliaIntegrationRecordSchema.parse({ ...INTEGRATION, mechanism_kind: 'sftp' }),
    ).toThrow();
    expect(() =>
      AlgoliaIntegrationRecordSchema.parse({ ...INTEGRATION, direction: 'sideways' }),
    ).toThrow();
  });
});

// AECI-825 — the case-folded sort keys the A–Z replicas rank on. Asserted as a
// pure function here; the two record builders' lockstep is asserted in
// `apps/api/src/lib/algolia-transforms.spec.ts` and
// `apps/datatool/src/algolia-reindex.spec.ts`.
describe('algoliaSortKey', () => {
  it('folds case so a byte sort cannot rank capitals ahead of lowercase', () => {
    const names = ['ADP Workforce Now', 'AEC Stack', 'Access Coins Evo', 'eSUB', 'Zoho'];
    const byRawBytes = [...names].sort();
    const byKey = [...names].sort((a, b) => (algoliaSortKey(a) < algoliaSortKey(b) ? -1 : 1));

    // The defect, reproduced: raw bytes put ADP first and exile eSUB past Zoho.
    expect(byRawBytes).toEqual([
      'ADP Workforce Now',
      'AEC Stack',
      'Access Coins Evo',
      'Zoho',
      'eSUB',
    ]);
    expect(byKey).toEqual(['Access Coins Evo', 'ADP Workforce Now', 'AEC Stack', 'eSUB', 'Zoho']);
  });

  it('leaves an already-lowercase name untouched', () => {
    expect(algoliaSortKey('procore')).toBe('procore');
  });
});
