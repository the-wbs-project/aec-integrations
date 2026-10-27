import { describe, expect, it } from 'vitest';

import {
  OWNERSHIP_RECORD_SCHEMA_V2,
  OWNERSHIP_RECORD_SCHEMA_VERSION,
  OWNERSHIP_VERSIONS_MAX_IDS,
  OwnershipRecordSchema,
  OwnershipRecordV2Schema,
  OwnershipSyncMessageSchema,
  OwnershipVersionsResponseSchema,
  canonicalJson,
  computeOwnershipRecordHash,
  computeRecordHash,
  ownershipRecordUrl,
  ownershipVersionsUrl,
  type OwnershipIntegrationContent,
  type OwnershipProductContent,
  type OwnershipRecord,
  type OwnershipRecordV2,
  type OwnershipVendorContent,
} from './review-app-ownership';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const owned: OwnershipRecord = {
  schemaVersion: OWNERSHIP_RECORD_SCHEMA_VERSION,
  vendorId: u(1),
  owner: 'vendor',
  ownedAt: '2026-10-19T00:00:00.000Z',
  version: 1_792_000_000_000,
  asOf: '2026-10-20T00:00:00.000Z',
  reason: 'claim_approved',
  products: [{ id: u(2), owner: 'vendor' }],
  integrations: [
    { id: u(3), table: 'integrations', owner: 'vendor' },
    { id: u(4), table: 'connector_evidenced_pairs', owner: 'vendor' },
  ],
  proposals: [
    {
      id: u(5),
      ref: 'p:recAbc123',
      state: 'accepted',
      decidedAt: '2026-10-20T00:00:00.000Z',
      productId: u(6),
    },
  ],
};

describe('OwnershipRecordSchema (REVIEW_APP_PROMOTE_API.md §4d)', () => {
  it('accepts a vendor-owned record', () => {
    expect(OwnershipRecordSchema.parse(owned)).toEqual(owned);
  });

  it('accepts a returned record, with a co-owned product still vendor-owned', () => {
    const returned = {
      ...owned,
      owner: 'aeci',
      ownedAt: null,
      reason: 'records_returned',
      products: [
        { id: u(2), owner: 'aeci' },
        { id: u(7), owner: 'vendor' },
      ],
    };
    expect(OwnershipRecordSchema.safeParse(returned).success).toBe(true);
  });

  it('ties ownedAt to owner in both directions', () => {
    expect(OwnershipRecordSchema.safeParse({ ...owned, ownedAt: null }).success).toBe(false);
    expect(OwnershipRecordSchema.safeParse({ ...owned, owner: 'aeci', products: [] }).success).toBe(
      false,
    );
  });

  it('refuses an AECi-owned product on a vendor-owned vendor (ruling Q3)', () => {
    const bad = { ...owned, products: [{ id: u(2), owner: 'aeci' }] };
    expect(OwnershipRecordSchema.safeParse(bad).success).toBe(false);
  });

  it('refuses an unknown table, an unknown reason and a non-UUID id', () => {
    expect(
      OwnershipRecordSchema.safeParse({
        ...owned,
        integrations: [{ id: u(3), table: 'claims', owner: 'vendor' }],
      }).success,
    ).toBe(false);
    expect(OwnershipRecordSchema.safeParse({ ...owned, reason: 'other' }).success).toBe(false);
    expect(OwnershipRecordSchema.safeParse({ ...owned, vendorId: 'rec123' }).success).toBe(false);
  });

  it('refuses a future schema version', () => {
    expect(OwnershipRecordSchema.safeParse({ ...owned, schemaVersion: 2 }).success).toBe(false);
  });
});

describe('OwnershipSyncMessageSchema', () => {
  it('carries the vendor, the reason and the enqueue time only', () => {
    const msg = { vendorId: u(1), reason: 'backfill', enqueuedAt: '2026-10-20T00:00:00.000Z' };
    expect(OwnershipSyncMessageSchema.parse(msg)).toEqual(msg);
    expect(OwnershipSyncMessageSchema.safeParse({ ...msg, reason: 'x' }).success).toBe(false);
  });

  it('accepts the AECI-1413 content-edit reasons on the message and the record', () => {
    for (const reason of ['vendor_edit', 'admin_edit'] as const) {
      const msg = { vendorId: u(1), reason, enqueuedAt: '2026-10-20T00:00:00.000Z' };
      expect(OwnershipSyncMessageSchema.parse(msg)).toEqual(msg);
      expect(OwnershipRecordSchema.safeParse({ ...owned, reason }).success).toBe(true);
    }
  });
});

describe('ownershipRecordUrl', () => {
  it('joins the base and the vendor path, with or without a trailing slash', () => {
    expect(ownershipRecordUrl('https://review.example/api/ownership', u(1))).toBe(
      `https://review.example/api/ownership/vendors/${u(1)}`,
    );
    expect(ownershipRecordUrl('https://review.example/api/ownership/', u(1))).toBe(
      `https://review.example/api/ownership/vendors/${u(1)}`,
    );
  });
});

// ─── v2 (AECI-1413) ──────────────────────────────────────────────────────────────

const vendorContent: OwnershipVendorContent = {
  companyName: 'Acme',
  description: 'Builds things',
  website: 'https://acme.example',
  headquarters: null,
  foundedYear: 2001,
  publicPrivate: 'private',
  parentCompany: null,
  linkedinUrl: null,
  xUrl: null,
  facebookUrl: null,
  instagramUrl: null,
  youtubeUrl: null,
  crunchbaseUrl: null,
  wikiUrl: null,
  githubOrg: null,
  phoneNumber: null,
  contactEmail: 'hello@acme.example',
  logoUrl: null,
  lastReviewedAt: '2026-10-21T00:00:00.000Z',
  maintainedBy: 'vendor',
};

const productContent: OwnershipProductContent = {
  name: 'Acme Plan',
  slug: 'acme-plan',
  productRole: 'application',
  description: null,
  website: null,
  toolIntegrationsUrl: null,
  apiDocsUrl: null,
  logoUrl: null,
  usefulness: { audiences: [{ slug: 'gc', name: 'GC', points: ['One'] }], phases: [] },
  categories: ['scheduling', 'estimating'],
  audiences: [],
  phases: [],
  trades: [],
  lastReviewedAt: null,
  maintainedBy: 'vendor',
  versions: [
    { label: '2024', releasedAt: '2024-01-01', sunsetAt: null },
    { label: '2025', releasedAt: '2025-01-01', sunsetAt: null },
  ],
};

const integrationContent: OwnershipIntegrationContent = {
  name: 'Acme to Beta',
  sourceProduct: { supabaseId: u(2) },
  targetProduct: { supabaseId: u(8) },
  builtByVendor: { supabaseId: u(1) },
  poweredByProduct: null,
  mechanismKind: 'native',
  mechanismName: null,
  direction: 'a_to_b',
  description: null,
  listingUrl: null,
  docsUrl: null,
  website: null,
  mechanismUrl: null,
  pricingModel: null,
  maturity: null,
  pricingUrl: null,
  lastReviewedAt: null,
  maintainedBy: 'vendor',
  origin: 'vendor',
  claimedAt: '2026-10-19 10:00:00',
  retiredAt: null,
  vendorLinks: [{ productId: u(2), kind: 'docs', url: 'https://acme.example/docs' }],
};

const pairContent: OwnershipIntegrationContent = {
  ...integrationContent,
  poweredByProduct: { supabaseId: u(9) },
  builtByVendor: null,
  origin: 'aeci',
  vendorLinks: [],
};
delete pairContent.mechanismKind;

const ownedV2: OwnershipRecordV2 = {
  schemaVersion: OWNERSHIP_RECORD_SCHEMA_V2,
  vendorId: u(1),
  owner: 'vendor',
  ownedAt: '2026-10-19T00:00:00.000Z',
  version: 1_792_000_000_000,
  asOf: '2026-10-20T00:00:00.000Z',
  reason: 'claim_approved',
  vendor: vendorContent,
  products: [{ id: u(2), owner: 'vendor', content: productContent }],
  integrations: [
    {
      id: u(3),
      table: 'integrations',
      owner: 'vendor',
      content: integrationContent,
      claims: [
        {
          dataObject: 'schedule',
          direction: 'a_to_b',
          source: 'vendor_a',
          asserted: true,
          note: null,
          introducedVersion: '2024',
          deprecatedVersion: null,
          retractedAt: null,
        },
        {
          dataObject: 'schedule',
          direction: 'a_to_b',
          source: 'aeci',
          asserted: true,
          note: null,
          introducedVersion: null,
          deprecatedVersion: null,
          retractedAt: '2026-10-01 00:00:00',
        },
      ],
    },
    {
      id: u(4),
      table: 'connector_evidenced_pairs',
      owner: 'vendor',
      content: pairContent,
      claims: [],
    },
  ],
  proposals: [],
  recordHash: 'a'.repeat(64),
};

describe('OwnershipRecordSchema v2 (REVIEW_APP_PROMOTE_API.md §4d, ADR 0044)', () => {
  it('accepts a vendor-owned v2 record through the union and the v2 schema', () => {
    expect(OwnershipRecordSchema.parse(ownedV2)).toEqual(ownedV2);
    expect(OwnershipRecordV2Schema.parse(ownedV2)).toEqual(ownedV2);
  });

  it('still accepts v1 through the union', () => {
    expect(OwnershipRecordSchema.parse(owned).schemaVersion).toBe(1);
  });

  it('refuses an unknown schema version', () => {
    expect(OwnershipRecordSchema.safeParse({ ...ownedV2, schemaVersion: 3 }).success).toBe(false);
  });

  it('ties vendor content to the vendor owner', () => {
    expect(OwnershipRecordSchema.safeParse({ ...ownedV2, vendor: null }).success).toBe(false);
    const returned = {
      ...ownedV2,
      owner: 'aeci',
      ownedAt: null,
      reason: 'records_returned',
      products: [{ id: u(2), owner: 'aeci' }],
      integrations: [{ id: u(3), table: 'integrations', owner: 'aeci' }],
    };
    expect(OwnershipRecordSchema.safeParse({ ...returned, vendor: null }).success).toBe(true);
    expect(OwnershipRecordSchema.safeParse({ ...returned, vendor: vendorContent }).success).toBe(
      false,
    );
  });

  it('ties product content to the product owner', () => {
    const noContent = { ...ownedV2, products: [{ id: u(2), owner: 'vendor' }] };
    expect(OwnershipRecordSchema.safeParse(noContent).success).toBe(false);
  });

  it('ties integration content and claims to the integration owner', () => {
    const [first] = ownedV2.integrations;
    const noClaims = { ...ownedV2, integrations: [{ ...first, claims: undefined }] };
    expect(OwnershipRecordSchema.safeParse(noClaims).success).toBe(false);
    const aeciWithContent = {
      ...ownedV2,
      owner: 'aeci',
      ownedAt: null,
      vendor: null,
      products: [],
      integrations: [{ ...first, owner: 'aeci' }],
    };
    expect(OwnershipRecordSchema.safeParse(aeciWithContent).success).toBe(false);
  });

  it('keeps mechanismKind off a pair row and on an integrations row', () => {
    const [direct, pair] = ownedV2.integrations;
    const pairWithKind = {
      ...ownedV2,
      integrations: [direct, { ...pair, content: { ...pairContent, mechanismKind: 'iPaaS' } }],
    };
    expect(OwnershipRecordSchema.safeParse(pairWithKind).success).toBe(false);
    const directWithout = {
      ...ownedV2,
      integrations: [{ ...direct, content: { ...integrationContent, mechanismKind: undefined } }],
    };
    expect(OwnershipRecordSchema.safeParse(directWithout).success).toBe(false);
    const pairNoConnector = {
      ...ownedV2,
      integrations: [direct, { ...pair, content: { ...pairContent, poweredByProduct: null } }],
    };
    expect(OwnershipRecordSchema.safeParse(pairNoConnector).success).toBe(false);
  });

  it('refuses two claim slots with the same natural key', () => {
    const [direct, pair] = ownedV2.integrations;
    const claim = direct!.claims![0]!;
    const dup = { ...ownedV2, integrations: [{ ...direct, claims: [claim, claim] }, pair] };
    expect(OwnershipRecordSchema.safeParse(dup).success).toBe(false);
  });

  it('refuses a ref-form endpoint, a legacy direction and a malformed hash', () => {
    const [direct, pair] = ownedV2.integrations;
    const withContent = (
      patch: Partial<OwnershipIntegrationContent> | Record<string, unknown>,
    ) => ({
      ...ownedV2,
      integrations: [{ ...direct, content: { ...integrationContent, ...patch } }, pair],
    });
    expect(
      OwnershipRecordSchema.safeParse(withContent({ sourceProduct: { ref: 'p1' } })).success,
    ).toBe(false);
    expect(OwnershipRecordSchema.safeParse(withContent({ direction: 'one-way' })).success).toBe(
      false,
    );
    expect(OwnershipRecordSchema.safeParse({ ...ownedV2, recordHash: 'ABC' }).success).toBe(false);
  });

  it('refuses content with a key missing, since every key is whole state', () => {
    const { website: _dropped, ...partial } = vendorContent;
    expect(OwnershipRecordSchema.safeParse({ ...ownedV2, vendor: partial }).success).toBe(false);
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every depth, keeps array order and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null, e: undefined } })).toBe(
      '{"a":{"c":null,"d":[3,1]},"b":1}',
    );
  });

  it('orders keys by code unit, not by locale', () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3 })).toBe('{"B":2,"a":3,"b":1}');
  });

  it('refuses what JSON cannot carry', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(TypeError);
    expect(() => canonicalJson([() => 1])).toThrow(TypeError);
  });
});

describe('computeRecordHash', () => {
  it('is the SHA-256 of the canonical JSON, in lowercase hex', async () => {
    // sha256('{"a":1}')
    expect(await computeRecordHash({ a: 1 })).toBe(
      '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
    );
  });

  it('does not move with key order', async () => {
    expect(await computeRecordHash({ a: 1, b: [1, 2] })).toBe(
      await computeRecordHash({ b: [1, 2], a: 1 }),
    );
  });
});

describe('computeOwnershipRecordHash', () => {
  it('ignores version, asOf, reason and any recordHash already set', async () => {
    const base = await computeOwnershipRecordHash(ownedV2);
    const resent = await computeOwnershipRecordHash({
      ...ownedV2,
      version: ownedV2.version + 1,
      asOf: '2026-10-22T00:00:00.000Z',
      reason: 'backfill',
      recordHash: 'b'.repeat(64),
    });
    expect(resent).toBe(base);
  });

  it('does not move with the order of set-like arrays', async () => {
    const [direct, pair] = ownedV2.integrations;
    const shuffled: OwnershipRecordV2 = {
      ...ownedV2,
      products: [
        {
          ...ownedV2.products[0]!,
          content: { ...productContent, categories: ['estimating', 'scheduling'] },
        },
      ],
      integrations: [pair!, { ...direct!, claims: [...direct!.claims!].reverse() }],
    };
    expect(await computeOwnershipRecordHash(shuffled)).toBe(
      await computeOwnershipRecordHash(ownedV2),
    );
  });

  it('moves when content or ownership moves, and with the order of versions', async () => {
    const base = await computeOwnershipRecordHash(ownedV2);
    const edited = { ...ownedV2, vendor: { ...vendorContent, description: 'Changed' } };
    expect(await computeOwnershipRecordHash(edited)).not.toBe(base);
    const reordered = {
      ...ownedV2,
      products: [
        {
          ...ownedV2.products[0]!,
          content: { ...productContent, versions: [...productContent.versions].reverse() },
        },
      ],
    };
    expect(await computeOwnershipRecordHash(reordered)).not.toBe(base);
  });
});

describe('versions read', () => {
  it('accepts up to the cap, with a null hash for a v1-only record', () => {
    const entry = { vendorId: u(1), version: 1, recordHash: null };
    expect(OwnershipVersionsResponseSchema.parse({ vendors: [entry] })).toEqual({
      vendors: [entry],
    });
    const over = Array.from({ length: OWNERSHIP_VERSIONS_MAX_IDS + 1 }, () => entry);
    expect(OwnershipVersionsResponseSchema.safeParse({ vendors: over }).success).toBe(false);
  });

  it('takes an optional non-negative integer skipped count (AECI-1488)', () => {
    const entry = { vendorId: u(1), version: 1, recordHash: 'a'.repeat(64) };
    const parse = (extra: object) =>
      OwnershipVersionsResponseSchema.safeParse({ vendors: [{ ...entry, ...extra }] });
    // Absent: a receiver that predates the field still parses.
    expect(parse({}).success).toBe(true);
    expect(parse({ skipped: 0 }).success).toBe(true);
    expect(parse({ skipped: 3 }).success).toBe(true);
    expect(parse({ skipped: -1 }).success).toBe(false);
    expect(parse({ skipped: 1.5 }).success).toBe(false);
    expect(parse({ skipped: '2' }).success).toBe(false);
  });

  it('builds the comma-separated URL and refuses an empty or over-cap list', () => {
    expect(ownershipVersionsUrl('https://review.example/api/ownership/', [u(1), u(2)])).toBe(
      `https://review.example/api/ownership/vendors?ids=${u(1)},${u(2)}`,
    );
    expect(() => ownershipVersionsUrl('https://r.example', [])).toThrow(RangeError);
    const over = Array.from({ length: OWNERSHIP_VERSIONS_MAX_IDS + 1 }, (_, i) => u(i + 1));
    expect(() => ownershipVersionsUrl('https://r.example', over)).toThrow(RangeError);
  });
});
