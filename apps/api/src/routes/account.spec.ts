/**
 * GET / PATCH / DELETE /api/account on the Drizzle/D1 path (ADR 0016 / AECI-253,
 * AECI-254), against the in-memory D1 harness. DELETE asserts the atomic erasure
 * batch (null inbound refs + audit + delete profile) and the injected seam-#3
 * auth-user delete.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, products, profiles, reviews, vendorEntitlements, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { sendAccountDeletionEmail } from '../lib/email';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import {
  createDeleteAccountHandler,
  createGetAccountHandler,
  createUpdateAccountHandler,
} from './account';

// The §11.1 deletion confirmation is fire-and-forget; mock it so we can assert it
// fires to the captured pre-erasure email without a real Resend call.
vi.mock('../lib/email', () => ({
  sendAccountDeletionEmail: vi.fn(() => Promise.resolve('sent')),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = u(900);
const ADMIN_USER = u(901);

let t: TestDb;
beforeEach(async () => {
  vi.mocked(sendAccountDeletionEmail).mockClear();
  t = await makeTestDb();
});
afterEach(() => t.dispose());

type Handler = Parameters<typeof appFor>[0];
function appFor(
  handler: (c: never) => Promise<Response>,
  method: 'get' | 'patch' | 'delete',
  role: 'reviewer' | 'admin' = 'reviewer',
) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    // Stands in for `requireAuth()`, which re-reads the role from D1 every
    // request (`lib/authz.ts` / AUTH_AND_RLS §4.5) — so `session.role` here is
    // the same DB-derived value the handler gates `pending_reviews` on.
    // `vendorId` is part of the same DB-derived session since AECI-520.
    c.set(
      'auth',
      role === 'admin'
        ? {
            userId: ADMIN_USER,
            email: 'root@example.com',
            role: 'admin',
            vendorId: null,
            entitlementTier: 'unclaimed',
            entitlement: null,
          }
        : {
            userId: USER,
            email: 'me@example.com',
            role: 'reviewer',
            vendorId: null,
            entitlementTier: 'unclaimed',
            entitlement: null,
          },
    );
    await next();
  });
  a.on(method.toUpperCase(), '/api/account', handler as never);
  return a;
}
const runAs = (
  handler: Handler,
  method: 'get' | 'patch' | 'delete',
  role: 'reviewer' | 'admin',
  body?: unknown,
) =>
  appFor(handler, method, role).request(
    '/api/account',
    {
      method: method.toUpperCase(),
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
        : {}),
    },
    TEST_ENV,
    fakeExecutionContext(),
  );
const run = (handler: Handler, method: 'get' | 'patch' | 'delete', body?: unknown) =>
  runAs(handler, method, 'reviewer', body);

/** Seed `n` pending reviews (plus the reviewer + one product each — `reviews` is
 *  UNIQUE on `(product_id, reviewer_id)`) so the admin badge count has something
 *  to count. */
async function seedPendingReviews(n: number): Promise<void> {
  await t.db.insert(profiles).values({ id: USER, displayName: 'Ada' });
  for (let i = 0; i < n; i++) {
    await t.db
      .insert(products)
      .values({ id: u(1 + i), slug: `p${i}`, name: `P${i}`, promotionStatus: 'promoted' });
    await t.db.insert(reviews).values({
      id: u(20 + i),
      productId: u(1 + i),
      reviewerId: USER,
      ratingOverall: 4,
      ratingOnboarding: 4,
      title: `T${i}`,
      body: 'B',
      status: 'pending',
    });
  }
}

describe('GET /api/account', () => {
  it('returns the session identity + display_name', async () => {
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada' });
    const res = await run(createGetAccountHandler(t.factory), 'get');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user_id: USER,
      email: 'me@example.com',
      display_name: 'Ada',
      role: 'reviewer',
      // Non-admin → null, and the reviews table is never counted (AECI-617).
      pending_reviews: null,
    });
  });

  // AECI-617: the badge count rides along with the role so the header's admin
  // probe resolves both in one round trip instead of chaining
  // `GET /api/admin/summary`.
  it('returns the pending-review count for an admin', async () => {
    await t.db.insert(profiles).values({ id: ADMIN_USER, displayName: 'Root', role: 'admin' });
    await seedPendingReviews(2);

    const res = await runAs(createGetAccountHandler(t.factory), 'get', 'admin');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: 'admin', pending_reviews: 2 });
  });

  it('returns 0 pending reviews for an admin with an empty queue', async () => {
    await t.db.insert(profiles).values({ id: ADMIN_USER, displayName: 'Root', role: 'admin' });
    const res = await runAs(createGetAccountHandler(t.factory), 'get', 'admin');
    expect(await res.json()).toMatchObject({ role: 'admin', pending_reviews: 0 });
  });
});

describe('PATCH /api/account', () => {
  it('updates display_name and writes a profile.updated audit', async () => {
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada' });
    const res = await run(createUpdateAccountHandler(t.factory), 'patch', {
      display_name: 'Ada L.',
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { display_name: string }).toMatchObject({
      display_name: 'Ada L.',
    });

    const [row] = await t.db.select().from(profiles);
    expect(row!.displayName).toBe('Ada L.');
    const audit = await t.db.select().from(auditLog);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('profile.updated');
  });
});

describe('DELETE /api/account', () => {
  it('erases the profile, anonymizes refs, audits, and deletes the auth user', async () => {
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada' });
    await t.db
      .insert(products)
      .values({ id: u(1), slug: 'p', name: 'P', promotionStatus: 'promoted' });
    await t.db.insert(reviews).values({
      id: u(11),
      productId: u(1),
      reviewerId: USER,
      ratingOverall: 5,
      ratingOnboarding: 4,
      title: 'T',
      body: 'B',
      reviewerFirm: 'Acme Architects',
      status: 'approved',
    });

    const deleteAuthUser = vi.fn(async () => ({ ok: true }));
    const res = await run(createDeleteAccountHandler(t.factory, deleteAuthUser), 'delete');
    expect(res.status).toBe(200);

    // Profile gone; review survives but is anonymized — `reviewer_id` nulled AND
    // `anonymized_at` stamped in the same batch (the §23.1 / AECI-241 invariant).
    // The free-text `reviewer_firm` is cleared too (AECI-284 — more identifying
    // than the generic role enum, so it is erased).
    expect(await t.db.select().from(profiles)).toHaveLength(0);
    const [review] = await t.db.select().from(reviews);
    expect(review!.reviewerId).toBeNull();
    expect(review!.anonymizedAt).not.toBeNull();
    expect(review!.reviewerFirm).toBeNull();

    // account.deleted audit written with a null actor.
    const audit = await t.db.select().from(auditLog);
    const deletion = audit.find((a) => a.action === 'account.deleted');
    expect(deletion).toBeDefined();
    expect(deletion!.actorId).toBeNull();

    // Seam #3 invoked with the user id.
    expect(deleteAuthUser).toHaveBeenCalledWith(expect.anything(), USER);

    // §11.1: the deletion confirmation fires to the email captured pre-erasure.
    expect(sendAccountDeletionEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: 'me@example.com' }),
    );
  });

  it('declares vendor_entitlements.granted_by ON DELETE SET NULL (AECI-609 / R6)', () => {
    // This is what actually keeps erasure working. `granted_by` is one of the eight
    // inbound FKs to `profiles(id)` (`AUTH_AND_RLS.md` §8 is the live register); the
    // five NO ACTION refs are each nulled by hand in the
    // batch, and if this one were left at the house default it would join them — except
    // nobody would notice until an admin who had granted an entitlement tried to delete
    // their account, at which point the whole batch FK-fails. Silent, delayed, and
    // GDPR-relevant. Asserted at the schema level because the behavioural test below
    // passes either way (SET NULL and the explicit statement produce the same end
    // state), so only this assertion fails if the `onDelete` is dropped.
    const fks = t.raw
      .prepare(
        "SELECT `table`, `from`, on_delete FROM pragma_foreign_key_list('vendor_entitlements')",
      )
      .all() as Array<{ table: string; from: string; on_delete: string }>;
    const grantedBy = fks.find((f) => f.from === 'granted_by');
    expect(grantedBy, 'vendor_entitlements.granted_by has no FK to profiles').toBeDefined();
    expect(grantedBy!.table).toBe('profiles');
    expect(grantedBy!.on_delete).toBe('SET NULL');
  });

  it('nulls vendor_entitlements.granted_by without destroying the entitlement (AECI-609 / R6)', async () => {
    // The harness runs with `foreign_keys = ON`, so this exercises the real cascade.
    // The batch also nulls the column explicitly — belt-and-braces, matching the
    // `reviews.reviewer_id` precedent (also SET NULL, also nulled by hand).
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada', role: 'admin' });
    await t.db.insert(vendors).values({ id: u(2), slug: 'autodesk', companyName: 'Autodesk' });
    await t.db.insert(vendorEntitlements).values({
      id: u(21),
      vendorId: u(2),
      tier: 'verified',
      status: 'active',
      grantedBy: USER,
      grantedAt: '2026-01-01T00:00:00.000Z',
    });

    const res = await run(
      createDeleteAccountHandler(
        t.factory,
        vi.fn(async () => ({ ok: true })),
      ),
      'delete',
    );
    expect(res.status).toBe(200);

    // The batch committed — the profile is gone rather than FK-blocked.
    expect(await t.db.select().from(profiles)).toHaveLength(0);

    // The entitlement ROW survives; only the granting admin's link is severed.
    const [ent] = await t.db.select().from(vendorEntitlements);
    expect(ent).toBeDefined();
    expect(ent!.grantedBy).toBeNull();
    expect(ent!.status).toBe('active');
  });

  it('still succeeds (data erased) when the auth-user delete fails', async () => {
    await t.db.insert(profiles).values({ id: USER });
    const deleteAuthUser = vi.fn(async () => ({ ok: false, status: 500, error: 'boom' }));
    const res = await run(createDeleteAccountHandler(t.factory, deleteAuthUser), 'delete');
    expect(res.status).toBe(200);
    expect(await t.db.select().from(profiles)).toHaveLength(0);
  });
});
