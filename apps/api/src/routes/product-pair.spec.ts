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

async function seedVendors() {
  await t.db.insert(vendors).values([
    { id: ACME, companyName: 'Acme Software', slug: 'acme-software' },
    { id: GLOBEX, companyName: 'Globex', slug: 'globex' },
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
