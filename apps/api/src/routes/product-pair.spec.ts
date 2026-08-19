/**
 * GET /api/products/:slug/integrations/:otherSlug — the product-PAIR read
 * (Stage 1.5 §7 / AECI-294), against the in-memory D1 harness.
 */

import type { ClaimDirection } from '@aeci/shared';
import { ProductPairResponseSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  attestations,
  claims,
  integrations,
  products,
  productVendors,
  productVersions,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createProductPairHandler } from './integrations';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const app = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/products/:slug/integrations/:otherSlug',
    handler: createProductPairHandler(t.factory),
  });
const get = (url: string) => app().request(url, {}, TEST_ENV, fakeExecutionContext());

// Procore = u(1)/procore (endpoint A), Revit = u(2)/revit (endpoint B).
async function seedProducts() {
  await t.db.insert(products).values([
    { id: u(1), slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
    { id: u(2), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
  ]);
}

async function integration(
  id: string,
  sourceProductId: string,
  targetProductId: string,
  extra: Partial<typeof integrations.$inferInsert> = {},
) {
  await t.db.insert(integrations).values({
    id,
    sourceProductId,
    targetProductId,
    mechanismKind: 'native',
    direction: 'one-way',
    ...extra,
  });
}

async function dataObject(id: string, slug: string, name: string, displayOrder?: number) {
  await t.db.insert(taxonomyDataObjects).values({ id, slug, name, displayOrder });
}

/** Two vendor companies for the §4.2 distinct-identity cases. `ACME` owning both
 *  endpoints of an integration is the case the dedupe exists for. */
const ACME = u(901);
const GLOBEX = u(902);

/**
 * Both companies, each owning one endpoint.
 *
 * `entitled` drives §9.3's version-diff gate, which AECI-304 put on the PAIR'S
 * VENDORS rather than the reader: Acme (Procore's primary vendor) carries
 * `verified`, the denormalized mirror of an `active` entitlement row, so historical
 * depth is open. `entitled: false` leaves both endpoint vendors unentitled, which is
 * the clamped case. Globex stays unverified either way, so the default fixture also
 * proves "either side pays".
 */
async function seedVendors({ entitled = true } = {}) {
  await t.db.insert(vendors).values([
    { id: ACME, companyName: 'Acme Software', slug: 'acme-software', verified: entitled },
    { id: GLOBEX, companyName: 'Globex', slug: 'globex', verified: false },
  ]);
  await t.db.insert(productVendors).values([
    { productId: u(1), vendorId: ACME, isPrimary: true },
    { productId: u(2), vendorId: GLOBEX, isPrimary: true },
  ]);
}

interface SeedAttestation {
  source: string;
  asserted: boolean;
  note?: string;
  /** `attested_by_vendor_id` — the identity `computeAgreement` dedupes by (§4.2). */
  by?: string;
  /** Supersession (AECI-603). A retracted row must neither vote nor render. */
  retractedAt?: string;
  /** The PRECISE version stamps (AECI-303 / §8.2) — `product_versions` ids. */
  introducedVersion?: string;
  deprecatedVersion?: string;
}

/**
 * Seed one release of one product (AECI-607). `sortKey` is passed explicitly rather
 * than derived so a test can build a tie or an out-of-label order on purpose; the
 * defaults below use the same relative order the real derivation produces.
 */
async function version(
  id: string,
  productId: string,
  label: string,
  sortKey: number,
  extra: Partial<typeof productVersions.$inferInsert> = {},
) {
  await t.db.insert(productVersions).values({ id, productId, label, sortKey, ...extra });
}

/** Seed a claim on an integration. Defaults to the Stage 1.5 reality: a single
 *  AECi seed, which resolves `unverified`. */
async function claim(
  id: string,
  integrationId: string,
  dataObjectId: string,
  direction: ClaimDirection,
  atts: SeedAttestation[] = [{ source: 'aeci', asserted: true, note: 'Curated by AECi.' }],
) {
  await t.db.insert(claims).values({ id, integrationId, dataObjectId, direction });
  for (const a of atts) {
    await t.db.insert(attestations).values({
      id: crypto.randomUUID(),
      claimId: id,
      source: a.source,
      asserted: a.asserted,
      note: a.note ?? null,
      attestedByVendorId: a.by ?? null,
      retractedAt: a.retractedAt ?? null,
      introducedVersionId: a.introducedVersion ?? null,
      deprecatedVersionId: a.deprecatedVersion ?? null,
    });
  }
}

describe('GET /api/products/:slug/integrations/:otherSlug', () => {
  it('returns the pair with the context product on the left', async () => {
    await seedProducts();
    await integration(u(10), u(1), u(2), { name: 'Procore ⇄ Revit' });

    const res = await get('/api/products/procore/integrations/revit');
    expect(res.status).toBe(200);
    const body = ProductPairResponseSchema.parse(await res.json());
    expect(body.context_product.slug).toBe('procore');
    expect(body.other_product.slug).toBe('revit');
    expect(body.mechanisms).toHaveLength(1);
    expect(body.sync_headline).toEqual({ total: 0, confirmed: 0, single_source: 0 });
  });

  it('translates a one-way direction relative to the context product', async () => {
    await seedProducts();
    // Stored source = Procore (A), target = Revit (B), one-way (A → B).
    await integration(u(10), u(1), u(2));

    const fromA = ProductPairResponseSchema.parse(
      await (await get('/api/products/procore/integrations/revit')).json(),
    );
    expect(fromA.mechanisms[0]!.direction).toBe('outbound'); // data leaves Procore

    const fromB = ProductPairResponseSchema.parse(
      await (await get('/api/products/revit/integrations/procore')).json(),
    );
    expect(fromB.mechanisms[0]!.direction).toBe('inbound'); // Revit receives
    // Same underlying integration row, whichever way the pair is viewed.
    expect(fromB.mechanisms[0]!.id).toBe(fromA.mechanisms[0]!.id);
  });

  it('reports a bidirectional integration as "both" from either side', async () => {
    await seedProducts();
    await integration(u(10), u(1), u(2), { direction: 'bidirectional' });

    for (const url of [
      '/api/products/procore/integrations/revit',
      '/api/products/revit/integrations/procore',
    ]) {
      const body = ProductPairResponseSchema.parse(await (await get(url)).json());
      expect(body.mechanisms[0]!.direction).toBe('both');
    }
  });

  it('consolidates every integration between the pair, either orientation', async () => {
    await seedProducts();
    await integration(u(10), u(1), u(2), { name: 'A connector', mechanismKind: 'native' });
    // The second mechanism is stored in the opposite orientation (Revit → Procore).
    await integration(u(11), u(2), u(1), { name: 'B connector', mechanismKind: 'partner' });

    const body = ProductPairResponseSchema.parse(
      await (await get('/api/products/procore/integrations/revit')).json(),
    );
    expect(body.mechanisms.map((m) => m.id).sort()).toEqual([u(10), u(11)]);
    // Procore is source of #10 (outbound) and target of #11 (inbound).
    const byId = new Map(body.mechanisms.map((m) => [m.id, m.direction]));
    expect(byId.get(u(10))).toBe('outbound');
    expect(byId.get(u(11))).toBe('inbound');
  });

  it('returns 200 with an empty mechanisms list for an unconnected pair', async () => {
    await seedProducts();
    const res = await get('/api/products/procore/integrations/revit');
    expect(res.status).toBe(200);
    const body = ProductPairResponseSchema.parse(await res.json());
    expect(body.mechanisms).toEqual([]);
    expect(body.sync_headline).toEqual({ total: 0, confirmed: 0, single_source: 0 });
  });

  it('404s when either slug is unknown', async () => {
    await seedProducts();
    expect((await get('/api/products/nope/integrations/revit')).status).toBe(404);
    expect((await get('/api/products/procore/integrations/nope')).status).toBe(404);
  });

  it('404s when the two slugs are equal', async () => {
    await seedProducts();
    expect((await get('/api/products/procore/integrations/procore')).status).toBe(404);
  });
});

describe('GET /api/products/:slug/integrations/:otherSlug — Layer B claims (§8)', () => {
  // A pair connected by one mechanism (source = Procore/A, target = Revit/B)
  // carrying three claims: Models a_to_b, RFIs b_to_a, Schedules both.
  async function seedPairWithClaims() {
    await seedProducts();
    await integration(u(10), u(1), u(2), {
      name: 'ACC connector',
      mechanismKind: 'marketplace-app',
    });
    await dataObject(u(101), 'models', 'Models', 1);
    await dataObject(u(102), 'rfis', 'RFIs', 2);
    await dataObject(u(103), 'schedules', 'Schedules', 3);
    await claim(u(201), u(10), u(101), 'a_to_b');
    await claim(u(202), u(10), u(102), 'b_to_a');
    await claim(u(203), u(10), u(103), 'both');
  }

  it('hydrates claims with context-relative direction, unverified agreement, and provenance', async () => {
    await seedPairWithClaims();

    const body = ProductPairResponseSchema.parse(
      await (await get('/api/products/procore/integrations/revit')).json(),
    );
    const claimsOut = body.mechanisms[0]!.claims;
    expect(claimsOut.map((c) => [c.data_object_slug, c.direction])).toEqual([
      ['models', 'outbound'], // a_to_b, context = source A (Procore) → leaves Procore
      ['rfis', 'inbound'], // b_to_a → arrives at Procore
      ['schedules', 'both'],
    ]);
    // Stage 1.5: every claim is AECi-only, so agreement is always unverified.
    expect(claimsOut.every((c) => c.agreement === 'unverified')).toBe(true);
    // Provenance rides along: the single AECi attestation with its note. The
    // AECi seed is never attributed to an endpoint — it is not a party to the vote.
    expect(claimsOut[0]!.attestations).toEqual([
      {
        source: 'aeci',
        attestor: 'aeci',
        asserted: true,
        note: 'Curated by AECi.',
        introduced_at: null,
        deprecated_at: null,
      },
    ]);
    // Sync headline: breadth honest, confirmed always 0 in 1.5.
    expect(body.sync_headline).toEqual({ total: 3, confirmed: 0, single_source: 0 });
  });

  it('mirrors claim directions when the pair is viewed from the other product', async () => {
    await seedPairWithClaims();

    const body = ProductPairResponseSchema.parse(
      await (await get('/api/products/revit/integrations/procore')).json(),
    );
    const bySlug = new Map(
      body.mechanisms[0]!.claims.map((c) => [c.data_object_slug, c.direction]),
    );
    expect(bySlug.get('models')).toBe('inbound'); // a_to_b, context = target B (Revit) → arrives
    expect(bySlug.get('rfis')).toBe('outbound');
    expect(bySlug.get('schedules')).toBe('both');
    expect(body.sync_headline).toEqual({ total: 3, confirmed: 0, single_source: 0 });
  });

  it('counts a data_object moving through two mechanisms as two distinct claims (§3.1)', async () => {
    await seedProducts();
    await integration(u(10), u(1), u(2), { name: 'Marketplace', mechanismKind: 'marketplace-app' });
    await integration(u(11), u(1), u(2), { name: 'Partner', mechanismKind: 'partner' });
    await dataObject(u(102), 'rfis', 'RFIs', 2);
    await claim(u(201), u(10), u(102), 'b_to_a'); // RFIs inbound via marketplace
    await claim(u(202), u(11), u(102), 'a_to_b'); // RFIs outbound via partner

    const body = ProductPairResponseSchema.parse(
      await (await get('/api/products/procore/integrations/revit')).json(),
    );
    const byMech = new Map(body.mechanisms.map((m) => [m.id, m.claims]));
    expect(byMech.get(u(10))!.map((c) => c.direction)).toEqual(['inbound']);
    expect(byMech.get(u(11))!.map((c) => c.direction)).toEqual(['outbound']);
    // Two rows, never de-duplicated → total counts both.
    expect(body.sync_headline).toEqual({ total: 2, confirmed: 0, single_source: 0 });
  });

  it('orders claims by the data_object display_order', async () => {
    await seedProducts();
    await integration(u(10), u(1), u(2), { mechanismKind: 'native' });
    await dataObject(u(101), 'schedules', 'Schedules', 3);
    await dataObject(u(102), 'models', 'Models', 1);
    await dataObject(u(103), 'rfis', 'RFIs', 2);
    // Insert claims out of display order; the mapper must sort them.
    await claim(u(201), u(10), u(101), 'a_to_b');
    await claim(u(202), u(10), u(102), 'a_to_b');
    await claim(u(203), u(10), u(103), 'a_to_b');

    const body = ProductPairResponseSchema.parse(
      await (await get('/api/products/procore/integrations/revit')).json(),
    );
    expect(body.mechanisms[0]!.claims.map((c) => c.data_object_slug)).toEqual([
      'models',
      'rfis',
      'schedules',
    ]);
  });
});

describe('GET /api/products/:slug/integrations/:otherSlug — agreement states (§4)', () => {
  /** One mechanism (Procore/A → Revit/B) with one RFIs claim carrying `atts`. */
  async function seedClaimWith(atts: SeedAttestation[]) {
    await seedProducts();
    await seedVendors();
    await integration(u(10), u(1), u(2), { mechanismKind: 'native' });
    await dataObject(u(102), 'rfis', 'RFIs', 2);
    await claim(u(201), u(10), u(102), 'a_to_b', atts);
  }

  const readClaim = async (url = '/api/products/procore/integrations/revit') => {
    const body = ProductPairResponseSchema.parse(await (await get(url)).json());
    return { claim: body.mechanisms[0]!.claims[0]!, headline: body.sync_headline };
  };

  it('resolves single_source when one vendor affirms and the counterparty is silent', async () => {
    await seedClaimWith([
      { source: 'aeci', asserted: true },
      { source: 'vendor_a', asserted: true, by: ACME },
    ]);
    const { claim: c, headline } = await readClaim();
    expect(c.agreement).toBe('single_source');
    expect(headline).toEqual({ total: 1, confirmed: 0, single_source: 1 });
  });

  it('resolves confirmed only for two DISTINCT vendor identities', async () => {
    await seedClaimWith([
      { source: 'vendor_a', asserted: true, by: ACME },
      { source: 'vendor_b', asserted: true, by: GLOBEX },
    ]);
    const { claim: c, headline } = await readClaim();
    expect(c.agreement).toBe('confirmed');
    expect(headline).toEqual({ total: 1, confirmed: 1, single_source: 0 });
  });

  // The reason the dedupe exists: `product_vendors` is many-to-many, so one
  // company can own both endpoints, fill both slots, and would otherwise
  // manufacture "Vendor-confirmed" on its own intra-portfolio integration.
  it('resolves single_source when ONE vendor owns both endpoints and affirms both slots', async () => {
    await seedClaimWith([
      { source: 'vendor_a', asserted: true, by: ACME },
      { source: 'vendor_b', asserted: true, by: ACME },
    ]);
    const { claim: c, headline } = await readClaim();
    expect(c.agreement).toBe('single_source');
    expect(headline).toEqual({ total: 1, confirmed: 0, single_source: 1 });
  });

  it('resolves conflict when two distinct vendors disagree', async () => {
    await seedClaimWith([
      { source: 'vendor_a', asserted: true, by: ACME },
      { source: 'vendor_b', asserted: false, by: GLOBEX },
    ]);
    const { claim: c, headline } = await readClaim();
    expect(c.agreement).toBe('conflict');
    // A disputed claim counts in neither verified bucket.
    expect(headline).toEqual({ total: 1, confirmed: 0, single_source: 0 });
  });

  it('keeps a denied-only claim at unverified, never conflict', async () => {
    await seedClaimWith([
      { source: 'aeci', asserted: true },
      { source: 'vendor_a', asserted: false, by: ACME },
    ]);
    expect((await readClaim()).claim.agreement).toBe('unverified');
  });

  // The AECI-603 §2.5 handoff: the read path must filter `retracted_at IS NULL`,
  // or a withdrawn assertion keeps voting once AECI-301 ships the retract endpoint.
  it('excludes a retracted attestation from both the vote and the payload', async () => {
    await seedClaimWith([
      { source: 'vendor_a', asserted: true, by: ACME },
      { source: 'vendor_b', asserted: true, by: GLOBEX, retractedAt: '2026-08-14T00:00:00.000Z' },
    ]);
    const { claim: c, headline } = await readClaim();
    // Two affirmations on the row, but only one live → not bilateral.
    expect(c.agreement).toBe('single_source');
    expect(headline).toEqual({ total: 1, confirmed: 0, single_source: 1 });
    expect(c.attestations.map((a) => a.source)).toEqual(['vendor_a']);
  });

  // `deprecated_at` is a version stamp (§3.3), NOT retraction — gating the read
  // on it would silence a vendor the moment it recorded that a flow ended.
  it('does not treat a deprecated_at version stamp as retraction', async () => {
    await seedProducts();
    await seedVendors();
    await integration(u(10), u(1), u(2), { mechanismKind: 'native' });
    await dataObject(u(102), 'rfis', 'RFIs', 2);
    await t.db.insert(claims).values({
      id: u(201),
      integrationId: u(10),
      dataObjectId: u(102),
      direction: 'a_to_b',
    });
    for (const [source, by] of [
      ['vendor_a', ACME],
      ['vendor_b', GLOBEX],
    ] as const) {
      await t.db.insert(attestations).values({
        id: crypto.randomUUID(),
        claimId: u(201),
        source,
        asserted: true,
        attestedByVendorId: by,
        deprecatedAt: '2026-01-01T00:00:00.000Z',
      });
    }
    const { claim: c } = await readClaim();
    expect(c.agreement).toBe('confirmed');
    expect(c.attestations).toHaveLength(2);
  });

  // `attestor` is what lets the pair page render "Confirmed by {vendor}" from
  // the two hydrated `ProductListItem.vendor` links, with no vendors join.
  it('translates the attestation slot into the context frame, both orientations', async () => {
    await seedClaimWith([
      { source: 'vendor_a', asserted: true, by: ACME },
      { source: 'vendor_b', asserted: false, by: GLOBEX },
    ]);

    // Viewed from Procore (endpoint A): vendor_a is the context's own vendor.
    const fromA = await readClaim();
    expect(new Map(fromA.claim.attestations.map((a) => [a.source, a.attestor]))).toEqual(
      new Map([
        ['vendor_a', 'context'],
        ['vendor_b', 'other'],
      ]),
    );

    // Viewed from Revit (endpoint B): the mirror.
    const fromB = await readClaim('/api/products/revit/integrations/procore');
    expect(new Map(fromB.claim.attestations.map((a) => [a.source, a.attestor]))).toEqual(
      new Map([
        ['vendor_a', 'other'],
        ['vendor_b', 'context'],
      ]),
    );
  });
});

// ─── The page-header maintenance marker (AECI-616 / §13) ─────────────────────
//
// A pair has N mechanisms but ONE header marker, so `computePairMaintenance` folds
// them. The branch-scoped date is the part worth pinning: a global max would let an
// AECi review date sit inside a sentence that reads "Vendor-maintained."

describe('GET /api/products/:slug/integrations/:otherSlug — maintenance marker (AECI-616)', () => {
  const AECI_DATE = '2026-02-01T00:00:00.000Z';
  const OLD_VENDOR_DATE = '2026-01-01T00:00:00.000Z';
  const NEW_AECI_DATE = '2026-07-01T00:00:00.000Z';

  it('reports the unreviewed AECi baseline for a pair nobody has re-checked', async () => {
    await seedProducts();
    await integration(u(10), u(1), u(2));

    const res = await get('/api/products/procore/integrations/revit');
    const body = ProductPairResponseSchema.parse(await res.json());
    expect(body.maintenance).toEqual({ maintained_by: 'aeci', last_reviewed_at: null });
  });

  it('is AECi-maintained with no date for an empty pair', async () => {
    await seedProducts();

    const res = await get('/api/products/procore/integrations/revit');
    const body = ProductPairResponseSchema.parse(await res.json());
    expect(body.maintenance).toEqual({ maintained_by: 'aeci', last_reviewed_at: null });
  });

  it('takes the MOST RECENT date across mechanisms in the same branch', async () => {
    await seedProducts();
    await integration(u(10), u(1), u(2), { lastReviewedAt: OLD_VENDOR_DATE });
    await integration(u(11), u(1), u(2), { lastReviewedAt: NEW_AECI_DATE });
    await integration(u(12), u(1), u(2)); // never reviewed — contributes nothing

    const res = await get('/api/products/procore/integrations/revit');
    const body = ProductPairResponseSchema.parse(await res.json());
    expect(body.maintenance).toEqual({
      maintained_by: 'aeci',
      last_reviewed_at: NEW_AECI_DATE,
    });
  });

  it('is vendor-maintained when ANY mechanism is, and dates it from the VENDOR mechanisms only', async () => {
    await seedProducts();
    // The vendor's mechanism was reviewed in January; AECi re-checked a different
    // mechanism in July. The header says "Vendor-maintained", so the date must be
    // the vendor's — attributing AECi's July review to the vendor would be a lie,
    // and it is exactly what an unscoped max() would produce.
    await integration(u(10), u(1), u(2), {
      maintainedBy: 'vendor',
      lastReviewedAt: OLD_VENDOR_DATE,
    });
    await integration(u(11), u(1), u(2), { lastReviewedAt: NEW_AECI_DATE });

    const res = await get('/api/products/procore/integrations/revit');
    const body = ProductPairResponseSchema.parse(await res.json());
    expect(body.maintenance).toEqual({
      maintained_by: 'vendor',
      last_reviewed_at: OLD_VENDOR_DATE,
    });
  });

  it('renders no date when the winning branch has none, even if the other branch does', async () => {
    await seedProducts();
    await integration(u(10), u(1), u(2), { maintainedBy: 'vendor' }); // vendor, unreviewed
    await integration(u(11), u(1), u(2), { lastReviewedAt: AECI_DATE }); // aeci, reviewed

    const res = await get('/api/products/procore/integrations/revit');
    const body = ProductPairResponseSchema.parse(await res.json());
    expect(body.maintenance).toEqual({ maintained_by: 'vendor', last_reviewed_at: null });
  });
});

// ─── The version selectors + diff (AECI-303 / §9) ────────────────────────────
//
// The invariant every case here orbits: `version_diff` is `null` — and the response
// is the pre-AECI-303 shape — unless BOTH a release exists AND a live attestation
// carries a version stamp. That null is the browser's entire suppression rule, so
// it is what makes "latest × latest renders identically to today" structural.

describe('GET /api/products/:slug/integrations/:otherSlug — version diff (AECI-303)', () => {
  // Procore's releases. `2026.9` before `2026.10` — the case a lexical sort gets
  // wrong, kept here so the pair read inherits the AECI-607 guarantee.
  const P1 = u(700); // 2026.1
  const P9 = u(701); // 2026.9
  const P10 = u(702); // 2026.10
  // Revit's releases. A different label scheme on purpose: `sort_key` is
  // per-product and comparing across the two would be meaningless.
  const R4 = u(710); // v4
  const R5 = u(711); // v5

  async function seedVersions() {
    await version(P1, u(1), '2026.1', 20_260_000_100_000);
    await version(P9, u(1), '2026.9', 20_260_000_900_000);
    await version(P10, u(1), '2026.10', 20_260_001_000_000);
    await version(R4, u(2), 'v4', 40_000_000_000, { releasedAt: '2026-01-15' });
    await version(R5, u(2), 'v5', 50_000_000_000);
  }

  /** One stamped claim on one mechanism, plus an unstamped sibling. `entitled`
   *  drives §9.3's gate — see `seedVendors`. */
  async function seedStampedPair(atts: SeedAttestation[], { entitled = true } = {}) {
    await seedProducts();
    await seedVendors({ entitled });
    await seedVersions();
    await integration(u(10), u(1), u(2));
    await dataObject(u(20), 'rfis', 'RFIs', 1);
    await dataObject(u(21), 'submittals', 'Submittals', 2);
    await claim(u(30), u(10), u(20), 'a_to_b', atts);
    // The Stage 1.5 baseline: unstamped, so it must be present at every selection.
    await claim(u(31), u(10), u(21), 'a_to_b');
  }

  it('is null when neither product has a release — the whole catalog today', async () => {
    await seedProducts();
    await integration(u(10), u(1), u(2));
    await dataObject(u(20), 'rfis', 'RFIs', 1);
    await claim(u(30), u(10), u(20), 'a_to_b');

    const res = await get('/api/products/procore/integrations/revit');
    const raw = (await res.json()) as Record<string, unknown>;
    expect(raw['version_diff']).toBeNull();
    // …and no claim carries a version_status, so the claim rows are byte-identical
    // to the pre-AECI-303 shape.
    const body = ProductPairResponseSchema.parse(raw);
    expect(body.mechanisms[0]!.claims[0]!.version_status).toBeUndefined();
  });

  it('is null when releases exist but NO attestation is stamped — no dead selectors', async () => {
    await seedProducts();
    await seedVersions();
    await integration(u(10), u(1), u(2));
    await dataObject(u(20), 'rfis', 'RFIs', 1);
    await claim(u(30), u(10), u(20), 'a_to_b'); // unstamped AECi seed

    const res = await get('/api/products/procore/integrations/revit');
    const body = ProductPairResponseSchema.parse(await res.json());
    expect(body.version_diff).toBeNull();
  });

  it('defaults to latest × latest and lists both products ascending', async () => {
    await seedStampedPair([{ source: 'aeci', asserted: true, introducedVersion: P1 }]);

    const res = await get('/api/products/procore/integrations/revit');
    const body = ProductPairResponseSchema.parse(await res.json());
    const diff = body.version_diff!;
    expect(diff.context_versions.map((v) => v.label)).toEqual(['2026.1', '2026.9', '2026.10']);
    expect(diff.other_versions.map((v) => v.label)).toEqual(['v4', 'v5']);
    expect(diff.selected).toEqual({ context: '2026.10', other: 'v5' });
    expect(diff.is_default).toBe(true);
    expect(diff.diff_access).toBe('full');
    // Each side steps back one release, independently.
    expect(diff.previous).toEqual({ context: '2026.9', other: 'v4' });
  });

  it('surfaces released_at for display but never an id or sort_key', async () => {
    await seedStampedPair([{ source: 'aeci', asserted: true, introducedVersion: P1 }]);

    const res = await get('/api/products/procore/integrations/revit');
    const raw = (await res.json()) as {
      version_diff: { other_versions: Record<string, unknown>[] };
    };
    const v4 = raw.version_diff.other_versions[0]!;
    expect(v4).toEqual({ label: 'v4', released_at: '2026-01-15' });
  });

  it('honours an explicit label and marks the selection non-default', async () => {
    await seedStampedPair([{ source: 'aeci', asserted: true, introducedVersion: P1 }]);

    const res = await get('/api/products/procore/integrations/revit?context_version=2026.9');
    const body = ProductPairResponseSchema.parse(await res.json());
    expect(body.version_diff!.selected).toEqual({ context: '2026.9', other: 'v5' });
    expect(body.version_diff!.is_default).toBe(false);
    expect(body.version_diff!.previous).toEqual({ context: '2026.1', other: 'v4' });
  });

  it('degrades an unknown label to latest and reports is_default — never a 404', async () => {
    await seedStampedPair([{ source: 'aeci', asserted: true, introducedVersion: P1 }]);

    // The pair exists; only the selection is stale (a renamed or hand-typed label).
    // A 404 here would render the NotFound shell for a valid page.
    const res = await get('/api/products/procore/integrations/revit?context_version=nope');
    expect(res.status).toBe(200);
    const body = ProductPairResponseSchema.parse(await res.json());
    expect(body.version_diff!.selected.context).toBe('2026.10');
    // is_default follows the RESOLVED selection, which is what the resolver's
    // noindex reads — a degraded URL serves canonical content and stays indexable.
    expect(body.version_diff!.is_default).toBe(true);
  });

  it('degrades an over-long label to latest', async () => {
    await seedStampedPair([{ source: 'aeci', asserted: true, introducedVersion: P1 }]);

    const res = await get(
      `/api/products/procore/integrations/revit?context_version=${'x'.repeat(200)}`,
    );
    const body = ProductPairResponseSchema.parse(await res.json());
    expect(body.version_diff!.selected.context).toBe('2026.10');
  });

  it('selects 2026.10 as latest, not 2026.9 — the lexical trap', async () => {
    await seedStampedPair([{ source: 'aeci', asserted: true, introducedVersion: P1 }]);

    const res = await get('/api/products/procore/integrations/revit');
    const body = ProductPairResponseSchema.parse(await res.json());
    expect(body.version_diff!.selected.context).toBe('2026.10');
  });

  it('exposes the version stamps as labels on the attestation', async () => {
    await seedStampedPair([
      { source: 'aeci', asserted: true, introducedVersion: P1, deprecatedVersion: P10 },
    ]);

    const res = await get('/api/products/procore/integrations/revit?context_version=2026.9');
    const body = ProductPairResponseSchema.parse(await res.json());
    const claimRow = body.mechanisms[0]!.claims.find((c) => c.data_object_slug === 'rfis')!;
    expect(claimRow.attestations[0]!.introduced_version).toBe('2026.1');
    expect(claimRow.attestations[0]!.deprecated_version).toBe('2026.10');
    // The unstamped sibling omits the keys entirely rather than sending null.
    const sibling = body.mechanisms[0]!.claims.find((c) => c.data_object_slug === 'submittals')!;
    expect(sibling.attestations[0]).not.toHaveProperty('introduced_version');
  });

  it('keeps an UNSTAMPED claim present at every selection', async () => {
    await seedStampedPair([{ source: 'aeci', asserted: true, introducedVersion: P10 }]);

    for (const query of ['', '?context_version=2026.1', '?context_version=2026.9']) {
      const res = await get(`/api/products/procore/integrations/revit${query}`);
      const body = ProductPairResponseSchema.parse(await res.json());
      const slugs = body.mechanisms[0]!.claims.map((c) => c.data_object_slug);
      expect(slugs).toContain('submittals');
    }
  });

  it('marks a claim introduced in the selected version as `added`', async () => {
    await seedStampedPair([{ source: 'aeci', asserted: true, introducedVersion: P10 }]);

    const res = await get('/api/products/procore/integrations/revit');
    const body = ProductPairResponseSchema.parse(await res.json());
    const claimRow = body.mechanisms[0]!.claims.find((c) => c.data_object_slug === 'rfis')!;
    expect(claimRow.version_status).toBe('added');
    expect(body.version_diff!.counts).toEqual({ added: 1, removed: 0 });
  });

  it('renders a `removed` claim but EXCLUDES it from sync_headline', async () => {
    // Deprecated in 2026.10 (the latest), so gone from it but present in 2026.9.
    await seedStampedPair([{ source: 'aeci', asserted: true, deprecatedVersion: P10 }]);

    const res = await get('/api/products/procore/integrations/revit');
    const body = ProductPairResponseSchema.parse(await res.json());
    const claimRow = body.mechanisms[0]!.claims.find((c) => c.data_object_slug === 'rfis')!;
    expect(claimRow.version_status).toBe('removed');
    expect(body.version_diff!.counts).toEqual({ added: 0, removed: 1 });
    // Two claims render, but "N data objects sync" counts only the one that does.
    expect(body.mechanisms[0]!.claims).toHaveLength(2);
    expect(body.sync_headline.total).toBe(1);
  });

  it('DROPS a claim absent at both the selected and the previous pair', async () => {
    // Deprecated in 2026.9: absent at the 2026.10 selection AND at the 2026.9
    // previous pair, so it belongs to an earlier era. Without the drop, a long
    // release history renders every flow the pair ever had.
    await seedStampedPair([{ source: 'aeci', asserted: true, deprecatedVersion: P9 }]);

    const res = await get('/api/products/procore/integrations/revit');
    const body = ProductPairResponseSchema.parse(await res.json());
    expect(body.mechanisms[0]!.claims.map((c) => c.data_object_slug)).toEqual(['submittals']);
    // …and it returns when the reader walks back to a version where it existed.
    const older = await get('/api/products/procore/integrations/revit?context_version=2026.1');
    const olderBody = ProductPairResponseSchema.parse(await older.json());
    expect(olderBody.mechanisms[0]!.claims.map((c) => c.data_object_slug)).toContain('rfis');
  });

  it('conjoins the two sides — the OTHER product can exclude a claim on its own', async () => {
    await seedProducts();
    await seedVersions();
    await seedVendors();
    await integration(u(10), u(1), u(2));
    await dataObject(u(20), 'rfis', 'RFIs', 1);
    // vendor_a stamps Procore 2026.1 (long present); vendor_b stamps Revit v5.
    // Present only where BOTH sides admit the selection, so the Revit axis alone
    // decides — which is what "for each attesting side" means.
    await claim(u(30), u(10), u(20), 'a_to_b', [
      { source: 'vendor_a', asserted: true, by: ACME, introducedVersion: P1 },
      { source: 'vendor_b', asserted: true, by: GLOBEX, introducedVersion: R5 },
    ]);

    // At latest × latest the Revit side has just introduced it: `added`.
    const atLatest = ProductPairResponseSchema.parse(
      await (await get('/api/products/procore/integrations/revit')).json(),
    );
    expect(atLatest.mechanisms[0]!.claims.map((c) => c.version_status)).toEqual(['added']);

    // Pin the Revit selector to v4 — before vendor_b introduced it. Absent at v4
    // AND at v4's own previous (there is none, so v4 is held), so it drops.
    const atV4 = ProductPairResponseSchema.parse(
      await (await get('/api/products/procore/integrations/revit?other_version=v4')).json(),
    );
    expect(atV4.mechanisms[0]!.claims).toHaveLength(0);
  });

  it('reports `removed` when the OTHER side deprecated the flow', async () => {
    await seedProducts();
    await seedVersions();
    await seedVendors();
    await integration(u(10), u(1), u(2));
    await dataObject(u(20), 'rfis', 'RFIs', 1);
    // Deprecated in Revit v5 (the latest), so present at v4 and gone at v5.
    await claim(u(30), u(10), u(20), 'a_to_b', [
      { source: 'vendor_b', asserted: true, by: GLOBEX, deprecatedVersion: R5 },
    ]);

    const res = await get('/api/products/procore/integrations/revit');
    const body = ProductPairResponseSchema.parse(await res.json());
    expect(body.mechanisms[0]!.claims.map((c) => c.version_status)).toEqual(['removed']);
    expect(body.version_diff!.counts).toEqual({ added: 0, removed: 1 });
    // The free, default view now reports zero syncing flows — correct, and the
    // point of applying presence uniformly rather than only to historical picks.
    expect(body.sync_headline.total).toBe(0);
  });

  it('resolves a stamp against the product it belongs to, whatever the orientation', async () => {
    // The same pair from the other URL. `vendor_a` is still Procore's slot, so the
    // Procore stamp must still be evaluated against the Procore selector — which is
    // now the `other_version` axis.
    await seedProducts();
    await seedVersions();
    await seedVendors();
    await integration(u(10), u(1), u(2));
    await dataObject(u(20), 'rfis', 'RFIs', 1);
    await claim(u(30), u(10), u(20), 'a_to_b', [
      { source: 'vendor_a', asserted: true, by: ACME, introducedVersion: P10 },
    ]);

    // From revit: Procore is the OTHER product, so its axis is other_version.
    const fromRevit = ProductPairResponseSchema.parse(
      await (await get('/api/products/revit/integrations/procore?other_version=2026.9')).json(),
    );
    expect(fromRevit.mechanisms[0]!.claims).toHaveLength(0);
    // From procore: the same exclusion, on the context axis.
    const fromProcore = ProductPairResponseSchema.parse(
      await (await get('/api/products/procore/integrations/revit?context_version=2026.9')).json(),
    );
    expect(fromProcore.mechanisms[0]!.claims).toHaveLength(0);
  });

  it('treats a claim whose stamped version was DELETED as always present', async () => {
    // `ON DELETE SET NULL` degrades the stamp rather than deleting the assertion
    // (§8.2), which lands the claim back on the "no version data" baseline.
    await seedStampedPair([{ source: 'aeci', asserted: true, introducedVersion: P10 }]);
    await t.raw.prepare('DELETE FROM product_versions WHERE id = ?').run(P10);

    const res = await get('/api/products/procore/integrations/revit?context_version=2026.1');
    const body = ProductPairResponseSchema.parse(await res.json());
    // Present, and — with no stamps left anywhere on the pair — the diff no longer
    // applies at all.
    expect(body.mechanisms[0]!.claims.map((c) => c.data_object_slug)).toContain('rfis');
    expect(body.version_diff).toBeNull();
  });

  it('has no previous pair at the earliest selection, so everything is `unchanged`', async () => {
    await seedStampedPair([{ source: 'aeci', asserted: true, introducedVersion: P1 }]);

    const res = await get(
      '/api/products/procore/integrations/revit?context_version=2026.1&other_version=v4',
    );
    const body = ProductPairResponseSchema.parse(await res.json());
    expect(body.version_diff!.previous).toBeNull();
    for (const claimRow of body.mechanisms[0]!.claims) {
      expect(claimRow.version_status).toBe('unchanged');
    }
  });

  it('exposes the claim id so the timeline read can join on it', async () => {
    await seedStampedPair([{ source: 'aeci', asserted: true, introducedVersion: P1 }]);

    const res = await get('/api/products/procore/integrations/revit');
    const body = ProductPairResponseSchema.parse(await res.json());
    expect(body.mechanisms[0]!.claims.map((c) => c.id)).toEqual(
      expect.arrayContaining([u(30), u(31)]),
    );
  });

  it('orders claims by display_order regardless of the version selection', async () => {
    // Ordering is the mapper's job and independent of the diff, so walking the
    // selectors never reshuffles a lane.
    await seedStampedPair([{ source: 'aeci', asserted: true, introducedVersion: P1 }]);

    for (const query of ['', '?context_version=2026.9']) {
      const res = await get(`/api/products/procore/integrations/revit${query}`);
      const body = ProductPairResponseSchema.parse(await res.json());
      expect(body.mechanisms[0]!.claims.map((c) => c.data_object_slug)).toEqual([
        'rfis',
        'submittals',
      ]);
    }
  });

  // ── AECI-304: the paywall is on the PAIR'S VENDORS, never the reader ───────
  describe('the entitlement gate (§9.3)', () => {
    const HISTORICAL = '/api/products/procore/integrations/revit?context_version=2026.1';
    const LATEST = '/api/products/procore/integrations/revit';

    it('serves the LATEST view in full to an unentitled pair', async () => {
      // §8.1(4) / §11, asserted directly: the latest-version view is always free and
      // full-fidelity. Byte-for-byte what an entitled pair gets.
      await seedStampedPair([{ source: 'aeci', asserted: true, introducedVersion: P1 }], {
        entitled: false,
      });

      const body = ProductPairResponseSchema.parse(await (await get(LATEST)).json());
      const diff = body.version_diff!;
      expect(diff.diff_access).toBe('full');
      expect(diff.selected).toEqual({ context: '2026.10', other: 'v5' });
      expect(diff.previous).toEqual({ context: '2026.9', other: 'v4' });
      expect(body.mechanisms[0]!.claims.map((c) => c.data_object_slug)).toEqual([
        'rfis',
        'submittals',
      ]);
    });

    it('serves the latest DISPUTE in full to an unentitled pair — paywall the diff, never the dispute', async () => {
      // Agreement is computed from the live attestations and is deliberately
      // independent of the version selection, so a conflict / single_source state
      // renders identically on a gated pair.
      await seedStampedPair(
        [
          { source: 'vendor_a', asserted: true, by: ACME, introducedVersion: P1 },
          { source: 'vendor_b', asserted: false, by: GLOBEX },
        ],
        { entitled: false },
      );

      const body = ProductPairResponseSchema.parse(await (await get(LATEST)).json());
      expect(body.mechanisms[0]!.claims[0]!.agreement).toBe('conflict');
      // Both sides' attestations still render, so a one-sided state stays visibly
      // labeled rather than reading as agreement.
      expect(body.mechanisms[0]!.claims[0]!.attestations.map((a) => a.attestor)).toEqual([
        'context',
        'other',
      ]);
      expect(body.sync_headline).toEqual({ total: 2, confirmed: 0, single_source: 0 });
    });

    it('clamps a HISTORICAL ask on an unentitled pair — 200, latest × latest, never 404', async () => {
      await seedStampedPair([{ source: 'aeci', asserted: true, introducedVersion: P9 }], {
        entitled: false,
      });

      const res = await get(HISTORICAL);
      expect(res.status).toBe(200);
      const diff = ProductPairResponseSchema.parse(await res.json()).version_diff!;
      expect(diff.diff_access).toBe('latest_only');
      expect(diff.selected).toEqual({ context: '2026.10', other: 'v5' });
      expect(diff.is_default).toBe(true);
      // The withheld depth: no previous pair, so no claim carries a marker and the
      // change summary is empty.
      expect(diff.previous).toBeNull();
      expect(diff.counts).toEqual({ added: 0, removed: 0 });
    });

    it('honours the same ask when ONE endpoint vendor is entitled', async () => {
      // Acme (Procore) is verified; Globex (Revit) is not. Either side opens it.
      await seedStampedPair([{ source: 'aeci', asserted: true, introducedVersion: P9 }]);

      const diff = ProductPairResponseSchema.parse(
        await (await get(HISTORICAL)).json(),
      ).version_diff!;
      expect(diff.diff_access).toBe('full');
      expect(diff.selected.context).toBe('2026.1');
      expect(diff.is_default).toBe(false);
    });

    it('gives every reader of the same URL the same answer — the gate is URL-derived', async () => {
      // What keeps a gated pair page storable in the shared, URL-keyed edge cache
      // (`STAGE_1_SPEC.md` §9.1a): no cookie, no session, no viewer axis.
      await seedStampedPair([{ source: 'aeci', asserted: true, introducedVersion: P9 }], {
        entitled: false,
      });

      const anonymous = await (await get(HISTORICAL)).json();
      const authenticated = await (
        await app().request(
          HISTORICAL,
          { headers: { authorization: 'Bearer whoever', cookie: 'sb-access-token=whatever' } },
          TEST_ENV,
          fakeExecutionContext(),
        )
      ).json();
      expect(authenticated).toEqual(anonymous);
    });
  });
});
