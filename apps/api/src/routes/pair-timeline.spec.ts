/**
 * GET /api/products/:slug/integrations/:otherSlug/timeline — the per-claim
 * attestation HISTORY (AECI-303 / §9.1), against the in-memory D1 harness.
 *
 * The one thing this endpoint does that nothing else in the read surface does:
 * **it returns retracted rows.** §2.1's supersession is retract-then-insert, so the
 * append-only history IS the retracted rows plus the live one. Every other read
 * filters them (`liveAttestationsWhere`), so the first test below is the whole
 * reason the route exists — and the reason its read config is separate.
 */

import { PairTimelineResponseSchema } from '@aeci/shared';
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
import { createPairTimelineHandler } from './integrations';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const app = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/products/:slug/integrations/:otherSlug/timeline',
    handler: createPairTimelineHandler(t.factory),
  });
const get = (url: string) => app().request(url, {}, TEST_ENV, fakeExecutionContext());

const ACME = u(901);
const GLOBEX = u(902);
const P1 = u(700);
const P9 = u(701);

/**
 * The whole timeline read IS history, so §9.3's gate applies unconditionally — and
 * AECI-304 put that gate on the PAIR'S vendors. `verified` is the mirror of an
 * `active` entitlement row, so the default seed makes Procore's vendor entitled and
 * the history open; `seedPair({ entitled: false })` is the gated fixture.
 */
async function seedPair({ entitled = true }: { entitled?: boolean } = {}) {
  await t.db.insert(products).values([
    { id: u(1), slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
    { id: u(2), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(vendors).values([
    { id: ACME, companyName: 'Acme Software', slug: 'acme-software', verified: entitled },
    { id: GLOBEX, companyName: 'Globex', slug: 'globex', verified: false },
  ]);
  await t.db.insert(productVendors).values([
    { productId: u(1), vendorId: ACME, isPrimary: true },
    { productId: u(2), vendorId: GLOBEX, isPrimary: true },
  ]);
  await t.db.insert(productVersions).values([
    { id: P1, productId: u(1), label: '2026.1', sortKey: 20_260_000_100_000 },
    { id: P9, productId: u(1), label: '2026.9', sortKey: 20_260_000_900_000 },
  ]);
  // Endpoint A = Procore, so `vendor_a` is Procore's slot.
  await t.db.insert(integrations).values({
    id: u(10),
    sourceProductId: u(1),
    targetProductId: u(2),
    mechanismKind: 'native',
    direction: 'one-way',
  });
  await t.db.insert(taxonomyDataObjects).values({ id: u(20), slug: 'rfis', name: 'RFIs' });
  await t.db.insert(claims).values({
    id: u(30),
    integrationId: u(10),
    dataObjectId: u(20),
    direction: 'a_to_b',
  });
}

interface SeedRow {
  id: string;
  source: string;
  asserted?: boolean;
  note?: string | null;
  by?: string;
  retractedAt?: string | null;
  createdAt: string;
  introducedVersion?: string;
  deprecatedVersion?: string;
}

async function attestation(row: SeedRow) {
  await t.db.insert(attestations).values({
    id: row.id,
    claimId: u(30),
    source: row.source,
    asserted: row.asserted ?? true,
    note: row.note ?? null,
    attestedByVendorId: row.by ?? null,
    retractedAt: row.retractedAt ?? null,
    createdAt: row.createdAt,
    introducedVersionId: row.introducedVersion ?? null,
    deprecatedVersionId: row.deprecatedVersion ?? null,
  });
}

describe('GET …/integrations/:otherSlug/timeline', () => {
  it('RETURNS retracted rows — the reason this read exists', async () => {
    await seedPair();
    // Retract-then-insert: the superseded row keeps its id and gains retracted_at.
    await attestation({
      id: u(40),
      source: 'vendor_a',
      by: ACME,
      note: 'First position.',
      createdAt: '2026-01-01T00:00:00.000Z',
      retractedAt: '2026-03-01T00:00:00.000Z',
    });
    await attestation({
      id: u(41),
      source: 'vendor_a',
      by: ACME,
      note: 'Revised.',
      createdAt: '2026-03-01T00:00:00.000Z',
    });

    const res = await get('/api/products/procore/integrations/revit/timeline');
    expect(res.status).toBe(200);
    const body = PairTimelineResponseSchema.parse(await res.json());
    const entries = body.claims.find((c) => c.claim_id === u(30))!.entries;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.retracted_at).toBe('2026-03-01T00:00:00.000Z');
    expect(entries[1]!.retracted_at).toBeNull();
  });

  it('orders entries oldest-first by created_at, whatever the insert order', async () => {
    await seedPair();
    // Inserted newest-first, so a naive pass-through of D1 row order would fail.
    // Note the earlier row must be retracted: `attestations_slot_key` is
    // `unique(claim_id, source) WHERE retracted_at IS NULL`, so only ONE live row
    // may hold a slot — which is exactly the shape retract-then-insert produces.
    await attestation({
      id: u(41),
      source: 'aeci',
      note: 'b',
      createdAt: '2026-05-01T00:00:00.000Z',
    });
    await attestation({
      id: u(40),
      source: 'aeci',
      note: 'a',
      createdAt: '2026-01-01T00:00:00.000Z',
      retractedAt: '2026-05-01T00:00:00.000Z',
    });

    const res = await get('/api/products/procore/integrations/revit/timeline');
    const body = PairTimelineResponseSchema.parse(await res.json());
    expect(body.claims[0]!.entries.map((e) => e.note)).toEqual(['a', 'b']);
  });

  it('resolves version stamps to labels', async () => {
    await seedPair();
    await attestation({
      id: u(40),
      source: 'vendor_a',
      by: ACME,
      createdAt: '2026-01-01T00:00:00.000Z',
      introducedVersion: P1,
      deprecatedVersion: P9,
    });

    const res = await get('/api/products/procore/integrations/revit/timeline');
    const body = PairTimelineResponseSchema.parse(await res.json());
    const entry = body.claims[0]!.entries[0]!;
    expect(entry.introduced_version).toBe('2026.1');
    expect(entry.deprecated_version).toBe('2026.9');
  });

  it('omits the version keys entirely for an unstamped row', async () => {
    await seedPair();
    await attestation({ id: u(40), source: 'aeci', createdAt: '2026-01-01T00:00:00.000Z' });

    const res = await get('/api/products/procore/integrations/revit/timeline');
    const raw = (await res.json()) as {
      claims: { entries: Record<string, unknown>[] }[];
    };
    expect(raw.claims[0]!.entries[0]).not.toHaveProperty('introduced_version');
    expect(raw.claims[0]!.entries[0]).not.toHaveProperty('deprecated_version');
  });

  it('frames the attestor context-relatively, and flips with the orientation', async () => {
    await seedPair();
    // `vendor_a` is Procore's slot (Procore is endpoint A).
    await attestation({
      id: u(40),
      source: 'vendor_a',
      by: ACME,
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const fromProcore = PairTimelineResponseSchema.parse(
      await (await get('/api/products/procore/integrations/revit/timeline')).json(),
    );
    expect(fromProcore.claims[0]!.entries[0]!.attestor).toBe('context');

    const fromRevit = PairTimelineResponseSchema.parse(
      await (await get('/api/products/revit/integrations/procore/timeline')).json(),
    );
    expect(fromRevit.claims[0]!.entries[0]!.attestor).toBe('other');
  });

  it('omits a claim with no attestations at all', async () => {
    await seedPair(); // the claim exists, but nobody has attested

    const res = await get('/api/products/procore/integrations/revit/timeline');
    const body = PairTimelineResponseSchema.parse(await res.json());
    // The browser's "does this claim have a history affordance?" test is the
    // absence of an entry for its id, so an empty history must not appear.
    expect(body.claims).toEqual([]);
  });

  it('is open when ONE of the pair’s vendors is entitled — either side pays (AECI-304)', async () => {
    // Globex (Revit) is unverified; Acme (Procore) is not. Either side opens it.
    await seedPair();
    await attestation({ id: u(40), source: 'aeci', createdAt: '2026-01-01T00:00:00.000Z' });

    const res = await get('/api/products/procore/integrations/revit/timeline');
    const body = PairTimelineResponseSchema.parse(await res.json());
    expect(body.diff_access).toBe('full');
    expect(body.claims).toHaveLength(1);
  });

  it('is gated when NEITHER pair vendor is entitled — empty history, 200, never 403', async () => {
    await seedPair({ entitled: false });
    await attestation({ id: u(40), source: 'aeci', createdAt: '2026-01-01T00:00:00.000Z' });

    const res = await get('/api/products/procore/integrations/revit/timeline');
    // A 403 would make the gate a control-flow branch (`STAGE_2_SPEC.md` §2.2) and
    // the SSR resolver renders a non-200 as the NotFound shell — costing the reader
    // the FREE latest view and inverting §8.1(4).
    expect(res.status).toBe(200);
    const body = PairTimelineResponseSchema.parse(await res.json());
    expect(body.diff_access).toBe('latest_only');
    expect(body.claims).toEqual([]);
  });

  it('gates on the PAIR, never on the reader — no auth header changes the answer', async () => {
    await seedPair({ entitled: false });
    await attestation({ id: u(40), source: 'aeci', createdAt: '2026-01-01T00:00:00.000Z' });

    // Same URL, an "authenticated" caller: identical answer. The gate is a function
    // of the two slugs, which is what keeps the pair page edge-cacheable.
    const res = await app().request(
      '/api/products/procore/integrations/revit/timeline',
      { headers: { authorization: 'Bearer whoever', cookie: 'sb-access-token=whatever' } },
      TEST_ENV,
      fakeExecutionContext(),
    );
    const body = PairTimelineResponseSchema.parse(await res.json());
    expect(body.diff_access).toBe('latest_only');
  });

  it('404s on an unknown slug and on two equal slugs, mirroring the pair read', async () => {
    await seedPair();

    expect((await get('/api/products/procore/integrations/nope/timeline')).status).toBe(404);
    expect((await get('/api/products/nope/integrations/revit/timeline')).status).toBe(404);
    // Equal slugs never yield a pair, and this answers without touching the DB.
    expect((await get('/api/products/procore/integrations/procore/timeline')).status).toBe(404);
  });

  it('returns an empty list for a valid-but-unconnected pair', async () => {
    await t.db.insert(products).values([
      { id: u(1), slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
      { id: u(2), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
    ]);

    const res = await get('/api/products/procore/integrations/revit/timeline');
    expect(res.status).toBe(200);
    const body = PairTimelineResponseSchema.parse(await res.json());
    expect(body.claims).toEqual([]);
  });

  it('covers every mechanism on the pair, in either orientation', async () => {
    await seedPair();
    // A second mechanism with the endpoints reversed — the pair read matches both
    // orientations, and so must its history.
    await t.db.insert(integrations).values({
      id: u(11),
      sourceProductId: u(2),
      targetProductId: u(1),
      mechanismKind: 'native',
      direction: 'one-way',
    });
    await t.db.insert(claims).values({
      id: u(31),
      integrationId: u(11),
      dataObjectId: u(20),
      direction: 'a_to_b',
    });
    await attestation({ id: u(40), source: 'aeci', createdAt: '2026-01-01T00:00:00.000Z' });
    await t.db.insert(attestations).values({
      id: u(41),
      claimId: u(31),
      source: 'vendor_a',
      asserted: true,
      attestedByVendorId: GLOBEX,
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const res = await get('/api/products/procore/integrations/revit/timeline');
    const body = PairTimelineResponseSchema.parse(await res.json());
    expect(body.claims.map((c) => c.claim_id).sort()).toEqual([u(30), u(31)]);
    // On the reversed mechanism, Revit is endpoint A — so `vendor_a` there is the
    // OTHER product relative to a Procore-context page.
    expect(body.claims.find((c) => c.claim_id === u(31))!.entries[0]!.attestor).toBe('other');
  });
});
