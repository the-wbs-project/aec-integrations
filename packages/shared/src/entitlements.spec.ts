import { describe, expect, it } from 'vitest';

import { INDEX_ENTITIES, indexSettingsFor } from './algolia';
import {
  AlgoliaIntegrationRecordSchema,
  AlgoliaProductRecordSchema,
  AlgoliaVendorRecordSchema,
} from './algolia-records';
import { IntegrationSortSchema } from './api/integrations';
import { ProductSortSchema } from './api/products';
import { VendorSortSchema } from './api/vendors';
import {
  CAPABILITIES,
  ENTITLEMENT_STATUSES,
  PRODUCT_FIELD_CAPABILITIES,
  TIERS,
  TIER_CAPABILITIES,
  VENDOR_FIELD_CAPABILITIES,
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
 * The other half of the firewall is `algolia.spec.ts`, which freezes each
 * entity's `customRanking` to its exact value, so an attempt to add a ranking
 * signal fails there first. That freeze was out of bounds for the AECI-515 epic.
 * AECI-636 reopened it as a decision (PR-B, 2026-09-22): products and vendors
 * now rank on `listing_tier`, so block 3b below checks `customRanking` by
 * substring and block 4 proves `listing_tier` reads content only.
 */

// ---------------------------------------------------------------------------
// 1. Frozen vocabulary — a speed bump. Weak alone; the base of the escalation.
// ---------------------------------------------------------------------------

describe('the entitlement vocabulary is frozen (§3.1) [invariant]', () => {
  it('declares exactly the eleven capability ids, in spec order', () => {
    expect(CAPABILITIES).toEqual([
      'profile.edit',
      'profile.rich_fields',
      'product.edit',
      'product.listing.edit',
      'product.categories.edit',
      'product.taxonomy.edit',
      'product.usefulness.edit',
      'attestation.author',
      'analytics.view',
      'integration.version_diff',
      'review.reply',
    ]);
  });

  it('keeps review.reply off the Free plan (STAGE_2_VENDOR_PORTAL_SPEC.md §11c.9)', () => {
    // Opening replies to Free is a deliberate one-line move into
    // TIER_CAPABILITIES.unclaimed, recorded as an amendment to §11c.9. This
    // assertion makes that move a visible test change too.
    expect(TIER_CAPABILITIES.unclaimed).not.toContain('review.reply');
    expect(TIER_CAPABILITIES.verified).toContain('review.reply');
  });

  it('is a binary ladder at launch (§8.4)', () => {
    expect(TIERS).toEqual(['unclaimed', 'verified']);
  });

  it('declares the four-value status vocabulary (§2.2 — the DB CHECK)', () => {
    expect(ENTITLEMENT_STATUSES).toEqual(['pending', 'active', 'expired', 'revoked']);
  });

  it('grants everything to verified and only the Free edits to unclaimed (§13.3)', () => {
    expect(TIER_CAPABILITIES.unclaimed).toEqual([
      'profile.edit',
      'product.listing.edit',
      'product.categories.edit',
    ]);
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
    expect(rankingVocabulary.has('listing_tier')).toBe(true); // AECI-636 PR-B
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
// 3b. customRanking names no plan, entitlement or verified attribute (AECI-636).
// ---------------------------------------------------------------------------

/**
 * Block 3 checks the whole ranking vocabulary by EXACT name, so it catches
 * `verified` but not `is_verified`, `plan_rank` or `entitlement_tier`. That was
 * enough while `customRanking` held only counts. AECI-636 PR-B made the first
 * product and vendor `customRanking` signal a COMPUTED tier, so the order-deciding
 * list gets its own, stricter check: a substring match over every entity's
 * `customRanking`, against the plan-shaped words, every capability id, every
 * entitlement tier and every entitlement status.
 *
 * `listing_tier` is the one name allowed to contain "tier". It is admitted by
 * name, not by pattern, because block 4 below proves its inputs are content-only.
 * A second tier-shaped ranking attribute must earn its own entry here, with its
 * own content-only proof.
 */
const CONTENT_PROVEN_RANKING_ATTRIBUTES: ReadonlySet<string> = new Set(['listing_tier']);

const customRankingAttributes = INDEX_ENTITIES.flatMap((entity) =>
  indexSettingsFor(entity).customRanking.map((criterion) => ({
    entity,
    attribute: stripAlgoliaWrapper(criterion),
  })),
);

describe('customRanking names no plan, entitlement or verified attribute (AECI-636) [invariant]', () => {
  it('checks a real customRanking list — the proof is not vacuous', () => {
    const names = customRankingAttributes.map((entry) => entry.attribute);
    expect(names).toContain('listing_tier');
    expect(names).toContain('mechanism_rank');
    for (const name of names) expect(name).not.toMatch(/[()]/);
  });

  it('no customRanking attribute contains a plan-shaped word', () => {
    const planShaped = [
      'verified',
      'tier',
      'entitlement',
      'status',
      'paid',
      'plan',
      'priority',
      'seat',
    ];
    for (const { entity, attribute } of customRankingAttributes) {
      if (CONTENT_PROVEN_RANKING_ATTRIBUTES.has(attribute)) continue;
      for (const banned of planShaped) {
        expect(
          attribute.toLowerCase(),
          `${entity} customRanking "${attribute}" names "${banned}"`,
        ).not.toContain(banned);
      }
    }
  });

  it('no customRanking attribute is or contains a capability, tier or status id', () => {
    const entitlementIds: readonly string[] = [...CAPABILITIES, ...TIERS, ...ENTITLEMENT_STATUSES];
    for (const { entity, attribute } of customRankingAttributes) {
      for (const id of entitlementIds) {
        // Capability ids are dotted (`analytics.view`); compare both spellings.
        const spellings = [id, id.replace(/\./g, '_')];
        for (const spelling of spellings) {
          expect(
            attribute.toLowerCase().includes(spelling.toLowerCase()),
            `${entity} customRanking "${attribute}" contains entitlement id "${id}"`,
          ).toBe(false);
        }
      }
    }
  });

  it('admits listing_tier only because block 4 proves its inputs', () => {
    // If listing_tier ever leaves customRanking, this allowlist entry is dead and
    // should go with it, so a later attribute cannot inherit the exemption.
    for (const admitted of CONTENT_PROVEN_RANKING_ATTRIBUTES) {
      expect(customRankingAttributes.map((entry) => entry.attribute)).toContain(admitted);
    }
    expect(PRODUCT_LISTING_TIER_INPUTS.length).toBeGreaterThan(0);
    expect(VENDOR_LISTING_TIER_INPUTS.length).toBeGreaterThan(0);
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
// 5. No listing_tier input may need a plan to edit (AECI-1214, §13.4).
// ---------------------------------------------------------------------------

/**
 * Block 4 proves `listing_tier` reads content only. That leaves one leak: if the
 * content fields it reads are editable only on a paid plan, payment still raises
 * a rank, one step removed. This block closes it. Every `listing_tier` input maps
 * to the vendor-editable wire field that writes it, and that field's capability
 * must be one the Free tier (`unclaimed`) holds.
 *
 * The capability comes from `PRODUCT_FIELD_CAPABILITIES` / `VENDOR_FIELD_CAPABILITIES`,
 * which the API builds its column maps and facet gate from. So this checks the
 * gate the route enforces, not a copy of it.
 *
 * The two maps below are typed as total records over the input lists, so a new
 * `listing_tier` input fails the typecheck until someone says how it is written.
 * `null` means "not vendor-editable at all", which is also plan-free.
 */
const PRODUCT_INPUT_FIELD: Record<
  (typeof PRODUCT_LISTING_TIER_INPUTS)[number],
  keyof typeof PRODUCT_FIELD_CAPABILITIES | null
> = {
  name: null, // a rename stays a correction request
  description: 'description',
  categories: 'category_slugs',
  website: 'website',
  logo_url: 'logo_url',
};
const VENDOR_INPUT_FIELD: Record<
  (typeof VENDOR_LISTING_TIER_INPUTS)[number],
  keyof typeof VENDOR_FIELD_CAPABILITIES | null
> = {
  company_name: null, // a rename stays a correction request
  description: 'description',
  headquarters: 'headquarters',
  website: 'website',
  logo_url: 'logo_url',
};

describe('no listing_tier input needs a plan to edit (§13.4) [invariant]', () => {
  it.each([
    ['product', PRODUCT_LISTING_TIER_INPUTS, PRODUCT_INPUT_FIELD, PRODUCT_FIELD_CAPABILITIES],
    ['vendor', VENDOR_LISTING_TIER_INPUTS, VENDOR_INPUT_FIELD, VENDOR_FIELD_CAPABILITIES],
  ] as const)(
    'every %s listing_tier input is plan-free',
    (_entity, inputs, inputField, fieldCapabilities) => {
      // Runtime half of the total-record guarantee: no input slipped past the map.
      expect(Object.keys(inputField).sort()).toEqual([...inputs].sort());
      const table: Readonly<Record<string, string>> = fieldCapabilities;
      for (const input of inputs) {
        const field = (inputField as Readonly<Record<string, string | null>>)[input] ?? null;
        if (field === null) {
          // Listed as not vendor-editable. Prove it: no edit route can write it.
          expect(table, `"${input}" is said to be read-only but is editable`).not.toHaveProperty(
            input,
          );
          continue;
        }
        const capability = table[field];
        expect(capability, `"${input}" → "${field}" has no capability`).toBeDefined();
        expect(
          TIER_CAPABILITIES.unclaimed as readonly string[],
          `"${input}" → "${field}" needs "${capability}", which the Free tier lacks`,
        ).toContain(capability);
      }
    },
  );

  it('names the capabilities the spec table names', () => {
    // §13.4's table, verbatim. A change here is a spec change.
    expect(PRODUCT_FIELD_CAPABILITIES.description).toBe('product.listing.edit');
    expect(PRODUCT_FIELD_CAPABILITIES.website).toBe('product.listing.edit');
    expect(PRODUCT_FIELD_CAPABILITIES.logo_url).toBe('product.listing.edit');
    expect(PRODUCT_FIELD_CAPABILITIES.category_slugs).toBe('product.categories.edit');
    for (const field of ['description', 'headquarters', 'website', 'logo_url'] as const) {
      expect(VENDOR_FIELD_CAPABILITIES[field]).toBe('profile.edit');
    }
  });

  it('keeps the Managed-only product fields off the Free tier (decision 4)', () => {
    // The other side of the split. If one of these became Free, that is a pricing
    // decision, and this is where it gets noticed.
    const managedOnly = [
      'tool_integrations_url',
      'api_docs_url',
      'usefulness',
      'audience_slugs',
      'phase_slugs',
      'trade_slugs',
    ] as const;
    for (const field of managedOnly) {
      expect(
        hasCapability('unclaimed', PRODUCT_FIELD_CAPABILITIES[field]),
        `"${field}" is Managed-only`,
      ).toBe(false);
      expect(hasCapability('verified', PRODUCT_FIELD_CAPABILITIES[field])).toBe(true);
    }
  });

  it('every field capability is in the frozen registry', () => {
    // A typo'd id would fail closed and lock the field for every tier.
    for (const capability of [
      ...Object.values(PRODUCT_FIELD_CAPABILITIES),
      ...Object.values(VENDOR_FIELD_CAPABILITIES),
    ]) {
      expect(CAPABILITIES as readonly string[]).toContain(capability);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. A vendor's reply to a review never reaches ranking (AECI-1181).
// ---------------------------------------------------------------------------

/**
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11c.10. A reply is vendor-authored text under
 * a review, and only `verified` may write one (`review.reply`). If any ranking
 * input read it, payment would buy position through the side door. So no
 * Algolia searchable, facet or `customRanking` attribute, no Algolia record
 * field, no public sort key and no `listing_tier` input may name the reply
 * table, its public field or a reply column.
 *
 * This block checks those as data. The source half, which scans the files
 * that compute ranking inputs for a JOIN or import of the reply table, is
 * `apps/api/src/lib/review-reply-ranking-firewall.spec.ts`.
 */

/** Reply-shaped substrings. Lowercased, so `vendorResponses` is caught too. */
const REPLY_SHAPED = [
  'review_response',
  'reviewresponse',
  'vendor_response',
  'vendorresponse',
  'repl',
];

/** Every reply-ish name a careless caller might sort or rank on. */
const REPLY_FIELD_CANDIDATES = [
  'review_responses',
  'reviewResponses',
  'vendor_responses',
  'vendorResponses',
  'review_response',
  'responses',
  'response',
  'replies',
  'reply',
  'reply_count',
  'has_reply',
];

function namesAReply(name: string): boolean {
  const lower = name.toLowerCase();
  return REPLY_SHAPED.some((shape) => lower.includes(shape)) || /^responses?$/.test(lower);
}

const RECORD_SCHEMAS = {
  product: AlgoliaProductRecordSchema,
  vendor: AlgoliaVendorRecordSchema,
  integration: AlgoliaIntegrationRecordSchema,
} as const;

describe('a review reply never reaches a ranking input (§11c.10) [invariant]', () => {
  it('the reply matcher catches every candidate, so the checks below are not vacuous', () => {
    for (const candidate of REPLY_FIELD_CANDIDATES) {
      expect(namesAReply(candidate), candidate).toBe(true);
    }
    // ...and spares the review signals that legitimately rank.
    for (const legit of ['review_count', 'rating_overall_avg', 'reviews', 'listing_tier']) {
      expect(namesAReply(legit), legit).toBe(false);
    }
  });

  it('no Algolia searchable, facet or customRanking attribute names a reply', () => {
    for (const attribute of rankingVocabulary) {
      expect(namesAReply(attribute), `INDEX_SETTINGS attribute "${attribute}"`).toBe(false);
    }
  });

  it('no Algolia record field names a reply', () => {
    // A record field is one settings edit away from ranking, so the record
    // shape is held to the same rule as the settings.
    for (const [entity, schema] of Object.entries(RECORD_SCHEMAS)) {
      const fields = Object.keys(schema.shape);
      expect(fields.length, `${entity} record has no fields`).toBeGreaterThan(5);
      for (const field of fields) {
        expect(namesAReply(field), `${entity} record field "${field}"`).toBe(false);
      }
    }
  });

  it('no public sort key is a reply', () => {
    for (const candidate of REPLY_FIELD_CANDIDATES) {
      expect(ProductSortSchema.safeParse(candidate).success, `?sort=${candidate}`).toBe(false);
      expect(VendorSortSchema.safeParse(candidate).success, `?sort=${candidate}`).toBe(false);
      expect(IntegrationSortSchema.safeParse(candidate).success, `?sort=${candidate}`).toBe(false);
    }
  });

  it('no listing_tier input names a reply, and none is read when one rides along', () => {
    for (const field of [...PRODUCT_LISTING_TIER_INPUTS, ...VENDOR_LISTING_TIER_INPUTS]) {
      expect(namesAReply(field), `listing_tier input "${field}"`).toBe(false);
    }
    const replyFields = {
      vendor_responses: [{ vendor_slug: 'acme', vendor_name: 'Acme', body: 'Thanks.' }],
      review_responses: 3,
      reply_count: 3,
    };
    const productReads = propertiesRead(productListingTier, { ...fullProduct, ...replyFields });
    const vendorReads = propertiesRead(vendorListingTier, { ...fullVendor, ...replyFields });
    for (const read of [...productReads, ...vendorReads]) {
      expect(namesAReply(read), `listing_tier read "${read}"`).toBe(false);
    }
    expect(productListingTier({ ...fullProduct, ...replyFields })).toBe(
      productListingTier(fullProduct),
    );
    expect(vendorListingTier({ ...fullVendor, ...replyFields })).toBe(
      vendorListingTier(fullVendor),
    );
  });

  it('the review.reply capability names no ranking concept', () => {
    // Block 2 covers every capability. This pins the one §11c.9 added, by name.
    expect('review.reply').not.toMatch(RANKING_VOCABULARY_PATTERN);
    expect(rankingVocabulary.has('review.reply')).toBe(false);
    expect(rankingVocabulary.has('review_reply')).toBe(false);
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

  it('gives unclaimed the Free edits and nothing else', () => {
    const free = ['profile.edit', 'product.listing.edit', 'product.categories.edit'];
    expect(capabilitiesFor('unclaimed')).toEqual(free);
    for (const capability of CAPABILITIES) {
      expect(hasCapability('unclaimed', capability)).toBe(free.includes(capability));
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
  //
  // It used to derive "tiers that hold a capability". AECI-1214 gave `unclaimed`
  // the Free capabilities, so that derivation would now include it. Free is never
  // a `vendor_entitlements` row (§13.2), so `unclaimed` is excluded BY NAME.

  it('is exactly TIERS minus unclaimed', () => {
    const derived = TIERS.filter((tier) => tier !== 'unclaimed');
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
