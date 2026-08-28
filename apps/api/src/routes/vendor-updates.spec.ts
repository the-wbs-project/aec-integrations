/**
 * `GET /api/vendor/updates` (AECI-627 / `STAGE_2_REALTIME_SPEC.md` §2).
 *
 * The endpoint is six cursors, and it is only useful if each one moves for
 * **exactly** the writes its section's payload would show. So the spec is
 * organised around that property rather than around the response shape:
 *
 *   1. **Independence** — a write in one scope moves that scope's cursor and
 *      leaves the other five alone. A cursor that moves too eagerly is a poll
 *      amplifier (the client refetches a section nothing changed in).
 *   2. **Cross-vendor isolation** — another vendor's writes move nothing. There
 *      is no RLS behind `/api/vendor/*` (ADR 0016), so the `WHERE` clauses are
 *      the authorization, and a timestamp that moved would leak the existence of
 *      a row the caller may never read.
 *   3. **Null when empty** — a scope with no rows is `null` and stays `null`, so
 *      a vendor with (say) no requests never refetches that section.
 *
 * Every fixture pins its own `*_at` values instead of relying on wall-clock
 * ordering: two writes inside one millisecond produce the same ISO string, which
 * would make "did it move?" flaky rather than wrong. Drizzle's `$onUpdate` only
 * fills a column the update omits, so an explicit `updatedAt` in a `.set()` is
 * what lands.
 *
 * Per the repo split, this spec stubs `c.set('auth', …)`; the real
 * `requireVendor()` guard cells live in `vendor.authz-matrix.spec.ts`.
 */

import { VendorUpdatesResponseSchema, type VendorPortalScope } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attestations,
  auditLog,
  claims,
  integrations,
  productVendors,
  products,
  taxonomyDataObjects,
  vendorEntitlements,
  vendorRequests,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createVendorUpdatesHandler } from './vendor-updates';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const SEAT_A = uuid(100);

const PRODUCT_A = uuid(10); // vendor A's
const PRODUCT_B = uuid(11); // vendor B's, and the far endpoint of the SHARED integration
const PRODUCT_C = uuid(12); // vendor B's, and untouched by A

const INTEGRATION_AB = uuid(20); // A ↔ B — on A's attestable surface
const INTEGRATION_BC = uuid(21); // B ↔ C — B's alone

const DATA_OBJECT = uuid(30);
const CLAIM_AB = uuid(40);
const CLAIM_BC = uuid(41);

/** Well before anything a test writes, so any movement is unambiguous. */
const SEEDED = '2026-01-01T00:00:00.000Z';
const MOVED = '2026-06-01T12:00:00.000Z';
const MOVED_LATER = '2026-06-02T12:00:00.000Z';

let t: TestDb;

const AUTH: AuthzVariables['auth'] = {
  userId: SEAT_A,
  email: 'ops@autodesk.test',
  role: 'vendor_admin',
  vendorId: VENDOR_A,
  entitlementTier: 'verified',
  entitlement: { status: 'active', periodEnd: null },
};

beforeEach(async () => {
  t = await makeTestDb();

  await t.db.insert(vendors).values([
    {
      id: VENDOR_A,
      slug: 'autodesk',
      companyName: 'Autodesk',
      verified: true,
      createdAt: SEEDED,
      updatedAt: SEEDED,
    },
    {
      id: VENDOR_B,
      slug: 'bentley',
      companyName: 'Bentley',
      verified: true,
      createdAt: SEEDED,
      updatedAt: SEEDED,
    },
  ]);
  await t.db.insert(products).values([
    { id: PRODUCT_A, slug: 'revit', name: 'Revit', createdAt: SEEDED, updatedAt: SEEDED },
    {
      id: PRODUCT_B,
      slug: 'microstation',
      name: 'MicroStation',
      createdAt: SEEDED,
      updatedAt: SEEDED,
    },
    { id: PRODUCT_C, slug: 'openroads', name: 'OpenRoads', createdAt: SEEDED, updatedAt: SEEDED },
  ]);
  await t.db.insert(productVendors).values([
    { productId: PRODUCT_A, vendorId: VENDOR_A, isPrimary: true },
    { productId: PRODUCT_B, vendorId: VENDOR_B, isPrimary: true },
    { productId: PRODUCT_C, vendorId: VENDOR_B, isPrimary: true },
  ]);
  await t.db.insert(integrations).values([
    {
      id: INTEGRATION_AB,
      sourceProductId: PRODUCT_A,
      targetProductId: PRODUCT_B,
      createdAt: SEEDED,
      updatedAt: SEEDED,
    },
    {
      id: INTEGRATION_BC,
      sourceProductId: PRODUCT_B,
      targetProductId: PRODUCT_C,
      createdAt: SEEDED,
      updatedAt: SEEDED,
    },
  ]);
  await t.db
    .insert(taxonomyDataObjects)
    .values({ id: DATA_OBJECT, slug: 'rfis', name: 'RFIs', displayOrder: 10 });
});
afterEach(() => {
  t.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function app(auth: AuthzVariables['auth'] = AUTH, env: Env = TEST_ENV) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.get('/api/vendor/updates', createVendorUpdatesHandler(t.factory));
  return { a, env };
}

async function get(auth?: AuthzVariables['auth'], env?: Env) {
  const { a, env: e } = app(auth, env);
  const res = await a.request('/api/vendor/updates', {}, e, fakeExecutionContext());
  return { res, body: (await res.json()) as { revisions: Record<string, string | null> } };
}

/** Just the `revisions` block — what every movement assertion compares. */
async function revisions(auth?: AuthzVariables['auth']): Promise<Record<string, string | null>> {
  return (await get(auth)).body.revisions;
}

/** Assert that exactly `moved` changed between two snapshots, and to `to`. */
function expectOnlyMoved(
  before: Record<string, string | null>,
  after: Record<string, string | null>,
  moved: VendorPortalScope,
  to: string,
) {
  expect(after[moved]).toBe(to);
  for (const scope of Object.keys(before)) {
    if (scope === moved) continue;
    expect({ scope, value: after[scope] }).toEqual({ scope, value: before[scope] });
  }
}

// ── Fixture writers ─────────────────────────────────────────────────────────

async function seedEntitlement(vendorId: string, at = SEEDED) {
  await t.db.insert(vendorEntitlements).values({
    id: crypto.randomUUID(),
    vendorId,
    tier: 'verified',
    status: 'active',
    createdAt: at,
    updatedAt: at,
  });
}

async function seedClaim(id: string, integrationId: string, at = SEEDED) {
  await t.db.insert(claims).values({
    id,
    integrationId,
    dataObjectId: DATA_OBJECT,
    direction: 'a_to_b',
    createdAt: at,
    updatedAt: at,
  });
}

async function seedAttestation(
  id: string,
  claimId: string,
  over: { vendorId?: string; source?: string; at?: string; retractedAt?: string } = {},
) {
  await t.db.insert(attestations).values({
    id,
    claimId,
    source: over.source ?? 'vendor_a',
    asserted: true,
    attestedByVendorId: over.vendorId ?? VENDOR_A,
    retractedAt: over.retractedAt ?? null,
    createdAt: over.at ?? SEEDED,
    updatedAt: over.at ?? SEEDED,
  });
}

async function seedRequest(over: {
  targetType: string;
  targetId: string;
  createdAt?: string;
  resolvedAt?: string;
}) {
  const id = crypto.randomUUID();
  await t.db.insert(vendorRequests).values({
    id,
    kind: 'claim',
    targetType: over.targetType,
    targetId: over.targetId,
    submitterEmail: 'someone@example.test',
    body: 'Please claim',
    createdAt: over.createdAt ?? SEEDED,
    resolvedAt: over.resolvedAt ?? null,
  });
  return id;
}

/** A `notification.sent` ledger row, written the way the §7 sweep writes one. */
async function seedNotification(vendorId: string | null, createdAt = SEEDED) {
  await t.db.insert(auditLog).values({
    id: crypto.randomUUID(),
    actorType: 'system',
    action: NOTIFICATION_SENT_ACTION,
    entityType: 'claim',
    entityId: CLAIM_AB,
    createdAt,
    metadata: {
      detector: 'silent-counterparty',
      vendorId,
      integrationId: INTEGRATION_AB,
      dataObject: { slug: 'rfis', name: 'RFIs' },
      counterpartProduct: { slug: 'microstation', name: 'MicroStation' },
      pairSlugs: ['revit', 'microstation'],
    },
  });
}

// ── The contract ────────────────────────────────────────────────────────────

describe('GET /api/vendor/updates — shape and headers', () => {
  it('returns every scope, and `null` for each one the vendor has no rows in', async () => {
    const { res, body } = await get();

    expect(res.status).toBe(200);
    // `profile` is the one scope that can never be null for a live seat.
    expect(body.revisions).toEqual({
      profile: SEEDED,
      entitlement: null,
      products: SEEDED,
      integrations: null,
      notifications: null,
      requests: null,
    });
    expect(() => VendorUpdatesResponseSchema.parse(body)).not.toThrow();
  });

  it('is `private, no-store` — an intermediary must never serve a stale cursor', async () => {
    // A cached cursor reports "nothing changed" to a portal where something did,
    // which is precisely the failure the endpoint exists to prevent.
    const { res } = await get();
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('stamps `server_time`, and never later than the data it describes', async () => {
    const before = Date.now();
    const { body } = await get();
    const stamped = Date.parse((body as unknown as { server_time: string }).server_time);
    expect(stamped).toBeGreaterThanOrEqual(before - 1);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  it('writes NO audit_log row — it is a pure read (§26.1 governs writes)', async () => {
    await get();
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('reports `null` rather than 404 when the seat’s vendor row has been deleted', async () => {
    // `GET /api/vendor/me` owns that 404; a cursor that threw would take the poll
    // loop down with it and the dashboard would stop revalidating entirely.
    await t.db.delete(productVendors).where(eq(productVendors.vendorId, VENDOR_A));
    await t.db.delete(vendors).where(eq(vendors.id, VENDOR_A));

    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(body.revisions.profile).toBeNull();
  });
});

describe('GET /api/vendor/updates — each scope moves independently', () => {
  it('`profile` moves on an edit to the vendor’s own row', async () => {
    const before = await revisions();
    await t.db
      .update(vendors)
      .set({ description: 'edited', updatedAt: MOVED })
      .where(eq(vendors.id, VENDOR_A));

    expectOnlyMoved(before, await revisions(), 'profile', MOVED);
  });

  it('`entitlement` moves when the admin sets or renews the arrangement', async () => {
    const before = await revisions();
    expect(before.entitlement).toBeNull();

    await seedEntitlement(VENDOR_A, MOVED);
    expectOnlyMoved(before, await revisions(), 'entitlement', MOVED);

    // …and again on the renew, which is the one concrete sub-minute latency need
    // on the surface (ADR 0023's table).
    const afterGrant = await revisions();
    await t.db
      .update(vendorEntitlements)
      .set({ periodEnd: '2027-01-01T00:00:00.000Z', updatedAt: MOVED_LATER })
      .where(eq(vendorEntitlements.vendorId, VENDOR_A));
    expectOnlyMoved(afterGrant, await revisions(), 'entitlement', MOVED_LATER);
  });

  it('`products` moves on an edit to a product the vendor owns', async () => {
    const before = await revisions();
    await t.db
      .update(products)
      .set({ description: 'edited', updatedAt: MOVED })
      .where(eq(products.id, PRODUCT_A));

    expectOnlyMoved(before, await revisions(), 'products', MOVED);
  });

  it('`integrations` moves when a claim on the attestable surface changes', async () => {
    await seedClaim(CLAIM_AB, INTEGRATION_AB);
    const before = await revisions();
    expect(before.integrations).toBe(SEEDED);

    await t.db
      .update(claims)
      .set({ direction: 'both', updatedAt: MOVED })
      .where(eq(claims.id, CLAIM_AB));

    expectOnlyMoved(before, await revisions(), 'integrations', MOVED);
  });

  it('`integrations` moves when an attestation on that surface changes', async () => {
    await seedClaim(CLAIM_AB, INTEGRATION_AB);
    await seedAttestation(uuid(50), CLAIM_AB);
    const before = await revisions();

    await t.db
      .update(attestations)
      .set({ note: 'still true', updatedAt: MOVED })
      .where(eq(attestations.id, uuid(50)));

    expectOnlyMoved(before, await revisions(), 'integrations', MOVED);
  });

  it('`integrations` moves on a RETRACT — the cursor must not filter to live rows', async () => {
    // The specific trap: `GET /api/vendor/integrations` reads live attestations
    // only, and copying that filter here would leave a bare retract invisible.
    // A retract stamps `retracted_at` on the existing row and inserts nothing, so
    // a live-only cursor would not move while the lane the vendor is looking at
    // just emptied.
    await seedClaim(CLAIM_AB, INTEGRATION_AB);
    await seedAttestation(uuid(50), CLAIM_AB);
    const before = await revisions();

    await t.db
      .update(attestations)
      .set({ retractedAt: MOVED, updatedAt: MOVED })
      .where(eq(attestations.id, uuid(50)));

    expectOnlyMoved(before, await revisions(), 'integrations', MOVED);
  });

  it('`integrations` moves when the COUNTERPARTY attests on the shared claim', async () => {
    // Not an isolation leak — the inverse. The pair page renders both sides, so
    // the far endpoint's vendor attesting is a change to the caller's own surface
    // and is one of the six events ADR 0023 enumerated.
    await seedClaim(CLAIM_AB, INTEGRATION_AB);
    const before = await revisions();

    await seedAttestation(uuid(51), CLAIM_AB, {
      vendorId: VENDOR_B,
      source: 'vendor_b',
      at: MOVED,
    });

    expectOnlyMoved(before, await revisions(), 'integrations', MOVED);
  });

  it('`notifications` moves when the sweep records a nudge for this vendor', async () => {
    const before = await revisions();
    await seedNotification(VENDOR_A, MOVED);

    expectOnlyMoved(before, await revisions(), 'notifications', MOVED);
  });

  it('`requests` moves on submission and again on resolution', async () => {
    // `vendor_requests` has NO `updated_at`, so the cursor is
    // COALESCE(resolved_at, created_at) — verified against `db/schema.ts`.
    const before = await revisions();
    expect(before.requests).toBeNull();

    const id = await seedRequest({ targetType: 'vendor', targetId: VENDOR_A, createdAt: MOVED });
    const afterSubmit = await revisions();
    expectOnlyMoved(before, afterSubmit, 'requests', MOVED);

    await t.db
      .update(vendorRequests)
      .set({ status: 'resolved', resolvedAt: MOVED_LATER })
      .where(eq(vendorRequests.id, id));
    expectOnlyMoved(afterSubmit, await revisions(), 'requests', MOVED_LATER);
  });

  it('`requests` also covers requests targeting a product the vendor owns', async () => {
    // The same two-armed predicate `GET /api/vendor/me` lists requests with —
    // shared as `vendorRequestsWhere`, so the cursor cannot scope more narrowly
    // than the list it is a cursor for.
    const before = await revisions();
    await seedRequest({ targetType: 'product', targetId: PRODUCT_A, createdAt: MOVED });

    expectOnlyMoved(before, await revisions(), 'requests', MOVED);
  });
});

describe('GET /api/vendor/updates — cross-vendor isolation', () => {
  it('no write of another vendor’s moves ANY cursor', async () => {
    // Everything below belongs to vendor B and touches nothing on A's surface.
    // A cursor that moved here would leak the existence of a row the caller can
    // never read — there is no RLS behind this, the WHERE clauses ARE the authz.
    await seedEntitlement(VENDOR_A);
    await seedClaim(CLAIM_AB, INTEGRATION_AB);
    await seedRequest({ targetType: 'vendor', targetId: VENDOR_A });
    await seedNotification(VENDOR_A);
    const before = await revisions();

    await seedEntitlement(VENDOR_B, MOVED_LATER);
    await t.db
      .update(vendors)
      .set({ description: 'B edited', updatedAt: MOVED_LATER })
      .where(eq(vendors.id, VENDOR_B));
    await t.db
      .update(products)
      .set({ description: 'C edited', updatedAt: MOVED_LATER })
      .where(eq(products.id, PRODUCT_C));
    await seedClaim(CLAIM_BC, INTEGRATION_BC, MOVED_LATER);
    await seedAttestation(uuid(52), CLAIM_BC, {
      vendorId: VENDOR_B,
      source: 'vendor_b',
      at: MOVED_LATER,
    });
    await seedRequest({ targetType: 'vendor', targetId: VENDOR_B, createdAt: MOVED_LATER });
    await seedRequest({ targetType: 'product', targetId: PRODUCT_C, createdAt: MOVED_LATER });
    await seedNotification(VENDOR_B, MOVED_LATER);

    expect(await revisions()).toEqual(before);
  });

  it('an ops-routed ledger row (metadata.vendorId = null) moves nobody’s cursor', async () => {
    // The `aeci-denied` correction signal and the ops half of `open-conflict`
    // store a null vendor; `json_extract` returns SQL NULL, which equals nothing.
    // Structural isolation, not a clause a handler has to remember.
    await seedNotification(null, MOVED_LATER);

    expect((await revisions()).notifications).toBeNull();
    expect((await revisions({ ...AUTH, vendorId: VENDOR_B })).notifications).toBeNull();
  });

  it('an audit row that is not a notification never moves the cursor', async () => {
    // The ledger predicate is action + window + vendor. A `vendor.updated` row
    // carrying the same vendor id must not register as a nudge.
    await t.db.insert(auditLog).values({
      id: crypto.randomUUID(),
      actorType: 'user',
      action: 'vendor.updated',
      entityType: 'vendor',
      entityId: VENDOR_A,
      createdAt: MOVED_LATER,
      metadata: { source: 'vendor-portal', vendorId: VENDOR_A },
    });

    expect((await revisions()).notifications).toBeNull();
  });

  it('two vendors sharing one integration each see it, and neither sees the other’s', async () => {
    await seedClaim(CLAIM_AB, INTEGRATION_AB, MOVED);
    await seedClaim(CLAIM_BC, INTEGRATION_BC, MOVED_LATER);

    // A touches only INTEGRATION_AB; B touches both, so B's is the later cursor.
    expect((await revisions()).integrations).toBe(MOVED);
    expect((await revisions({ ...AUTH, vendorId: VENDOR_B })).integrations).toBe(MOVED_LATER);
  });
});

describe('GET /api/vendor/updates — aeci.api.vendor.updates', () => {
  function stubTelemetry() {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchSpy);
    return fetchSpy;
  }

  /**
   * The metric's data-point attributes, flattened back to `key:value` strings.
   * The intake is PostHog OTLP (`/i/v1/metrics`) — the Datadog v2-series leg was
   * deleted in AECI-651.
   */
  function tagsFrom(fetchSpy: ReturnType<typeof vi.fn>): string[] {
    type Attr = { key: string; value: { stringValue?: string; doubleValue?: number } };
    const call = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith('/i/v1/metrics'));
    if (!call) return [];
    const payload = JSON.parse(String((call[1] as RequestInit | undefined)?.body ?? '{}'));
    const metric = payload.resourceMetrics?.[0]?.scopeMetrics?.[0]?.metrics?.[0];
    const points = metric?.sum?.dataPoints ?? metric?.gauge?.dataPoints ?? [];
    return (points[0]?.attributes ?? []).map(
      (a: Attr) => `${a.key}:${a.value.doubleValue ?? a.value.stringValue}`,
    );
  }

  const TELEMETRY_ENV: Env = { ...TEST_ENV, POSTHOG_PROJECT_KEY: 'phc_test_token' };

  it('tags `changed:none` when nothing moved inside the poll window', async () => {
    const fetchSpy = stubTelemetry();
    await get(AUTH, TELEMETRY_ENV);

    const tags = tagsFrom(fetchSpy);
    expect(tags).toContain('changed:none');
  });

  it('tags `changed:some` when a cursor moved inside the poll window', async () => {
    // "Changed" is stateless — the endpoint has no idea what the caller last saw,
    // so it means "something moved within one poll interval of this response".
    const fetchSpy = stubTelemetry();
    await t.db
      .update(vendors)
      .set({ description: 'just now', updatedAt: new Date().toISOString() })
      .where(eq(vendors.id, VENDOR_A));

    await get(AUTH, TELEMETRY_ENV);
    expect(tagsFrom(fetchSpy)).toContain('changed:some');
  });
});
