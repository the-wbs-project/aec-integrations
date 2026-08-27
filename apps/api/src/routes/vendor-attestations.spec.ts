/**
 * Vendor attestation authoring handler coverage (AECI-301 /
 * `STAGE_2_ATTESTATIONS_SPEC.md` §5).
 *
 * Per the repo split, this spec stubs `c.set('auth', …)` and exercises the
 * HANDLERS; the real `requireVendor()` guard and the full deny matrix live in
 * `vendor.authz-matrix.spec.ts`.
 *
 * The harness runs the REAL migration files against in-memory SQLite with
 * `foreign_keys = ON` and shims `db.batch` onto a real transaction, so three
 * things below are genuinely exercised rather than mocked: the
 * `attestations_slot_key` partial unique index (retract-then-insert), the
 * atomicity of the audit-in-batch invariant, and `computeAgreement` over rows
 * that really are in the database.
 *
 * The load-bearing cases:
 *   - authority → 404 before verified → 403, and a 404 that cannot be told apart
 *     from "no such claim";
 *   - retract-then-insert never trips the partial unique index, however many
 *     times it runs;
 *   - a vendor owning BOTH endpoints writes both slots and still reads
 *     `single_source` — one company is one voter (§4.2);
 *   - direction round-trips through the caller's frame;
 *   - `data_object` is find-only, and version stamps stay inside the caller's own
 *     endpoint (§8.2).
 */

import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attestations,
  auditLog,
  claims,
  integrations,
  productVendors,
  productVersions,
  products,
  profiles,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  createListVendorIntegrationsHandler,
  createRetractVendorAttestationHandler,
  createUpsertVendorAttestationHandler,
  createVendorClaimHandler,
} from './vendor-attestations';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Vendors. A owns the SOURCE product, B the TARGET, BOTH owns both endpoints of
// its own intra-portfolio integration, UNVERIFIED is claimed but not yet Verified.
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_BOTH = uuid(3);
const VENDOR_UNVERIFIED = uuid(4);

const P_SOURCE = uuid(10);
const P_TARGET = uuid(11);
const P_OWN_A = uuid(12);
const P_OWN_B = uuid(13);
const P_UNVERIFIED = uuid(14);
const P_FOREIGN = uuid(15);

const I_MAIN = uuid(20); // P_SOURCE (A) ↔ P_TARGET (B)
const I_INTRA = uuid(21); // P_OWN_A ↔ P_OWN_B, both VENDOR_BOTH
const I_FOREIGN = uuid(22); // P_FOREIGN ↔ P_UNVERIFIED — VENDOR_A owns neither
const I_UNVERIFIED = uuid(23); // P_UNVERIFIED ↔ P_TARGET

const DO_RFIS = uuid(30);
const DO_SUBMITTALS = uuid(31);

const C_MAIN = uuid(40); // an AECi-seeded claim on I_MAIN
const C_INTRA = uuid(41); // an AECi-seeded claim on I_INTRA

const V_SOURCE = uuid(50); // a product_versions row on P_SOURCE
const V_TARGET = uuid(51); // …and one on P_TARGET

const SEAT_A = uuid(100);
const SEAT_B = uuid(101);
const SEAT_BOTH = uuid(102);
const SEAT_UNVERIFIED = uuid(103);

const seat = (userId: string, vendorId: string): AuthzVariables['auth'] => ({
  userId,
  email: `${userId}@example.test`,
  role: 'vendor_admin',
  vendorId,
  entitlementTier: 'verified',
  entitlement: { status: 'active', periodEnd: null },
});

const AUTH_A = seat(SEAT_A, VENDOR_A);
const AUTH_B = seat(SEAT_B, VENDOR_B);
const AUTH_BOTH = seat(SEAT_BOTH, VENDOR_BOTH);
const AUTH_UNVERIFIED = seat(SEAT_UNVERIFIED, VENDOR_UNVERIFIED);

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();

  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk', verified: true },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley', verified: true },
    { id: VENDOR_BOTH, slug: 'procore', companyName: 'Procore', verified: true },
    { id: VENDOR_UNVERIFIED, slug: 'trimble', companyName: 'Trimble', verified: false },
  ]);
  await t.db.insert(products).values([
    { id: P_SOURCE, slug: 'revit', name: 'Revit' },
    { id: P_TARGET, slug: 'microstation', name: 'MicroStation' },
    { id: P_OWN_A, slug: 'procore-core', name: 'Procore Core' },
    { id: P_OWN_B, slug: 'procore-field', name: 'Procore Field' },
    { id: P_UNVERIFIED, slug: 'tekla', name: 'Tekla' },
    { id: P_FOREIGN, slug: 'archicad', name: 'ArchiCAD' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_SOURCE, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_TARGET, vendorId: VENDOR_B, isPrimary: true },
    { productId: P_OWN_A, vendorId: VENDOR_BOTH, isPrimary: true },
    { productId: P_OWN_B, vendorId: VENDOR_BOTH, isPrimary: true },
    { productId: P_UNVERIFIED, vendorId: VENDOR_UNVERIFIED, isPrimary: true },
  ]);
  await t.db.insert(integrations).values([
    { id: I_MAIN, sourceProductId: P_SOURCE, targetProductId: P_TARGET, mechanismKind: 'native' },
    { id: I_INTRA, sourceProductId: P_OWN_A, targetProductId: P_OWN_B },
    { id: I_FOREIGN, sourceProductId: P_FOREIGN, targetProductId: P_UNVERIFIED },
    { id: I_UNVERIFIED, sourceProductId: P_UNVERIFIED, targetProductId: P_TARGET },
  ]);
  await t.db.insert(taxonomyDataObjects).values([
    { id: DO_RFIS, slug: 'rfis', name: 'RFIs', displayOrder: 1, aliases: ['Requests for Info'] },
    { id: DO_SUBMITTALS, slug: 'submittals', name: 'Submittals', displayOrder: 2 },
  ]);
  await t.db.insert(claims).values([
    { id: C_MAIN, integrationId: I_MAIN, dataObjectId: DO_RFIS, direction: 'a_to_b' },
    { id: C_INTRA, integrationId: I_INTRA, dataObjectId: DO_RFIS, direction: 'both' },
  ]);
  // The AECi seed on the main claim — never a voter (§3.4), but it must not be
  // mistaken for the counterparty either.
  await t.db.insert(attestations).values({
    id: uuid(60),
    claimId: C_MAIN,
    source: 'aeci',
    asserted: true,
  });
  await t.db.insert(productVersions).values([
    { id: V_SOURCE, productId: P_SOURCE, label: '2026.1', sortKey: 1 },
    { id: V_TARGET, productId: P_TARGET, label: 'v5', sortKey: 1 },
  ]);
  await t.db.insert(profiles).values([
    { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR_A },
    { id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR_B },
    { id: SEAT_BOTH, role: 'vendor_admin', vendorId: VENDOR_BOTH },
    { id: SEAT_UNVERIFIED, role: 'vendor_admin', vendorId: VENDOR_UNVERIFIED },
  ]);
});
afterEach(() => t.dispose());

/** App with the session stubbed. Route order mirrors `index.ts`. */
function app(auth: AuthzVariables['auth'] = AUTH_A) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.get('/api/vendor/integrations', createListVendorIntegrationsHandler(t.factory));
  a.post('/api/vendor/claims', createVendorClaimHandler(t.factory));
  a.put('/api/vendor/claims/:claimId/attestation', createUpsertVendorAttestationHandler(t.factory));
  a.delete(
    '/api/vendor/claims/:claimId/attestation',
    createRetractVendorAttestationHandler(t.factory),
  );
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

type Call = { status: number; body: JsonBody; send: ReturnType<typeof vi.fn> };

async function call(
  path: string,
  init: RequestInit = {},
  auth: AuthzVariables['auth'] = AUTH_A,
): Promise<Call> {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const res = await app(auth).request(path, init, env, execCtx);
  // Drain waitUntil so the post-commit purge + §26.5 forward have run.
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  const body = res.status === 204 ? {} : await res.json();
  return { status: res.status, body: body as JsonBody, send };
}

const sendJson = (
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
  auth?: AuthzVariables['auth'],
) =>
  call(
    path,
    { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
    auth,
  );

const attestationUrl = (claimId: string) => `/api/vendor/claims/${claimId}/attestation`;
const auditRows = () => t.db.select().from(auditLog);
const claimRows = () => t.db.select().from(claims);
const attestationRows = () => t.db.select().from(attestations);
const liveAttestations = (claimId: string) =>
  t.db
    .select()
    .from(attestations)
    .where(and(eq(attestations.claimId, claimId), isNull(attestations.retractedAt)));

// ─── GET /api/vendor/integrations ────────────────────────────────────────────

describe('GET /api/vendor/integrations', () => {
  it('returns the caller’s attestable surface with the slot that is theirs', async () => {
    const { status, body } = await call('/api/vendor/integrations');
    expect(status).toBe(200);
    expect(body.integrations).toHaveLength(1);
    const [integration] = body.integrations;
    expect(integration.id).toBe(I_MAIN);
    expect(integration.slots).toEqual(['vendor_a']);
    expect(integration.context_product.slug).toBe('revit');
    expect(integration.other_product.slug).toBe('microstation');
    expect(integration.mechanism_kind).toBe('native');
  });

  it('frames the counterparty’s view as the mirror image', async () => {
    const { body } = await call('/api/vendor/integrations', {}, AUTH_B);
    const [integration] = body.integrations;
    expect(integration.slots).toEqual(['vendor_b']);
    expect(integration.context_product.slug).toBe('microstation');
    expect(integration.other_product.slug).toBe('revit');
    // The same stored `a_to_b` claim reads outbound from A and inbound from B.
    expect(integration.claims[0].direction).toBe('inbound');
  });

  it('frames a stored a_to_b claim as outbound for the endpoint-A owner', async () => {
    const { body } = await call('/api/vendor/integrations');
    expect(body.integrations[0].claims[0]).toMatchObject({
      id: C_MAIN,
      data_object_slug: 'rfis',
      direction: 'outbound',
      agreement: 'unverified',
      origin: 'aeci',
      mine: [],
      counterparty: null,
    });
  });

  it('gives a both-endpoints owner both slots', async () => {
    const { body } = await call('/api/vendor/integrations', {}, AUTH_BOTH);
    for (const integration of body.integrations) {
      // `slots` is "what may I write", not "which side am I looking from" — it
      // stays the full owned set on every entry, because a write fills all of them.
      expect(integration.slots).toEqual(['vendor_a', 'vendor_b']);
    }
  });

  // ── AECI-666: one entry per owned endpoint ─────────────────────────────────
  // The portal files integrations under the product they touch, so an integration
  // whose endpoints the caller owns BOTH is listed once under each — the old
  // behaviour pinned it to endpoint A, which left it unrenderable (directions
  // reversed) under the other product's tab.
  it('lists an owns-both integration ONCE PER ENDPOINT, framed each way', async () => {
    const { body } = await call('/api/vendor/integrations', {}, AUTH_BOTH);
    const owned = body.integrations.filter((i: JsonBody) => i.id === I_INTRA);
    expect(owned).toHaveLength(2);

    const contexts = owned.map((i: JsonBody) => i.context_product.slug).sort();
    const others = owned.map((i: JsonBody) => i.other_product.slug).sort();
    // The two entries are mirror images: each one's context is the other's counterpart.
    expect(contexts).toEqual(others);
    // ...and they are genuinely the two DIFFERENT endpoints, not the same one twice.
    expect(new Set(contexts).size).toBe(2);
  });

  it('mirrors claim direction between the two entries of an owns-both integration', async () => {
    // `C_INTRA` is `both`, which reads `both` from either side and so cannot show
    // a mirror. Add a DIRECTIONAL claim — that is the case the old A-pinned frame
    // rendered backwards under one of the two products.
    await t.db.insert(claims).values({
      id: uuid(42),
      integrationId: I_INTRA,
      dataObjectId: DO_SUBMITTALS,
      direction: 'a_to_b',
    });

    const { body } = await call('/api/vendor/integrations', {}, AUTH_BOTH);
    const owned = body.integrations.filter((i: JsonBody) => i.id === I_INTRA);
    expect(owned).toHaveLength(2);

    const directionFor = (entry: JsonBody) =>
      entry.claims.find((cl: JsonBody) => cl.data_object_slug === 'submittals').direction;
    // One stored `a_to_b`, read from both ends: outbound from A, inbound from B.
    expect(owned.map(directionFor).sort()).toEqual(['inbound', 'outbound']);
    // The `both` claim stays `both` from either side — mirroring is not negation.
    const bothFor = (entry: JsonBody) =>
      entry.claims.find((cl: JsonBody) => cl.data_object_slug === 'rfis').direction;
    expect(owned.map(bothFor)).toEqual(['both', 'both']);
  });

  it('shares ONE position across both entries — same agreement, mine, counterparty', async () => {
    const { body } = await call('/api/vendor/integrations', {}, AUTH_BOTH);
    const owned = body.integrations.filter((i: JsonBody) => i.id === I_INTRA);
    expect(owned).toHaveLength(2);

    const [a, b] = owned;
    // §4 dedupes voters by vendor, and a write fills every owned slot, so one
    // company is one voter however many endpoints it owns. Rendering it twice is
    // a view of one fact — the two entries must never disagree about that fact.
    expect(a.claims[0].agreement).toBe(b.claims[0].agreement);
    expect(a.claims[0].mine).toEqual(b.claims[0].mine);
    expect(a.claims[0].counterparty).toEqual(b.claims[0].counterparty);
    expect(a.slots).toEqual(b.slots);
  });

  it('omits integrations the caller touches neither endpoint of', async () => {
    const { body } = await call('/api/vendor/integrations', {}, AUTH_BOTH);
    expect(body.integrations.map((i: JsonBody) => i.id)).not.toContain(I_MAIN);
  });

  it('is NOT verified-gated — an unverified vendor reads its own surface', async () => {
    // Authoring is the gated capability, not reading (§1). 403-ing here would lock
    // a vendor out of data it owns and give the §6 tab nothing to explain.
    const { status, body } = await call('/api/vendor/integrations', {}, AUTH_UNVERIFIED);
    expect(status).toBe(200);
    expect(body.integrations.map((i: JsonBody) => i.id).sort()).toEqual(
      [I_FOREIGN, I_UNVERIFIED].sort(),
    );
  });

  it('returns an empty list, not a 404, for a vendor with no integrations', async () => {
    await t.db.delete(productVendors).where(eq(productVendors.vendorId, VENDOR_A));
    const { status, body } = await call('/api/vendor/integrations');
    expect(status).toBe(200);
    expect(body.integrations).toEqual([]);
  });

  it('surfaces the counterparty’s stance and hides retracted rows', async () => {
    await t.db.insert(attestations).values([
      {
        id: uuid(70),
        claimId: C_MAIN,
        source: 'vendor_b',
        asserted: false,
        note: 'We do not expose RFIs here.',
        attestedByVendorId: VENDOR_B,
      },
      {
        id: uuid(71),
        claimId: C_MAIN,
        source: 'vendor_a',
        asserted: true,
        attestedByVendorId: VENDOR_A,
        retractedAt: '2026-08-01T00:00:00.000Z',
      },
    ]);
    const { body } = await call('/api/vendor/integrations');
    const [claim] = body.integrations[0].claims;
    expect(claim.counterparty).toEqual({
      asserted: false,
      note: 'We do not expose RFIs here.',
    });
    // The caller's own row is retracted, so it neither renders nor votes.
    expect(claim.mine).toEqual([]);
    expect(claim.agreement).toBe('unverified');
  });

  it('never mistakes the AECi seed for the counterparty', async () => {
    // C_MAIN carries an `aeci` attestation from the fixture. AECi never votes
    // (§3.4) and is not a party, so `counterparty` must stay null.
    const { body } = await call('/api/vendor/integrations');
    expect(body.integrations[0].claims[0].counterparty).toBeNull();
  });

  it('orders claims by the vocabulary display order', async () => {
    await t.db.insert(claims).values({
      id: uuid(45),
      integrationId: I_MAIN,
      dataObjectId: DO_SUBMITTALS,
      direction: 'b_to_a',
    });
    const { body } = await call('/api/vendor/integrations');
    expect(body.integrations[0].claims.map((c: JsonBody) => c.data_object_slug)).toEqual([
      'rfis',
      'submittals',
    ]);
  });
});

// ─── POST /api/vendor/claims ─────────────────────────────────────────────────

describe('POST /api/vendor/claims', () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    integration_id: I_MAIN,
    data_object: 'submittals',
    direction: 'outbound',
    ...overrides,
  });

  it('creates a vendor-origin claim and the caller’s affirming attestation', async () => {
    const { status, body: res } = await sendJson('POST', '/api/vendor/claims', body());
    expect(status).toBe(201);
    expect(res.claim).toMatchObject({
      integration_id: I_MAIN,
      data_object_slug: 'submittals',
      data_object_name: 'Submittals',
      direction: 'outbound',
      origin: 'vendor',
      agreement: 'single_source',
      counterparty: null,
    });
    expect(res.claim.mine).toEqual([
      {
        slot: 'vendor_a',
        asserted: true,
        note: null,
        introduced_version_id: null,
        deprecated_version_id: null,
        updated_at: expect.any(String),
      },
    ]);

    const [row] = await t.db.select().from(claims).where(eq(claims.id, res.claim.id));
    expect(row).toMatchObject({
      integrationId: I_MAIN,
      dataObjectId: DO_SUBMITTALS,
      // Stored canonically — the vendor said "outbound" from endpoint A.
      direction: 'a_to_b',
      origin: 'vendor',
      createdByVendorId: VENDOR_A,
    });
  });

  it('stores the caller’s "outbound" as b_to_a when the caller is endpoint B', async () => {
    // The whole point of the boundary translation: the wire word is the same, the
    // stored value is the mirror.
    const { status, body: res } = await sendJson('POST', '/api/vendor/claims', body(), AUTH_B);
    expect(status).toBe(201);
    const [row] = await t.db.select().from(claims).where(eq(claims.id, res.claim.id));
    expect(row?.direction).toBe('b_to_a');
    // …and it reads back in the caller's own frame.
    expect(res.claim.direction).toBe('outbound');
  });

  it('resolves the data object by alias, find-only', async () => {
    const { status, body: res } = await sendJson(
      'POST',
      '/api/vendor/claims',
      body({ data_object: 'Requests for Info', direction: 'both' }),
    );
    expect(status).toBe(201);
    expect(res.claim.data_object_slug).toBe('rfis');
  });

  it('400s on a term outside the frozen vocabulary, naming the field', async () => {
    // An interactive caller is told; promote's batch job lands it in `skipped[]`.
    const { status, body: res } = await sendJson(
      'POST',
      '/api/vendor/claims',
      body({ data_object: 'punch-lists' }),
    );
    expect(status).toBe(400);
    expect(res.error.code).toBe('VALIDATION_FAILED');
    expect(res.error.field).toBe('data_object');
    expect(await claimRows()).toHaveLength(2); // nothing minted, nothing written
  });

  it('400s with the existing claim id when the identity triple already exists', async () => {
    const { status, body: res } = await sendJson(
      'POST',
      '/api/vendor/claims',
      body({ data_object: 'rfis', direction: 'outbound' }),
    );
    expect(status).toBe(400);
    expect(res.error.code).toBe('VALIDATION_FAILED');
    // The id is what lets the UI pivot to `PUT` instead of dead-ending.
    expect(res.error.details).toEqual({ claim_id: C_MAIN });
    expect(await claimRows()).toHaveLength(2);
  });

  it('allows the same data object in a different direction — direction is identity', async () => {
    // `claims_identity_key` is (integration, data_object, direction), so this is a
    // distinct claim, not a duplicate.
    const { status } = await sendJson(
      'POST',
      '/api/vendor/claims',
      body({ data_object: 'rfis', direction: 'inbound' }),
    );
    expect(status).toBe(201);
  });

  it('writes BOTH slots when the caller owns both endpoints, still reading single_source', async () => {
    const { status, body: res } = await sendJson(
      'POST',
      '/api/vendor/claims',
      { integration_id: I_INTRA, data_object: 'submittals', direction: 'outbound' },
      AUTH_BOTH,
    );
    expect(status).toBe(201);
    expect(res.claim.mine.map((a: JsonBody) => a.slot)).toEqual(['vendor_a', 'vendor_b']);
    // One company is one voter (§4.2) — two slots must never read as bilateral.
    expect(res.claim.agreement).toBe('single_source');

    const rows = await liveAttestations(res.claim.id);
    expect(rows.map((r) => r.source).sort()).toEqual(['vendor_a', 'vendor_b']);
    expect(rows.every((r) => r.attestedByVendorId === VENDOR_BOTH)).toBe(true);
  });

  // ── AECI-666: context_product_id decides the frame on the write path ───────
  // Only load-bearing for an owns-both caller: "outbound" means opposite things
  // from the two sides, and the old A-pinned guess stored the REVERSE flow for a
  // vendor authoring from its other product's tab.
  it('stores the direction relative to context_product_id, not always endpoint A', async () => {
    const fromA = await sendJson(
      'POST',
      '/api/vendor/claims',
      {
        integration_id: I_INTRA,
        data_object: 'submittals',
        direction: 'outbound',
        context_product_id: P_OWN_A,
      },
      AUTH_BOTH,
    );
    const fromB = await sendJson(
      'POST',
      '/api/vendor/claims',
      {
        integration_id: I_INTRA,
        data_object: 'rfis',
        direction: 'outbound',
        context_product_id: P_OWN_B,
      },
      AUTH_BOTH,
    );
    expect(fromA.status).toBe(201);
    expect(fromB.status).toBe(201);

    const stored = async (id: string) =>
      (await t.db.select().from(claims).where(eq(claims.id, id)))[0].direction;
    // Same word from the caller, opposite stored flows — which is the whole point.
    expect(await stored(fromA.body.claim.id)).toBe('a_to_b');
    expect(await stored(fromB.body.claim.id)).toBe('b_to_a');
  });

  it('echoes the claim framed against the context product it was authored from', async () => {
    const { body: res } = await sendJson(
      'POST',
      '/api/vendor/claims',
      {
        integration_id: I_INTRA,
        data_object: 'submittals',
        direction: 'outbound',
        context_product_id: P_OWN_B,
      },
      AUTH_BOTH,
    );
    // The client splices this echo into the tab it wrote from, so it has to read
    // the way that tab does — outbound in, outbound back.
    expect(res.claim.direction).toBe('outbound');
  });

  it('defaults to endpoint A when context_product_id is omitted', async () => {
    const { body: res } = await sendJson(
      'POST',
      '/api/vendor/claims',
      { integration_id: I_INTRA, data_object: 'submittals', direction: 'outbound' },
      AUTH_BOTH,
    );
    const [row] = await t.db.select().from(claims).where(eq(claims.id, res.claim.id));
    expect(row.direction).toBe('a_to_b');
  });

  it('400s a context_product_id the caller does not own on this integration', async () => {
    const { status, body: res } = await sendJson(
      'POST',
      '/api/vendor/claims',
      {
        integration_id: I_INTRA,
        data_object: 'submittals',
        direction: 'outbound',
        // A real product, but not an endpoint of I_INTRA — framing against it
        // would invert the stored flow against the vendor's intent.
        context_product_id: P_SOURCE,
      },
      AUTH_BOTH,
    );
    expect(status).toBe(400);
    expect(res.error.code).toBe('VALIDATION_FAILED');
    expect(res.error.field).toBe('context_product_id');
    expect(await auditRows()).toHaveLength(0);
  });

  it('404s — not 403 — for an integration the caller touches neither endpoint of', async () => {
    const { status, body: res } = await sendJson(
      'POST',
      '/api/vendor/claims',
      body({ integration_id: I_FOREIGN }),
    );
    expect(status).toBe(404);
    expect(res.error.code).toBe('NOT_FOUND');
    expect(await auditRows()).toHaveLength(0);
  });

  it('answers a nonexistent integration identically to a foreign one', async () => {
    const foreign = await sendJson(
      'POST',
      '/api/vendor/claims',
      body({ integration_id: I_FOREIGN }),
    );
    const ghost = await sendJson('POST', '/api/vendor/claims', body({ integration_id: uuid(999) }));
    expect(ghost.status).toBe(foreign.status);
    expect(ghost.body.error.code).toBe(foreign.body.error.code);
    expect(ghost.body.error.details.resource).toBe(foreign.body.error.details.resource);
  });

  it('403s an UNVERIFIED owner — and the copy points at verification, not ranking', async () => {
    const { status, body: res } = await sendJson(
      'POST',
      '/api/vendor/claims',
      { integration_id: I_UNVERIFIED, data_object: 'rfis', direction: 'outbound' },
      AUTH_UNVERIFIED,
    );
    expect(status).toBe(403);
    expect(res.error.code).toBe('FORBIDDEN');
    expect(res.error.message).toMatch(/verified/i);
    expect(res.error.message).not.toMatch(/rank|placement|search/i);
    expect(await auditRows()).toHaveLength(0);
  });

  it('404s an unverified NON-owner — ownership is evaluated before verification', async () => {
    const { status, body: res } = await sendJson(
      'POST',
      '/api/vendor/claims',
      body({ integration_id: I_MAIN }),
      AUTH_UNVERIFIED,
    );
    expect(status).toBe(404);
    expect(res.error.code).toBe('NOT_FOUND');
  });

  it('404s a non-owner even when the body is otherwise invalid', async () => {
    // The ordering rule: a 400 naming a bad `data_object` must never win the race
    // and answer a request that should have been a flat 404.
    const { status } = await sendJson(
      'POST',
      '/api/vendor/claims',
      body({ integration_id: I_FOREIGN, data_object: 'punch-lists' }),
    );
    expect(status).toBe(404);
  });

  it('emits claim.created AND attestation.created in the SAME batch', async () => {
    const { body: res } = await sendJson('POST', '/api/vendor/claims', body());
    const rows = await auditRows();
    expect(rows.map((r) => r.action).sort()).toEqual([
      'attestation.created',
      'claim.created',
      // The maintenance-marker flip (AECI-616): a vendor-authored claim makes the
      // integration vendor-maintained, audited in the same batch.
      'integration.updated',
    ]);
    for (const row of rows) {
      expect(row.actorId).toBe(SEAT_A);
      expect(row.actorType).toBe('user');
      expect(row.metadata).toMatchObject({ source: 'vendor-portal', vendorId: VENDOR_A });
    }
    const claimAudit = rows.find((r) => r.action === 'claim.created');
    expect(claimAudit?.entityType).toBe('claim');
    expect(claimAudit?.entityId).toBe(res.claim.id);
    const attestationAudit = rows.find((r) => r.action === 'attestation.created');
    expect(attestationAudit?.entityType).toBe('attestation');
    expect(attestationAudit?.metadata).toMatchObject({ slot: 'vendor_a' });
  });

  it('emits one attestation.created per slot for a both-endpoints owner', async () => {
    await sendJson(
      'POST',
      '/api/vendor/claims',
      { integration_id: I_INTRA, data_object: 'submittals', direction: 'outbound' },
      AUTH_BOTH,
    );
    const created = (await auditRows()).filter((r) => r.action === 'attestation.created');
    expect(created).toHaveLength(2);
    expect(created.map((r) => (r.metadata as { slot: string }).slot).sort()).toEqual([
      'vendor_a',
      'vendor_b',
    ]);
  });

  it('rolls the WHOLE write back when the audit row cannot be written (§26.1)', async () => {
    // `audit_log.actor_id` FKs `profiles.id`, so a session whose seat was deleted
    // mid-request makes `auditInsert` throw INSIDE the batch. That is the point of
    // the batch: the claim and its attestation die with the audit row. Without it
    // this would silently commit an unaudited vendor assertion.
    const ghost = { ...AUTH_A, userId: uuid(998) };
    const { status } = await sendJson('POST', '/api/vendor/claims', body(), ghost);
    expect(status).toBe(500);
    expect(await claimRows()).toHaveLength(2);
    expect(await attestationRows()).toHaveLength(1); // only the fixture's aeci seed
    expect(await auditRows()).toHaveLength(0);
  });

  it('enqueues the pair tag and both product tags, with source: vendor', async () => {
    const { send } = await sendJson('POST', '/api/vendor/claims', body());
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0] as { tags: string[]; source: string };
    expect(message.source).toBe('vendor');
    // The SAME `pair:{min}__{max}` the pair page emits — keep them in lockstep.
    expect(message.tags.sort()).toEqual([
      'pair:microstation__revit',
      'product:microstation',
      'product:revit',
    ]);
  });

  it('stamps a version on the slot whose endpoint owns it, and 400s on the other side’s', async () => {
    const ok = await sendJson(
      'POST',
      '/api/vendor/claims',
      body({ introduced_version_id: V_SOURCE }),
    );
    expect(ok.status).toBe(201);
    expect(ok.body.claim.mine[0].introduced_version_id).toBe(V_SOURCE);

    // V_TARGET belongs to the counterparty's product — §8.2 keeps versioning
    // inside the attesting side's own authority boundary.
    const bad = await sendJson(
      'POST',
      '/api/vendor/claims',
      body({ data_object: 'rfis', direction: 'inbound', introduced_version_id: V_TARGET }),
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error.field).toBe('introduced_version_id');
  });

  it('answers an unknown version id the same way as a counterparty-owned one', async () => {
    const { status, body: res } = await sendJson(
      'POST',
      '/api/vendor/claims',
      body({ introduced_version_id: uuid(997) }),
    );
    expect(status).toBe(400);
    expect(res.error.field).toBe('introduced_version_id');
  });

  it('400s a malformed body without touching the database', async () => {
    const { status } = await sendJson('POST', '/api/vendor/claims', { integration_id: I_MAIN });
    expect(status).toBe(400);
    expect(await auditRows()).toHaveLength(0);
  });
});

// ─── PUT /api/vendor/claims/:claimId/attestation ─────────────────────────────

describe('PUT /api/vendor/claims/:claimId/attestation', () => {
  it('fills the caller’s empty slot and moves the claim to single_source', async () => {
    const { status, body } = await sendJson('PUT', attestationUrl(C_MAIN), {
      asserted: true,
      note: 'Confirmed for 2026.1 onward.',
    });
    expect(status).toBe(200);
    expect(body.claim.agreement).toBe('single_source');
    expect(body.claim.mine).toEqual([
      {
        slot: 'vendor_a',
        asserted: true,
        note: 'Confirmed for 2026.1 onward.',
        introduced_version_id: null,
        deprecated_version_id: null,
        updated_at: expect.any(String),
      },
    ]);

    const live = await liveAttestations(C_MAIN);
    expect(live.map((r) => r.source).sort()).toEqual(['aeci', 'vendor_a']);
  });

  it('reaches `confirmed` only with two DISTINCT vendors affirming', async () => {
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true });
    const { body } = await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true }, AUTH_B);
    expect(body.claim.agreement).toBe('confirmed');
    // …and the counterparty is visible from B's side, framed as A's position.
    expect(body.claim.counterparty).toEqual({ asserted: true, note: null });
  });

  it('reads `conflict` when the two vendors disagree', async () => {
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true });
    const { body } = await sendJson('PUT', attestationUrl(C_MAIN), { asserted: false }, AUTH_B);
    expect(body.claim.agreement).toBe('conflict');
  });

  it('retract-then-insert never trips attestations_slot_key, however often it runs', async () => {
    // The index is `unique(claim_id, source) WHERE retracted_at IS NULL`. If the
    // insert ever preceded the retract inside the batch, this would blow up on the
    // second call — and take the whole batch with it.
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true });
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: false });
    const { status, body } = await sendJson('PUT', attestationUrl(C_MAIN), {
      asserted: true,
      note: 'third',
    });
    expect(status).toBe(200);
    expect(body.claim.mine[0].note).toBe('third');

    const live = await liveAttestations(C_MAIN);
    expect(live.filter((r) => r.source === 'vendor_a')).toHaveLength(1);
    // The superseded rows survive — §9's timeline reads the append-only history.
    const all = (await attestationRows()).filter((r) => r.source === 'vendor_a');
    expect(all).toHaveLength(3);
    expect(all.filter((r) => r.retractedAt !== null)).toHaveLength(2);
  });

  it('replaces rather than patches — an omitted note clears it', async () => {
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true, note: 'first' });
    const { body } = await sendJson('PUT', attestationUrl(C_MAIN), { asserted: false });
    expect(body.claim.mine[0].note).toBeNull();
  });

  it('writes both slots for a both-endpoints owner and still reads single_source', async () => {
    const { body } = await sendJson('PUT', attestationUrl(C_INTRA), { asserted: true }, AUTH_BOTH);
    expect(body.claim.mine.map((a: JsonBody) => a.slot)).toEqual(['vendor_a', 'vendor_b']);
    expect(body.claim.agreement).toBe('single_source');
    expect(body.claim.counterparty).toBeNull();
  });

  it('clears a stale row in a slot the caller owns, whoever wrote it', async () => {
    // Two accounts on DIFFERENT vendors can co-own one product (§2.1). The partial
    // unique index makes that last-write-wins, so the incoming write has to retract
    // whatever holds the slot or the insert collides.
    await t.db.insert(attestations).values({
      id: uuid(80),
      claimId: C_MAIN,
      source: 'vendor_a',
      asserted: false,
      attestedByVendorId: VENDOR_B,
    });
    const { status } = await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true });
    expect(status).toBe(200);
    const live = await liveAttestations(C_MAIN);
    const slotA = live.filter((r) => r.source === 'vendor_a');
    expect(slotA).toHaveLength(1);
    expect(slotA[0]?.attestedByVendorId).toBe(VENDOR_A);
  });

  it('emits attestation.retracted + attestation.created when superseding', async () => {
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true });
    const before = (await auditRows()).length;
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: false });
    const added = (await auditRows()).slice(before);
    expect(added.map((r) => r.action).sort()).toEqual([
      'attestation.created',
      'attestation.retracted',
      // The maintenance-marker flip (AECI-616) rides in the same batch: re-attesting
      // re-stamps `integrations.last_reviewed_at`, which is a real state change.
      'integration.updated',
    ]);
    expect(added.every((r) => (r.metadata as { source: string }).source === 'vendor-portal')).toBe(
      true,
    );
  });

  it('404s on a claim whose integration the caller does not touch', async () => {
    await t.db.insert(claims).values({
      id: uuid(46),
      integrationId: I_FOREIGN,
      dataObjectId: DO_RFIS,
      direction: 'a_to_b',
    });
    const { status, body } = await sendJson('PUT', attestationUrl(uuid(46)), { asserted: true });
    expect(status).toBe(404);
    expect(body.error.details.resource).toBe('claim');
  });

  it('answers a nonexistent claim IDENTICALLY to another vendor’s claim', async () => {
    // Distinguishable 404s would turn the endpoint into an existence oracle a
    // vendor could walk.
    await t.db.insert(claims).values({
      id: uuid(47),
      integrationId: I_FOREIGN,
      dataObjectId: DO_RFIS,
      direction: 'a_to_b',
    });
    const foreign = await sendJson('PUT', attestationUrl(uuid(47)), { asserted: true });
    const ghost = await sendJson('PUT', attestationUrl(uuid(996)), { asserted: true });
    expect(ghost.status).toBe(foreign.status);
    expect(ghost.body.error.code).toBe(foreign.body.error.code);
    expect(ghost.body.error.details.resource).toBe(foreign.body.error.details.resource);
    expect(Object.keys(ghost.body.error).sort()).toEqual(Object.keys(foreign.body.error).sort());
  });

  it('403s an unverified owner and writes nothing', async () => {
    await t.db.insert(claims).values({
      id: uuid(48),
      integrationId: I_UNVERIFIED,
      dataObjectId: DO_RFIS,
      direction: 'a_to_b',
    });
    const { status } = await sendJson(
      'PUT',
      attestationUrl(uuid(48)),
      { asserted: true },
      AUTH_UNVERIFIED,
    );
    expect(status).toBe(403);
    expect(await auditRows()).toHaveLength(0);
  });

  it('rejects a body with no stance', async () => {
    const { status } = await sendJson('PUT', attestationUrl(C_MAIN), { note: 'hmm' });
    expect(status).toBe(400);
  });

  it('enqueues the same tag set as a create', async () => {
    const { send } = await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true });
    const message = send.mock.calls[0][0] as { tags: string[]; source: string };
    expect(message.tags.sort()).toEqual([
      'pair:microstation__revit',
      'product:microstation',
      'product:revit',
    ]);
  });
});

// ─── DELETE /api/vendor/claims/:claimId/attestation ──────────────────────────

describe('DELETE /api/vendor/claims/:claimId/attestation', () => {
  it('retracts the caller’s attestation, keeping the row for the timeline', async () => {
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true });
    const { status } = await call(attestationUrl(C_MAIN), { method: 'DELETE' });
    expect(status).toBe(204);

    const live = await liveAttestations(C_MAIN);
    expect(live.map((r) => r.source)).toEqual(['aeci']);
    // Retracted, not deleted — §9's version-diff timeline reads the history.
    const all = (await attestationRows()).filter((r) => r.source === 'vendor_a');
    expect(all).toHaveLength(1);
    expect(all[0]?.retractedAt).toEqual(expect.any(String));
  });

  it('returns the claim to unverified once the only voter withdraws', async () => {
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true });
    await call(attestationUrl(C_MAIN), { method: 'DELETE' });
    const { body } = await call('/api/vendor/integrations');
    expect(body.integrations[0].claims[0].agreement).toBe('unverified');
    expect(body.integrations[0].claims[0].mine).toEqual([]);
  });

  it('clears BOTH slots for a both-endpoints owner', async () => {
    await sendJson('PUT', attestationUrl(C_INTRA), { asserted: true }, AUTH_BOTH);
    const { status } = await call(attestationUrl(C_INTRA), { method: 'DELETE' }, AUTH_BOTH);
    expect(status).toBe(204);
    expect(await liveAttestations(C_INTRA)).toEqual([]);
  });

  it('404s when there is nothing of the caller’s to retract', async () => {
    // Not an idempotent 204: §26.1 wants no audit row without a state change, and
    // a 204 would claim one happened.
    const { status, body } = await call(attestationUrl(C_MAIN), { method: 'DELETE' });
    expect(status).toBe(404);
    expect(body.error.details.resource).toBe('attestation');
    expect(await auditRows()).toHaveLength(0);
  });

  it('never retracts the counterparty’s attestation', async () => {
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true });
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true }, AUTH_B);
    await call(attestationUrl(C_MAIN), { method: 'DELETE' });

    const live = await liveAttestations(C_MAIN);
    expect(live.map((r) => r.source).sort()).toEqual(['aeci', 'vendor_b']);
  });

  it('emits attestation.retracted in the same batch, carrying the withdrawn state', async () => {
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true, note: 'was true' });
    const before = (await auditRows()).length;
    await call(attestationUrl(C_MAIN), { method: 'DELETE' });

    const [row] = (await auditRows()).slice(before);
    expect(row?.action).toBe('attestation.retracted');
    expect(row?.entityType).toBe('attestation');
    expect(row?.beforeState).toMatchObject({ asserted: true, note: 'was true' });
    expect(row?.metadata).toMatchObject({
      source: 'vendor-portal',
      vendorId: VENDOR_A,
      claimId: C_MAIN,
      slot: 'vendor_a',
    });
  });

  it('rolls back when the audit row cannot be written', async () => {
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true });
    const ghost = { ...AUTH_A, userId: uuid(998) };
    const { status } = await call(attestationUrl(C_MAIN), { method: 'DELETE' }, ghost);
    expect(status).toBe(500);
    // The attestation is still live — the retraction died with its audit row.
    expect((await liveAttestations(C_MAIN)).map((r) => r.source).sort()).toEqual([
      'aeci',
      'vendor_a',
    ]);
  });

  it('403s an unverified owner', async () => {
    await t.db.insert(claims).values({
      id: uuid(49),
      integrationId: I_UNVERIFIED,
      dataObjectId: DO_RFIS,
      direction: 'a_to_b',
    });
    await t.db.insert(attestations).values({
      id: uuid(90),
      claimId: uuid(49),
      source: 'vendor_a',
      asserted: true,
      attestedByVendorId: VENDOR_UNVERIFIED,
    });
    const { status } = await call(attestationUrl(uuid(49)), { method: 'DELETE' }, AUTH_UNVERIFIED);
    expect(status).toBe(403);
    expect(await liveAttestations(uuid(49))).toHaveLength(1);
  });
});

// ─── The maintenance marker's vendor branch (AECI-616 / §13) ─────────────────
//
// `integrations.maintained_by` is what flips the pair-page header from
// "Maintained by AEC Integrations." to "Vendor-maintained. Updated <date>." This
// surface is its only writer of `'vendor'`.

describe('maintenance marker — integrations.maintained_by (AECI-616)', () => {
  const integrationRow = (id = I_MAIN) =>
    t.db
      .select()
      .from(integrations)
      .where(eq(integrations.id, id))
      .then((rows) => rows[0]);

  it('starts AECi-maintained with no review date', async () => {
    const row = await integrationRow();
    expect(row?.maintainedBy).toBe('aeci');
    expect(row?.lastReviewedAt).toBeNull();
  });

  it('flips to vendor-maintained and stamps the date when a vendor attests', async () => {
    const before = new Date().toISOString();
    const { status } = await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true });
    expect(status).toBe(200);

    const row = await integrationRow();
    expect(row?.maintainedBy).toBe('vendor');
    expect(String(row?.lastReviewedAt) >= before).toBe(true);
  });

  it('flips when a vendor CREATES a claim, not just when it attests to one', async () => {
    const { status } = await sendJson('POST', '/api/vendor/claims', {
      integration_id: I_MAIN,
      data_object: 'submittals',
      direction: 'outbound',
    });
    expect(status).toBe(201);

    const row = await integrationRow();
    expect(row?.maintainedBy).toBe('vendor');
    expect(row?.lastReviewedAt).toEqual(expect.any(String));
  });

  it('re-attesting advances the date — a re-assertion IS a review', async () => {
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true });
    const first = (await integrationRow())?.lastReviewedAt;

    await new Promise((r) => setTimeout(r, 5));
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: false, note: 'actually no' });
    const second = (await integrationRow())?.lastReviewedAt;

    expect(String(second) > String(first)).toBe(true);
  });

  it('hands the record back to AECi when the LAST live vendor attestation is retracted', async () => {
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true });
    const reviewed = (await integrationRow())?.lastReviewedAt;
    expect(reviewed).toEqual(expect.any(String));

    const { status } = await call(attestationUrl(C_MAIN), { method: 'DELETE' });
    expect(status).toBe(204);

    const row = await integrationRow();
    expect(row?.maintainedBy).toBe('aeci');
    // The date SURVIVES. Withdrawing an assertion does not un-happen the review, and
    // blanking it would make a record that HAS been checked read as one that never was.
    expect(row?.lastReviewedAt).toBe(reviewed);
  });

  it('stays vendor-maintained while another live vendor attestation remains on the SAME integration', async () => {
    // A second claim on I_MAIN. The retract path is claim-scoped; the marker is
    // integration-scoped — losing one claim's attestation must not un-vendor an
    // integration the vendor still speaks for elsewhere.
    const C_SECOND = uuid(42);
    await t.db.insert(claims).values({
      id: C_SECOND,
      integrationId: I_MAIN,
      dataObjectId: DO_SUBMITTALS,
      direction: 'a_to_b',
    });
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true });
    await sendJson('PUT', attestationUrl(C_SECOND), { asserted: true });

    await call(attestationUrl(C_MAIN), { method: 'DELETE' });

    expect((await integrationRow())?.maintainedBy).toBe('vendor');
  });

  it('stays vendor-maintained while the COUNTERPARTY still holds a live attestation', async () => {
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true });
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true }, AUTH_B);

    await call(attestationUrl(C_MAIN), { method: 'DELETE' });

    expect((await integrationRow())?.maintainedBy).toBe('vendor');
  });

  it('emits its audit row in the same batch, and none when the flip is a no-op', async () => {
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true });
    await sendJson('PUT', attestationUrl(C_MAIN), { asserted: true }, AUTH_B);

    // Vendor B still holds a slot, so this retraction changes no `maintained_by` —
    // and must therefore write no audit row claiming it did (§26.1).
    const before = (await auditRows()).length;
    await call(attestationUrl(C_MAIN), { method: 'DELETE' });
    const added = (await auditRows()).slice(before);
    expect(added.filter((r) => r.entityType === 'integration')).toHaveLength(0);

    // Vendor B withdraws too — now the flip is real, and it is audited. Scoped to
    // the rows THIS call added: the two PUTs above each audited their own
    // aeci→vendor flip, so an unscoped `find` would match the first of those.
    const beforeFinal = (await auditRows()).length;
    await call(attestationUrl(C_MAIN), { method: 'DELETE' }, AUTH_B);
    const flip = (await auditRows())
      .slice(beforeFinal)
      .find((r) => r.entityType === 'integration' && r.action === 'integration.updated');
    expect(flip?.entityId).toBe(I_MAIN);
    expect(flip?.beforeState).toMatchObject({ maintained_by: 'vendor' });
    expect(flip?.afterState).toMatchObject({ maintained_by: 'aeci' });
    expect(flip?.metadata).toMatchObject({ reason: 'maintenance-marker' });
  });
});
