/**
 * `PATCH /api/admin/vendors/:id/entitlement` — the admin set/renew/clear action
 * (AECI-532 / `docs/STAGE_2_PAID_TIERS_SPEC.md` §5), against the in-memory D1 harness.
 *
 * Three of these are INVARIANT tests (§10) and must not be deleted without reopening
 * the spec:
 *
 *   1. **`vendors.updated_at` moves on BOTH the set and the clear.** The un-verify
 *      direction is the one AECI-529 never reasoned about: the nightly Algolia sync is
 *      watermark-driven, so a clear that forgets the stamp leaves a Verified badge in
 *      search indefinitely (R2). A renew, which does NOT move the mirror, must equally
 *      NOT move the watermark.
 *   2. **No `workflow_instances` row, ever.** `workflow_instances_type_check` is a
 *      closed CHECK and §1.2 settles entitlement changes as audit-only, permanently.
 *   3. **Clearing does not revoke seats.** Three orthogonal "take it away" actions
 *      (§5.2); an admin clicking the wrong one expecting a different effect is a
 *      foreseeable incident.
 *
 * Authorization is exercised against the REAL `requireAdmin()` guard in the last
 * describe — including a `vendor_admin` seat on the very vendor being acted on, which
 * is the AC's "a non-admin, including a vendor_admin for that vendor, gets 403".
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  productVendors,
  products,
  profiles,
  vendorEntitlements,
  vendors,
  workflowInstances,
} from '../db/schema';
import { submitCount } from '../posthog';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireAdmin, type AuthzVariables } from '../lib/authz';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createSetVendorEntitlementHandler } from './admin-entitlements';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

function entitlementActions(): string[][] {
  return vi
    .mocked(submitCount)
    .mock.calls.filter((call) => call[3] === 'aeci.entitlement.action')
    .map((call) => call[5] as string[]);
}

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = u(900);
const VENDOR = u(1);
const OTHER_VENDOR = u(2);
const SEAT = u(500);
/** Deliberately stale, so any `updated_at` assertion is unambiguous. */
const OLD_TS = '2020-01-01T00:00:00.000Z';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
  vi.mocked(submitCount).mockClear();
});
afterEach(() => t.dispose());

// ─── Seeding ─────────────────────────────────────────────────────────────────

const seedVendor = (over: Partial<typeof vendors.$inferInsert> = {}) =>
  t.db.insert(vendors).values({
    id: VENDOR,
    slug: 'autodesk',
    companyName: 'Autodesk, Inc.',
    verified: false,
    updatedAt: OLD_TS,
    ...over,
  });

const seedEntitlement = (over: Partial<typeof vendorEntitlements.$inferInsert> = {}) =>
  t.db.insert(vendorEntitlements).values({
    vendorId: VENDOR,
    tier: 'verified',
    status: 'active',
    grantedAt: OLD_TS,
    createdAt: OLD_TS,
    updatedAt: OLD_TS,
    ...over,
  });

const readVendor = async () =>
  (await t.db.select().from(vendors).where(eq(vendors.id, VENDOR)))[0]!;
const readEntitlement = async () =>
  (await t.db.select().from(vendorEntitlements).where(eq(vendorEntitlements.vendorId, VENDOR)))[0];

// ─── App under test (handler mounted bare; authz has its own describe) ───────

function app() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', {
      userId: ADMIN,
      email: undefined,
      role: 'admin',
      vendorId: null,
      entitlementTier: 'unclaimed',
      entitlement: null,
    });
    await next();
  });
  a.patch('/api/admin/vendors/:id/entitlement', createSetVendorEntitlementHandler(t.factory));
  return a;
}

const patch = (id: string, body: unknown, env: Env = TEST_ENV) =>
  app().request(
    `/api/admin/vendors/${id}/entitlement`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    },
    env,
    fakeExecutionContext(),
  );

// ─── set ─────────────────────────────────────────────────────────────────────

describe('PATCH …/entitlement — set', () => {
  it('creates the entitlement row and flips the mirror in one batch', async () => {
    await seedVendor();
    const res = await patch(VENDOR, {
      action: 'set',
      period_start: '2026-09-01',
      period_end: '2027-09-01',
      payer: 'Autodesk AP',
      amount: 'USD 5,000 / yr',
      invoice_ref: 'PO-4471',
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      vendor_id: VENDOR,
      tier: 'verified',
      status: 'active',
      period_end: '2027-09-01',
      verified: true,
      invoice_ref: 'PO-4471',
      amount: 'USD 5,000 / yr',
    });

    const row = await readEntitlement();
    expect(row!.status).toBe('active');
    expect(row!.periodEnd).toBe('2027-09-01');
    expect((await readVendor()).verified).toBe(true);
    expect(entitlementActions()).toEqual([['action:set', 'outcome:ok']]);
  });

  it('records the arrangement + reason in the audit metadata, actor_type admin', async () => {
    await seedVendor();
    await patch(VENDOR, { action: 'set', notes: 'Signed MSA', reason: 'Q3 renewal cycle' });

    const [entry] = await t.db.select().from(auditLog);
    expect(entry!.action).toBe('vendor_entitlement.set');
    expect(entry!.entityType).toBe('vendor_entitlement');
    // `entity_id` is the VENDOR id, not the entitlement row id — that is what makes
    // `audit_log_entity_idx` the grant/renew/lapse ledger for a vendor (§2.1).
    expect(entry!.entityId).toBe(VENDOR);
    expect(entry!.actorType).toBe('admin');
    expect(entry!.actorId).toBe(ADMIN);
    const meta = entry!.metadata as Record<string, unknown>;
    expect(meta.reason).toBe('Q3 renewal cycle');
    expect((meta.arrangement as Record<string, unknown>).notes).toBe('Signed MSA');
  });

  it('reactivates a revoked row in place rather than inserting a second one', async () => {
    await seedVendor();
    await seedEntitlement({ status: 'revoked', endedAt: OLD_TS, expiryNoticeSentAt: OLD_TS });

    const res = await patch(VENDOR, { action: 'set', period_end: '2027-09-01' });
    expect(res.status).toBe(200);

    const rows = await t.db.select().from(vendorEntitlements);
    expect(rows).toHaveLength(1); // `vendor_entitlements_vendor_key` is UNIQUE
    expect(rows[0]!.status).toBe('active');
    expect(rows[0]!.endedAt).toBeNull();
    // Re-activation clears the §7 fence so the new term earns its own notice.
    expect(rows[0]!.expiryNoticeSentAt).toBeNull();
    const meta = (await t.db.select().from(auditLog))[0]!.metadata as Record<string, unknown>;
    expect(meta.reactivated).toBe(true);
  });

  it('422s on a vendor that already has an active entitlement', async () => {
    await seedVendor({ verified: true });
    await seedEntitlement();

    const res = await patch(VENDOR, { action: 'set' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_STATE_TRANSITION',
    );
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(entitlementActions()).toEqual([['action:set', 'outcome:invalid_state']]);
  });

  it('404s on an unknown vendor, writing nothing', async () => {
    const res = await patch(OTHER_VENDOR, { action: 'set' });
    expect(res.status).toBe(404);
    expect(
      ((await res.json()) as { error: { details: { resource: string } } }).error.details.resource,
    ).toBe('vendor');
    expect(await t.db.select().from(vendorEntitlements)).toHaveLength(0);
  });

  it('rejects the `unclaimed` tier at the SCHEMA — the absence of an entitlement is not a rung', async () => {
    await seedVendor();
    const res = await patch(VENDOR, { action: 'set', tier: 'unclaimed' });
    // 400, not 403: `SetVendorEntitlementSchema.tier` derives from `PAID_TIERS`, not
    // `TIERS`, so Zod refuses it before the handler runs. The guard-rail belongs in the
    // allow-list (`api/vendor.ts`'s header invariant) because a future consumer of this
    // schema — a datatool surface, a back-office script — inherits the schema, not the
    // handler. The handler keeps a semantic zero-capability guard behind it.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    );
    // The badge would have lit (status `active` mirrors) while `tierFor` resolved the
    // row to ZERO capabilities — a vendor billed for a badge that unlocks nothing.
    expect((await readVendor()).verified).toBe(false);
    expect(await t.db.select().from(vendorEntitlements)).toHaveLength(0);
    // No metric: rejected before the handler, so nothing counts it as an attempt.
    expect(entitlementActions()).toEqual([]);
  });

  it('400s when the term ends before it starts', async () => {
    await seedVendor();
    const res = await patch(VENDOR, {
      action: 'set',
      period_start: '2027-09-01',
      period_end: '2026-09-01',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    );
    expect(await t.db.select().from(vendorEntitlements)).toHaveLength(0);
  });

  it('rejects a payload that names `verified` (it is never on the request)', async () => {
    await seedVendor();
    // Zod strips unknown keys rather than throwing, so the assertion that matters is
    // the EFFECT: `verified: false` alongside a `set` cannot suppress the mirror flip.
    const res = await patch(VENDOR, { action: 'set', verified: false });
    expect(res.status).toBe(200);
    expect((await readVendor()).verified).toBe(true);
  });
});

// ─── renew ───────────────────────────────────────────────────────────────────

describe('PATCH …/entitlement — renew', () => {
  it('extends the term and patches only the fields supplied', async () => {
    await seedVendor({ verified: true });
    await seedEntitlement({
      periodEnd: '2026-09-01',
      invoiceRef: 'PO-4471',
      payer: 'Autodesk AP',
      expiryNoticeSentAt: '2026-08-01T00:00:00.000Z',
    });

    const res = await patch(VENDOR, { action: 'renew', period_end: '2027-09-01' });
    expect(res.status).toBe(200);

    const row = await readEntitlement();
    expect(row!.periodEnd).toBe('2027-09-01');
    // NOT wiped — a renewal must not destroy the paperwork recorded at grant time.
    expect(row!.invoiceRef).toBe('PO-4471');
    expect(row!.payer).toBe('Autodesk AP');
    // A new term earns its own §7 expiry notice.
    expect(row!.expiryNoticeSentAt).toBeNull();
    expect((await t.db.select().from(auditLog))[0]!.action).toBe('vendor_entitlement.renewed');
    expect(entitlementActions()).toEqual([['action:renew', 'outcome:ok']]);
  });

  it('does NOT move vendors.updated_at — the mirror did not move (R2)', async () => {
    await seedVendor({ verified: true });
    await seedEntitlement({ periodEnd: '2026-09-01' });

    await patch(VENDOR, { action: 'renew', period_end: '2027-09-01' });

    const vendor = await readVendor();
    expect(vendor.verified).toBe(true);
    // A renewal that bumped the watermark would schedule a needless nightly Algolia
    // re-push of a byte-identical record.
    expect(vendor.updatedAt).toBe(OLD_TS);
  });

  it('422s when there is no active entitlement to renew', async () => {
    await seedVendor();
    const res = await patch(VENDOR, { action: 'renew', period_end: '2027-09-01' });
    expect(res.status).toBe(422);
    expect(entitlementActions()).toEqual([['action:renew', 'outcome:invalid_state']]);

    await seedEntitlement({ status: 'expired' });
    vi.mocked(submitCount).mockClear();
    expect((await patch(VENDOR, { action: 'renew' })).status).toBe(422);
  });
});

// ─── clear ───────────────────────────────────────────────────────────────────

describe('PATCH …/entitlement — clear', () => {
  it('ends the entitlement and takes the mirror back down', async () => {
    await seedVendor({ verified: true });
    await seedEntitlement();

    const res = await patch(VENDOR, { action: 'clear', reason: 'Non-payment' });
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      status: 'revoked',
      verified: false,
    });

    const row = await readEntitlement();
    expect(row!.status).toBe('revoked');
    expect(row!.endedAt).not.toBeNull();
    expect((await readVendor()).verified).toBe(false);
    expect((await t.db.select().from(auditLog))[0]!.action).toBe('vendor_entitlement.cleared');
    expect(entitlementActions()).toEqual([['action:clear', 'outcome:ok']]);
  });

  it('422s on an already-inactive entitlement, and on a vendor with none', async () => {
    await seedVendor();
    expect((await patch(VENDOR, { action: 'clear' })).status).toBe(422);

    await seedEntitlement({ status: 'revoked' });
    vi.mocked(submitCount).mockClear();
    const res = await patch(VENDOR, { action: 'clear' });
    expect(res.status).toBe(422);
    expect(entitlementActions()).toEqual([['action:clear', 'outcome:invalid_state']]);
  });

  it('does NOT revoke seats: role, vendor_id and ban state all survive (§5.2)', async () => {
    await seedVendor({ verified: true });
    await seedEntitlement();
    await t.db
      .insert(profiles)
      .values({ id: SEAT, role: 'vendor_admin', vendorId: VENDOR, displayName: 'Seat One' });

    expect((await patch(VENDOR, { action: 'clear' })).status).toBe(200);

    const [seat] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT));
    // Clearing an entitlement is not a seat revoke and not a ban. The seat keeps its
    // login and its dashboard; the §4 gate makes it read-only. `GET /api/vendor/me`
    // must keep returning 200 — that is AECI-611's own invariant test.
    expect(seat!.role).toBe('vendor_admin');
    expect(seat!.vendorId).toBe(VENDOR);
    expect(seat!.bannedAt).toBeNull();
  });
});

// ─── The R2 invariant: updated_at moves IFF verified moves ───────────────────

describe('vendors.updated_at (R2 — the Algolia watermark)', () => {
  it('moves on the SET', async () => {
    await seedVendor();
    await patch(VENDOR, { action: 'set' });
    const vendor = await readVendor();
    expect(vendor.verified).toBe(true);
    expect(vendor.updatedAt).not.toBe(OLD_TS);
  });

  it('moves on the CLEAR — or a lapsed vendor keeps its badge in search forever', async () => {
    await seedVendor({ verified: true });
    await seedEntitlement();
    await patch(VENDOR, { action: 'clear' });
    const vendor = await readVendor();
    expect(vendor.verified).toBe(false);
    expect(vendor.updatedAt).not.toBe(OLD_TS);
  });

  it('does not move when the mirror was already in the target state (drift self-heal)', async () => {
    // `verified = 1` with NO entitlement row — the pre-backfill drifted state. The set
    // gives it the row it should always have had; the mirror does not move, so neither
    // does the watermark.
    await seedVendor({ verified: true });
    await patch(VENDOR, { action: 'set' });
    const vendor = await readVendor();
    expect(vendor.verified).toBe(true);
    expect(vendor.updatedAt).toBe(OLD_TS);
    expect((await readEntitlement())!.status).toBe('active');
  });
});

// ─── Audit-only: no workflow row, ever (§1.2 / R1) ───────────────────────────

describe('no workflow_instances row', () => {
  it('writes none on set, renew or clear', async () => {
    await seedVendor();
    await patch(VENDOR, { action: 'set', period_end: '2027-09-01' });
    await patch(VENDOR, { action: 'renew', period_end: '2028-09-01' });
    await patch(VENDOR, { action: 'clear' });

    // `workflow_instances_type_check` is a CLOSED CHECK; opening it on SQLite is a full
    // table rebuild. §2.1 settles that `audit_log` IS the entitlement ledger.
    expect(await t.db.select().from(workflowInstances)).toHaveLength(0);
    expect((await t.db.select().from(auditLog)).map((a) => a.action)).toEqual([
      'vendor_entitlement.set',
      'vendor_entitlement.renewed',
      'vendor_entitlement.cleared',
    ]);
  });
});

// ─── Cache purge (§5.3) ──────────────────────────────────────────────────────

describe('cache purge', () => {
  /** The typed queue message the SSR consumer receives (WC-5 / AECI-319). */
  type PurgeMessage = { tags: string[]; source: string };
  type PurgeSend = ReturnType<typeof vi.fn<(msg: PurgeMessage) => Promise<void>>>;

  function envWithQueue(send: PurgeSend): Env {
    return { ...TEST_ENV, CACHE_PURGE_QUEUE: { send } } as unknown as Env;
  }

  const firstMessage = (send: PurgeSend): PurgeMessage => send.mock.calls[0]![0];

  async function seedOwnedProduct() {
    await t.db.insert(products).values({ id: u(700), slug: 'revit', name: 'Revit' });
    await t.db
      .insert(productVendors)
      .values({ productId: u(700), vendorId: VENDOR, isPrimary: true });
  }

  it('enqueues the FULL grant tag set on a set — vendor + owned products + index', async () => {
    await seedVendor();
    await seedOwnedProduct();
    const send: PurgeSend = vi.fn(async () => {});

    expect((await patch(VENDOR, { action: 'set' }, envWithQueue(send))).status).toBe(200);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());

    // Purging only `vendor:{slug}` would leave a stale badge on every cached product
    // page — the badge renders on the product-detail vendor card and both pair rails.
    expect(firstMessage(send)).toEqual({
      tags: ['vendor:autodesk', 'product:revit', 'index:products'],
      source: 'moderation',
    });
  });

  it('enqueues the same set on a clear', async () => {
    await seedVendor({ verified: true });
    await seedEntitlement();
    await seedOwnedProduct();
    const send: PurgeSend = vi.fn(async () => {});

    expect((await patch(VENDOR, { action: 'clear' }, envWithQueue(send))).status).toBe(200);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(firstMessage(send).tags).toContain('product:revit');
  });

  it('does not purge on a renew — the badge cannot have changed', async () => {
    await seedVendor({ verified: true });
    await seedEntitlement({ periodEnd: '2026-09-01' });
    await seedOwnedProduct();
    const send: PurgeSend = vi.fn(async () => {});

    expect(
      (await patch(VENDOR, { action: 'renew', period_end: '2027-09-01' }, envWithQueue(send)))
        .status,
    ).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });

  it('survives a queue rejection — a cache miss never fails a committed write', async () => {
    await seedVendor();
    const send: PurgeSend = vi.fn(async () => {
      throw new Error('queue down');
    });
    expect((await patch(VENDOR, { action: 'set' }, envWithQueue(send))).status).toBe(200);
    expect((await readVendor()).verified).toBe(true);
  });
});

// ─── Authorization, against the REAL requireAdmin() guard ────────────────────

describe('authorization', () => {
  const SUPABASE_URL = 'https://test-project.supabase.co';
  const AUTHZ_ENV = { ENV: 'preview', SUPABASE_URL } as Env;

  let jwks: TestJwks;
  beforeAll(async () => {
    jwks = await makeTestJwks();
  });

  function guardedApp() {
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.patch(
      '/api/admin/vendors/:id/entitlement',
      requireAdmin({ getKey: jwks.getKey, dbFor: t.factory }),
      createSetVendorEntitlementHandler(t.factory),
    );
    return a;
  }

  const call = async (token?: string) =>
    guardedApp().request(
      `/api/admin/vendors/${VENDOR}/entitlement`,
      {
        method: 'PATCH',
        body: JSON.stringify({ action: 'set' }),
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      AUTHZ_ENV,
      fakeExecutionContext(),
    );

  beforeEach(async () => {
    await seedVendor();
  });

  it('401s with no token', async () => {
    expect((await call()).status).toBe(401);
    expect(await t.db.select().from(vendorEntitlements)).toHaveLength(0);
  });

  it('403s a plain reviewer', async () => {
    await t.db.insert(profiles).values({ id: u(910), role: 'reviewer' });
    const token = await jwks.mintToken({ sub: u(910), supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(403);
    expect(await t.db.select().from(vendorEntitlements)).toHaveLength(0);
  });

  it('403s a vendor_admin — including the seat on the very vendor being acted on', async () => {
    await t.db.insert(profiles).values({ id: SEAT, role: 'vendor_admin', vendorId: VENDOR });
    const token = await jwks.mintToken({ sub: SEAT, supabaseUrl: SUPABASE_URL });
    // Entitlements are granted TO a vendor, never BY one — otherwise a seat could
    // verify itself.
    expect((await call(token)).status).toBe(403);
    expect(await t.db.select().from(vendorEntitlements)).toHaveLength(0);
  });

  it('200s an admin', async () => {
    const token = await jwks.mintToken({ sub: ADMIN, supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(200);
    expect((await readVendor()).verified).toBe(true);
  });
});
