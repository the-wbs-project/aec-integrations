/**
 * Reviewer ban-management API (AECI-218 / Phase 6.11) on the Drizzle/D1 path
 * (ADR 0016 / AECI-253), against the in-memory D1 harness.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, licenses, profiles, vendors, workflowInstances } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { seedBillingAccount, seedLicense } from '../test/licenses';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createBanReviewerHandler, createBannedReviewersListHandler } from './admin-reviewers';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = u(900);

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
});
afterEach(() => t.dispose());

const emails = vi.fn(async () => new Map<string, string>());

function listApp() {
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
  a.get('/api/admin/reviewers', createBannedReviewersListHandler(t.factory, emails));
  return a;
}
function patchApp() {
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
  a.patch('/api/admin/reviewers/:id', createBanReviewerHandler(t.factory));
  return a;
}
const patch = (id: string, body: unknown) =>
  patchApp().request(
    `/api/admin/reviewers/${id}`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    },
    TEST_ENV,
    fakeExecutionContext(),
  );

describe('PATCH /api/admin/reviewers/:id', () => {
  it('bans an active reviewer (sets banned_at, audits, opens the workflow)', async () => {
    await t.db.insert(profiles).values({ id: u(1) });
    const res = await patch(u(1), { action: 'ban', reason: 'Repeated spam reviews.' });
    expect(res.status).toBe(200);

    const [row] = await t.db
      .select()
      .from(profiles)
      .where(eq(profiles.id, u(1)));
    expect(row!.bannedAt).not.toBeNull();
    expect(row!.banReason).toBe('Repeated spam reviews.');
    expect((await t.db.select().from(auditLog)).some((a) => a.action === 'reviewer.banned')).toBe(
      true,
    );
    const [wf] = await t.db.select().from(workflowInstances);
    expect(wf!.workflowType).toBe('reviewer_ban');
    expect(wf!.currentState).toBe('banned');
    expect(wf!.completedAt).toBeNull(); // reversible workflow
  });

  it('unbans a banned reviewer', async () => {
    await t.db
      .insert(profiles)
      .values({ id: u(1), bannedAt: '2026-01-01T00:00:00.000Z', banReason: 'x' });
    const res = await patch(u(1), { action: 'unban' });
    expect(res.status).toBe(200);
    const [row] = await t.db
      .select()
      .from(profiles)
      .where(eq(profiles.id, u(1)));
    expect(row!.bannedAt).toBeNull();
  });

  it('403s banning an admin or yourself', async () => {
    await t.db.insert(profiles).values({ id: u(2), role: 'admin' });
    expect((await patch(u(2), { action: 'ban', reason: 'Repeated spam reviews.' })).status).toBe(
      403,
    );
    expect((await patch(ADMIN, { action: 'ban', reason: 'Repeated spam reviews.' })).status).toBe(
      403,
    );
  });

  it('422s an already-banned reviewer', async () => {
    await t.db.insert(profiles).values({ id: u(1), bannedAt: '2026-01-01T00:00:00.000Z' });
    expect((await patch(u(1), { action: 'ban', reason: 'Repeated spam reviews.' })).status).toBe(
      422,
    );
  });
});

// AECI-524 — the SAME endpoint bans a `vendor_admin` seat (the ban mechanism is
// role-agnostic; only the audit action + metric are role-aware). §7 of
// STAGE_2_VENDOR_PORTAL_SPEC.md: ban is per-seat and never touches
// `vendors.verified`; unban restores portal access without re-granting.
describe('PATCH /api/admin/reviewers/:id — vendor_admin seats (AECI-524)', () => {
  const VENDOR = u(500);
  const SEAT_A = u(501);
  const SEAT_B = u(502);

  beforeEach(async () => {
    await t.db
      .insert(vendors)
      .values({ id: VENDOR, slug: 'autodesk', companyName: 'Autodesk', verified: true });
  });

  it('bans a vendor_admin seat and audits it as vendor_admin.banned', async () => {
    await t.db.insert(profiles).values({ id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR });

    const res = await patch(SEAT_A, { action: 'ban', reason: 'Portal abuse' });
    expect(res.status).toBe(200);

    const [row] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT_A));
    expect(row!.bannedAt).not.toBeNull();
    expect(row!.banReason).toBe('Portal abuse');
    // The grant stays intact — a ban gates access, it does not un-grant the seat.
    expect(row!.role).toBe('vendor_admin');
    expect(row!.vendorId).toBe(VENDOR);

    const actions = (await t.db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toContain('vendor_admin.banned');
    expect(actions).not.toContain('reviewer.banned');

    const [wf] = await t.db.select().from(workflowInstances);
    expect(wf!.currentState).toBe('banned');
    expect(wf!.completedAt).toBeNull(); // reversible workflow
  });

  it('unbans a vendor_admin seat (restores access without re-grant)', async () => {
    await t.db.insert(profiles).values({
      id: SEAT_A,
      role: 'vendor_admin',
      vendorId: VENDOR,
      bannedAt: '2026-07-01T00:00:00.000Z',
      banReason: 'Portal abuse',
    });

    const res = await patch(SEAT_A, { action: 'unban' });
    expect(res.status).toBe(200);

    const [row] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT_A));
    expect(row!.bannedAt).toBeNull();
    // Unban never re-grants: the seat was and stays a linked vendor_admin.
    expect(row!.role).toBe('vendor_admin');
    expect(row!.vendorId).toBe(VENDOR);
    expect((await t.db.select().from(auditLog)).map((a) => a.action)).toContain(
      'vendor_admin.unbanned',
    );
  });

  it('is per-seat: banning one seat leaves the other seat and vendors.verified untouched', async () => {
    await t.db.insert(profiles).values([
      { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR },
      { id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR },
    ]);

    expect((await patch(SEAT_A, { action: 'ban', reason: 'Portal abuse' })).status).toBe(200);

    const [a] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT_A));
    const [b] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT_B));
    expect(a!.bannedAt).not.toBeNull();
    expect(b!.bannedAt).toBeNull(); // the other seat is unaffected
    expect(b!.role).toBe('vendor_admin');

    const [vendor] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(vendor!.verified).toBe(true); // vendor-level entitlement is never touched by a ban

    const banRows = (await t.db.select().from(auditLog)).filter(
      (r) => r.action === 'vendor_admin.banned',
    );
    expect(banRows).toHaveLength(1);
    expect(banRows[0]!.entityId).toBe(SEAT_A);
  });
});

// AECI-1374 (E4.5, decision 15, ruled 2026-10-14): the ban of a vendor's LAST
// unbanned seat flags every live license cancel-at-term-end, reason `vendor-banned`,
// in the ban's own batch. Nothing ends. The unban clears only `vendor-banned` flags.
describe('PATCH /api/admin/reviewers/:id: a last-seat ban and the licenses (AECI-1374)', () => {
  const VENDOR = u(600);
  const SEAT_A = u(601);
  const SEAT_B = u(602);
  const ENDED_AT = '2026-06-01T00:00:00.000Z';

  let assigned: string;
  let invoice: string;
  let stripe: string;
  let ended: string;

  beforeEach(async () => {
    await t.db
      .insert(vendors)
      .values({ id: VENDOR, slug: 'bentley', companyName: 'Bentley', verified: true });
    await t.db.insert(profiles).values({ id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR });
    assigned = await seedLicense(t.db, VENDOR, { endsAt: '2027-01-31T00:00:00.000Z' });
    invoice = await seedLicense(t.db, VENDOR, { source: 'invoice' });
    stripe = await seedLicense(t.db, VENDOR, { source: 'stripe' });
    ended = await seedLicense(t.db, VENDOR, { endedAt: ENDED_AT, endReason: 'lapsed' });
  });

  const licenseRows = async () => {
    const rows = await t.db.select().from(licenses);
    return new Map(rows.map((r) => [r.id, r]));
  };
  const licenseAudits = async () =>
    (await t.db.select().from(auditLog)).filter((r) => r.action.startsWith('license.'));

  it('a ban while another unbanned seat remains flags nothing', async () => {
    await t.db.insert(profiles).values({ id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR });
    expect((await patch(SEAT_A, { action: 'ban', reason: 'Portal abuse' })).status).toBe(200);
    for (const row of (await licenseRows()).values()) {
      expect(row.cancelAtTermEnd).toBe(false);
      expect(row.cancelReason).toBeNull();
    }
    expect(await licenseAudits()).toEqual([]);
  });

  it('the last-seat ban flags every live license, any source, in the ban batch; ends nothing', async () => {
    const batch = vi.spyOn(t.db, 'batch');
    expect((await patch(SEAT_A, { action: 'ban', reason: 'Portal abuse' })).status).toBe(200);
    expect(batch).toHaveBeenCalledTimes(1);

    const rows = await licenseRows();
    for (const id of [assigned, invoice, stripe]) {
      expect(rows.get(id)).toMatchObject({
        cancelAtTermEnd: true,
        cancelReason: 'vendor-banned',
        endedAt: null,
        endReason: null,
      });
    }
    // The ended license is history: untouched.
    expect(rows.get(ended)).toMatchObject({
      cancelAtTermEnd: false,
      cancelReason: null,
      endedAt: ENDED_AT,
    });
    // No plan change: the vendor stays verified.
    const [vendor] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(vendor!.verified).toBe(true);

    const account = await seedBillingAccount(t.db, VENDOR);
    const audits = await licenseAudits();
    expect(audits).toHaveLength(3);
    for (const a of audits) {
      expect(a).toMatchObject({
        action: 'license.cancel_at_term_end_set',
        entityType: 'billing_account',
        entityId: account,
        vendorId: VENDOR,
      });
    }
    expect(audits.map((a) => (a.metadata as { license_id: string }).license_id).sort()).toEqual(
      [assigned, invoice, stripe].sort(),
    );
  });

  it('a lost seat race rolls the flags back with the ban (409)', async () => {
    const original = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
      await t.db.insert(profiles).values({ id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR });
      return original(stmts);
    }) as never);
    expect((await patch(SEAT_A, { action: 'ban', reason: 'Portal abuse' })).status).toBe(409);
    for (const row of (await licenseRows()).values()) expect(row.cancelAtTermEnd).toBe(false);
    expect(await licenseAudits()).toEqual([]);
  });

  it('keeps a cancel flag someone else set, and the unban leaves it in place', async () => {
    await t.db
      .update(licenses)
      .set({ cancelAtTermEnd: true, cancelReason: null })
      .where(eq(licenses.id, invoice));

    await patch(SEAT_A, { action: 'ban', reason: 'Portal abuse' });
    expect((await licenseRows()).get(invoice)).toMatchObject({
      cancelAtTermEnd: true,
      cancelReason: null,
    });

    expect((await patch(SEAT_A, { action: 'unban' })).status).toBe(200);
    const rows = await licenseRows();
    expect(rows.get(invoice)).toMatchObject({ cancelAtTermEnd: true, cancelReason: null });
    for (const id of [assigned, stripe]) {
      expect(rows.get(id)).toMatchObject({ cancelAtTermEnd: false, cancelReason: null });
    }
  });

  it('the unban clears only vendor-banned flags, on live licenses', async () => {
    await patch(SEAT_A, { action: 'ban', reason: 'Portal abuse' });
    // An ended license that still carries the reason is history: the unban skips it.
    await t.db
      .update(licenses)
      .set({ cancelAtTermEnd: true, cancelReason: 'vendor-banned' })
      .where(eq(licenses.id, ended));

    expect((await patch(SEAT_A, { action: 'unban' })).status).toBe(200);
    const rows = await licenseRows();
    for (const id of [assigned, invoice, stripe]) {
      expect(rows.get(id)).toMatchObject({ cancelAtTermEnd: false, cancelReason: null });
    }
    expect(rows.get(ended)).toMatchObject({ cancelAtTermEnd: true, cancelReason: 'vendor-banned' });
    const cleared = (await licenseAudits()).filter(
      (a) => a.action === 'license.cancel_at_term_end_cleared',
    );
    expect(cleared).toHaveLength(3);
  });

  it('a reviewer ban reads and writes no license', async () => {
    await t.db.insert(profiles).values({ id: u(1) });
    expect((await patch(u(1), { action: 'ban', reason: 'Repeated spam reviews.' })).status).toBe(
      200,
    );
    for (const row of (await licenseRows()).values()) expect(row.cancelAtTermEnd).toBe(false);
  });
});

describe('GET /api/admin/reviewers', () => {
  it('lists the currently-banned reviewers', async () => {
    await t.db.insert(profiles).values([
      { id: u(1), bannedAt: '2026-01-02T00:00:00.000Z', banReason: 'a' },
      { id: u(2) }, // not banned
    ]);
    const res = await listApp().request(
      '/api/admin/reviewers',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    const body = (await res.json()) as { total: number; data: Array<{ reviewer_id: string }> };
    expect(body.total).toBe(1);
    expect(body.data[0]!.reviewer_id).toBe(u(1));
  });
});
