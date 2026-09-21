import { describe, expect, it } from 'vitest';

import { INDEX_ENTITIES, indexSettingsFor } from './algolia';
import {
  CAPABILITIES,
  ENTITLEMENT_STATUSES,
  TIERS,
  TIER_CAPABILITIES,
  capabilitiesFor,
  hasCapability,
  isEntitlementTier,
  tierFor,
  type Capability,
  type EntitlementTier,
  PAID_TIERS,
} from './entitlements';
import {
  PRODUCT_LISTING_TIER_INPUTS,
  VENDOR_LISTING_TIER_INPUTS,
  productListingTier,
  vendorListingTier,
} from './listing-tier';

/**
 * The capability registry + **the ranking firewall** (AECI-610 /
 * `docs/STAGE_2_PAID_TIERS_SPEC.md` §3.2).
 *
 * The first three describe blocks are **invariant tests** (§10): they encode a
 * decision, not behaviour. Do not delete or weaken one without reopening the
 * spec. Their job is to make *no pay-for-placement* — a `CLAUDE.md` /
 * `SEARCH_RANKING.md` §1 promise that has until now been prose — a property
 * that is **proved**. Both vocabularies are pure data in this package, so the
 * claim is checkable rather than merely documented:
 *
 *   The entitlement vocabulary and the Algolia ranking vocabulary are
 *   disjoint sets, and the disjointness is asserted, not documented.
 *
 * The other half of the firewall already exists and is **out of bounds for this
 * issue**: `algolia.spec.ts` freezes each entity's `customRanking` to its exact
 * Stage-1 value, so an attempt to add a ranking signal fails there first.
 */

// ---------------------------------------------------------------------------
// 1. Frozen vocabulary — a speed bump. Weak alone; the base of the escalation.
// ---------------------------------------------------------------------------

describe('the entitlement vocabulary is frozen (§3.1) [invariant]', () => {
  it('declares exactly the eight capability ids, in spec order', () => {
    expect(CAPABILITIES).toEqual([
      'profile.edit',
      'profile.rich_fields',
      'product.edit',
      'product.taxonomy.edit',
      'product.usefulness.edit',
      'attestation.author',
      'analytics.view',
      'integration.version_diff',
    ]);
  });

  it('is a binary ladder at launch (§8.4)', () => {
    expect(TIERS).toEqual(['unclaimed', 'verified']);
  });

  it('declares the four-value status vocabulary (§2.2 — the DB CHECK)', () => {
    expect(ENTITLEMENT_STATUSES).toEqual(['pending', 'active', 'expired', 'revoked']);
  });

  it('grants everything to verified and nothing to unclaimed', () => {
    expect(TIER_CAPABILITIES.unclaimed).toEqual([]);
    expect(TIER_CAPABILITIES.verified).toEqual([...CAPABILITIES]);
  });

  it('has a TIER_CAPABILITIES row for every tier — the "two objects" guarantee', () => {
    // Adding a rung to TIERS without a row here is already a typecheck failure
    // (TIER_CAPABILITIES is a total Record over EntitlementTier). This asserts
    // the runtime half, so the pair can never drift.
    for (const tier of TIERS) {
      expect(TIER_CAPABILITIES[tier], `no capability row for tier "${tier}"`).toBeDefined();
    }
    expect(Object.keys(TIER_CAPABILITIES).sort()).toEqual([...TIERS].sort());
  });
});

// ---------------------------------------------------------------------------
// 2. Ranking-vocabulary regex — same shape as the `disciplin` guard in
//    `algolia.spec.ts`. Catches a capability that *sounds* like placement even
//    if no such Algolia attribute exists today.
// ---------------------------------------------------------------------------

/** Words that name a search-placement concept in any of its usual spellings. */
const RANKING_VOCABULARY_PATTERN =
  /rank|placement|position|boost|sponsor|feature|priorit|weight|sort|relevance|pin|top/i;

describe('no capability names a ranking concept (§3.2) [invariant]', () => {
  it('rejects placement vocabulary in every capability id', () => {
    for (const capability of CAPABILITIES) {
      expect(capability, `capability "${capability}" names a ranking concept`).not.toMatch(
        RANKING_VOCABULARY_PATTERN,
      );
    }
  });

  it('rejects placement vocabulary in every tier id', () => {
    for (const tier of TIERS) {
      expect(tier, `tier "${tier}" names a ranking concept`).not.toMatch(
        RANKING_VOCABULARY_PATTERN,
      );
    }
  });

  it('the pattern itself catches the ids it exists to reject', () => {
    // Guards against a typo in the regex silently disarming the rule above.
    for (const attempt of ['search.boost', 'ranking.priority', 'listing.pinned', 'sponsored.slot'])
      expect(attempt).toMatch(RANKING_VOCABULARY_PATTERN);
  });
});

// ---------------------------------------------------------------------------
// 3. The disjointness proof — the headline.
// ---------------------------------------------------------------------------

/** `unordered(x)` | `searchable(x)` | `desc(x)` | `asc(x)` → `x`; else unchanged. */
function stripAlgoliaWrapper(attribute: string): string {
  return attribute.replace(/^(?:unordered|searchable|desc|asc)\((.+)\)$/, '$1');
}

/**
 * Every attribute name Algolia ranks, facets, or searches on, across all three
 * indexes — read through `indexSettingsFor()` because `INDEX_SETTINGS` itself is
 * module-private. This is the set an entitlement concept may never enter.
 */
const rankingVocabulary = new Set(
  INDEX_ENTITIES.flatMap((entity) => {
    const settings = indexSettingsFor(entity);
    return [
      ...settings.searchableAttributes,
      ...settings.attributesForFaceting,
      ...settings.customRanking,
    ];
  }).map(stripAlgoliaWrapper),
);

describe('the entitlement and ranking vocabularies are disjoint (§3.2) [invariant]', () => {
  it('builds a real ranking vocabulary — the proof is not vacuous', () => {
    // Without this, a broken strip helper (or an empty settings table) would
    // make every assertion below pass trivially.
    expect(rankingVocabulary.size).toBeGreaterThan(10);
    expect(rankingVocabulary.has('description')).toBe(true); // unordered() stripped
    expect(rankingVocabulary.has('categories')).toBe(true); // searchable() stripped
    expect(rankingVocabulary.has('integration_count')).toBe(true); // desc() stripped
    expect(rankingVocabulary.has('mechanism_rank')).toBe(true);
    // No wrapper survived the strip.
    for (const attribute of rankingVocabulary) expect(attribute).not.toMatch(/[()]/);
  });

  it('(a) no capability id is an Algolia ranking attribute', () => {
    for (const capability of CAPABILITIES) {
      expect(
        rankingVocabulary.has(capability),
        `capability "${capability}" is also an Algolia ranking attribute`,
      ).toBe(false);
    }
  });

  it('(b) no entitlement concept appears in INDEX_SETTINGS at all', () => {
    // The Algolia vendor RECORD may carry `verified` (AECI-529) — it is
    // display-only, for the search-card badge. INDEX_SETTINGS may never name
    // it: not searchable, not a facet, not a custom-ranking signal.
    for (const banned of ['verified', 'tier', 'entitlement', 'status', 'paid', 'plan']) {
      expect(
        rankingVocabulary.has(banned),
        `"${banned}" is an entitlement concept and must not appear in INDEX_SETTINGS`,
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. listing_tier reads content only (AECI-636) — the firewall's third half.
// ---------------------------------------------------------------------------

/**
 * Blocks 1–3 prove no entitlement concept is NAMED in `INDEX_SETTINGS`. That stops
 * being enough once a ranking attribute is COMPUTED: `listing_tier` could carry a
 * plan through its inputs while its name stays clean. AECI-636 trap 1 is exactly
 * that ("`listing_tier` keyed on plan status instead of content"). So this block
 * proves the computation's inputs, not just its name.
 *
 * Two checks, because either alone has a hole:
 *   - the DECLARED input lists carry no plan, entitlement or verified concept; and
 *   - the functions READ nothing outside those lists (a recording Proxy), so a
 *     field slipped into the body without being declared fails too.
 */

/** Substrings no listing_tier input may contain. The §3.2 six, plus two neighbours. */
const PLAN_SHAPED = [
  'verified',
  'tier',
  'entitlement',
  'status',
  'paid',
  'plan',
  'priority',
  'seat',
];

/** Run `fn` on a Proxy of `input` and return every property name it read. */
function propertiesRead<T extends object>(fn: (input: T) => unknown, input: T): Set<string> {
  const reads = new Set<string>();
  const proxy = new Proxy(input, {
    get(target, property, receiver) {
      if (typeof property === 'string') reads.add(property);
      return Reflect.get(target, property, receiver);
    },
  });
  fn(proxy);
  return reads;
}

const fullProduct = {
  name: 'Procore',
  description: 'Construction management.',
  categories: ['Project Management'],
  website: 'https://procore.example',
  logo_url: 'https://cdn.example/procore.png',
};
const fullVendor = {
  company_name: 'Procore Technologies',
  description: 'Construction software.',
  headquarters: 'Carpinteria, CA',
  website: 'https://procore.example',
  logo_url: 'https://cdn.example/procore.png',
};
/** Every plan-shaped property a careless caller might hand over. */
const planFields = {
  verified: true,
  tier: 'verified',
  entitlement: 'verified',
  entitlementTier: 'verified',
  status: 'active',
  plan: 'manage',
  paid: true,
  priority_tier: 'high',
  logo_source: 'vendor',
};

describe('listing_tier reads content only (AECI-636) [invariant]', () => {
  it('declares no plan, entitlement or verified concept among its inputs', () => {
    for (const field of [...PRODUCT_LISTING_TIER_INPUTS, ...VENDOR_LISTING_TIER_INPUTS]) {
      for (const banned of PLAN_SHAPED) {
        expect(
          field.toLowerCase(),
          `listing_tier input "${field}" names "${banned}"`,
        ).not.toContain(banned);
      }
      expect(CAPABILITIES as readonly string[], `"${field}" is a capability id`).not.toContain(
        field,
      );
      expect(TIERS as readonly string[], `"${field}" is an entitlement tier`).not.toContain(field);
      expect(ENTITLEMENT_STATUSES as readonly string[]).not.toContain(field);
    }
  });

  it('reads exactly its declared product inputs, across every tier outcome', () => {
    const shapes = [
      fullProduct,
      { ...fullProduct, description: null },
      { ...fullProduct, website: null, logo_url: '  ' },
      { ...fullProduct, categories: [], website: null, logo_url: null },
    ];
    for (const shape of shapes) {
      const reads = propertiesRead(productListingTier, { ...shape, ...planFields });
      expect([...reads].sort()).toEqual([...PRODUCT_LISTING_TIER_INPUTS].sort());
    }
  });

  it('reads exactly its declared vendor inputs, across every tier outcome', () => {
    const shapes = [
      fullVendor,
      { ...fullVendor, description: null },
      { ...fullVendor, headquarters: null },
      { ...fullVendor, headquarters: null, website: null, logo_url: null },
    ];
    for (const shape of shapes) {
      const reads = propertiesRead(vendorListingTier, { ...shape, ...planFields });
      expect([...reads].sort()).toEqual([...VENDOR_LISTING_TIER_INPUTS].sort());
    }
  });

  it('gives the same tier whatever plan-shaped fields ride along', () => {
    const flipped = { verified: false, tier: 'unclaimed', status: 'revoked', paid: false };
    expect(productListingTier({ ...fullProduct, ...planFields })).toBe(
      productListingTier({ ...fullProduct, ...flipped }),
    );
    expect(vendorListingTier({ ...fullVendor, ...planFields })).toBe(
      vendorListingTier({ ...fullVendor, ...flipped }),
    );
  });

  it('takes one argument, so a plan cannot arrive as a second parameter', () => {
    expect(productListingTier.length).toBe(1);
    expect(vendorListingTier.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed resolution (§3.1). Ordinary behaviour coverage.
// ---------------------------------------------------------------------------

describe('tierFor — fail-closed', () => {
  it('resolves an active row to its tier', () => {
    expect(tierFor({ tier: 'verified', status: 'active' })).toBe('verified');
    expect(tierFor({ tier: 'unclaimed', status: 'active' })).toBe('unclaimed');
  });

  it('resolves a missing row to unclaimed', () => {
    expect(tierFor(null)).toBe('unclaimed');
    expect(tierFor(undefined)).toBe('unclaimed');
  });

  it('resolves every non-active status to unclaimed', () => {
    // Derived from the vocabulary, so a status added later is covered here the
    // moment it is declared. Only `active` grants (§2.2).
    for (const status of ENTITLEMENT_STATUSES.filter((s) => s !== 'active')) {
      expect(tierFor({ tier: 'verified', status }), `status "${status}" granted a tier`).toBe(
        'unclaimed',
      );
    }
    expect(tierFor({ tier: 'verified', status: 'nonsense' })).toBe('unclaimed');
  });

  it('resolves an unknown tier to unclaimed, not to verified', () => {
    // vendor_entitlements.tier carries no DB CHECK (§2.2), so this is a real
    // runtime input, not a hypothetical.
    expect(tierFor({ tier: 'enterprise', status: 'active' })).toBe('unclaimed');
    expect(tierFor({ tier: '', status: 'active' })).toBe('unclaimed');
    expect(tierFor({ tier: 'VERIFIED', status: 'active' })).toBe('unclaimed');
  });
});

describe('isEntitlementTier', () => {
  it('accepts the known rungs and rejects everything else', () => {
    expect(isEntitlementTier('verified')).toBe(true);
    expect(isEntitlementTier('unclaimed')).toBe(true);
    expect(isEntitlementTier('enterprise')).toBe(false);
  });
});

describe('capabilitiesFor / hasCapability', () => {
  it('gives verified every capability', () => {
    expect(capabilitiesFor('verified')).toEqual([...CAPABILITIES]);
    for (const capability of CAPABILITIES) expect(hasCapability('verified', capability)).toBe(true);
  });

  it('gives unclaimed none', () => {
    expect(capabilitiesFor('unclaimed')).toEqual([]);
    for (const capability of CAPABILITIES) {
      expect(hasCapability('unclaimed', capability)).toBe(false);
    }
  });

  it('gives an unrecognized tier zero capabilities rather than undefined', () => {
    const unknown = 'enterprise' as EntitlementTier;
    expect(capabilitiesFor(unknown)).toEqual([]);
    expect(hasCapability(unknown, 'profile.edit')).toBe(false);
  });

  it('rejects a capability this build does not declare', () => {
    expect(hasCapability('verified', 'search.boost' as Capability)).toBe(false);
  });
});

describe('PAID_TIERS — what an admin may actually grant [invariant]', () => {
  // `TIERS` and "what you can sell someone" are different lists, and conflating them
  // is a live incoherence, not a tidiness point: an `active` vendor_entitlements row
  // at a zero-capability tier flips the `vendors.verified` mirror and lights the
  // public account label (§2.1) while `tierFor` resolves it to no capabilities at all — a
  // vendor billed for a badge that unlocks nothing. `SetVendorEntitlementSchema.tier`
  // therefore derives from PAID_TIERS, while the session block and grant summary keep
  // reading TIERS because they must be able to REPORT `unclaimed`.
  //
  // PAID_TIERS is an explicit literal (z.enum needs a const tuple at the type level),
  // so this test is what stops it going stale when a rung is added.

  it('is exactly the tiers that hold at least one capability', () => {
    const derived = TIERS.filter((tier) => capabilitiesFor(tier).length > 0);
    expect([...PAID_TIERS]).toEqual(derived);
  });

  it('is a strict subset of TIERS, and excludes unclaimed', () => {
    for (const tier of PAID_TIERS) expect(TIERS).toContain(tier);
    expect([...PAID_TIERS]).not.toContain('unclaimed');
  });

  it('never offers a tier that would light the badge for nothing', () => {
    for (const tier of PAID_TIERS) expect(capabilitiesFor(tier).length).toBeGreaterThan(0);
  });
});
