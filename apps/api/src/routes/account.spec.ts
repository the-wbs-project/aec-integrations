/**
 * GET / PATCH / DELETE /api/account on the Drizzle/D1 path (ADR 0016 / AECI-253,
 * AECI-254), against the in-memory D1 harness. DELETE asserts the atomic erasure
 * batch (null inbound refs + audit + delete profile) and the injected seam-#3
 * auth-user delete.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  billingAccounts,
  feedback,
  integrationFieldChallenges,
  integrations,
  licenseReleaseRequests,
  licenses,
  listingRequests,
  mailingList,
  productProposals,
  products,
  profileAudiences,
  profileDetails,
  profiles,
  requestConfirmations,
  reviewResponses,
  reviews,
  taxonomyAudiences,
  userActivityDaily,
  vendorRequests,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { sendAccountDeletionEmail } from '../lib/email';
import { logToPosthog, submitCount } from '../posthog';
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

// AECI-531: the erasure's seam-#3 outcome is a log and a metric. Spy on both;
// everything else in the module keeps its real implementation.
vi.mock('../posthog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../posthog')>()),
  logToPosthog: vi.fn(),
  submitCount: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = u(900);
const ADMIN_USER = u(901);

let t: TestDb;
beforeEach(async () => {
  vi.mocked(sendAccountDeletionEmail).mockClear();
  vi.mocked(logToPosthog).mockClear();
  vi.mocked(submitCount).mockClear();
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
  env: Env = TEST_ENV,
) =>
  appFor(handler, method, role).request(
    '/api/account',
    {
      method: method.toUpperCase(),
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
        : {}),
    },
    env,
    fakeExecutionContext(),
  );
const run = (handler: Handler, method: 'get' | 'patch' | 'delete', body?: unknown) =>
  runAs(handler, method, 'reviewer', body);
/** Only production deletes the shared `auth.users` row on erasure (AECI-1468). */
const PROD_ENV: Env = { ...TEST_ENV, ENV: 'production' };
const runInProd = (handler: Handler, method: 'get' | 'patch' | 'delete') =>
  runAs(handler, method, 'reviewer', undefined, PROD_ENV);

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
      listing_view_preference: null,
      role: 'reviewer',
      // Non-admin → null on all three, and neither table is ever counted
      // (AECI-617, widened to three queues by AECI-922). All three keys are
      // PRESENT and null: a consumer must never have to tell `undefined` from
      // "you are not an operator".
      pending_reviews: null,
      pending_requests: null,
      pending_claims: null,
      pending_reindex: null,
      pending_contests: null,
      pending_review_responses: null,
      // AECI-1296: no `profile_details` row yet → all-null answers, pending.
      details: {
        company_type: null,
        company_size: null,
        primary_role: null,
        firm_name: null,
        linkedin_url: null,
        audience_ids: [],
      },
      onboarding: 'pending',
      suggested_display_name: null,
    });
  });

  it('returns a remembered listing_view_preference when one is stored', async () => {
    await t.db
      .insert(profiles)
      .values({ id: USER, displayName: 'Ada', listingViewPreference: 'table' });
    const res = await run(createGetAccountHandler(t.factory), 'get');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ listing_view_preference: 'table' });
  });

  // AECI-617: the badge counts ride along with the role so the header's admin
  // probe resolves both in one round trip instead of chaining
  // `GET /api/admin/summary`. AECI-922 widened that from one count to three,
  // because the header badge now shows the same SUM the console's Operations
  // trigger does.
  it('returns all three queue counts for an admin', async () => {
    await t.db.insert(profiles).values({ id: ADMIN_USER, displayName: 'Root', role: 'admin' });
    await seedPendingReviews(2);
    await t.db
      .insert(vendorRequests)
      .values([
        req(31, 'correction', 'open'),
        req(32, 'claim', 'open'),
        req(33, 'claim', 'open'),
        req(34, 'claim', 'resolved'),
      ]);

    const res = await runAs(createGetAccountHandler(t.factory), 'get', 'admin');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      role: 'admin',
      pending_reviews: 2,
      // Corrections and claims are ONE table split by `kind`. The header sums
      // these three, so a requests count that swallowed claims would report 6.
      pending_requests: 1,
      pending_claims: 2,
      pending_reindex: 0,
    });
  });

  it('returns 0 on every queue for an admin with nothing waiting', async () => {
    await t.db.insert(profiles).values({ id: ADMIN_USER, displayName: 'Root', role: 'admin' });
    const res = await runAs(createGetAccountHandler(t.factory), 'get', 'admin');
    expect(await res.json()).toMatchObject({
      role: 'admin',
      pending_reviews: 0,
      pending_requests: 0,
      pending_claims: 0,
      pending_reindex: 0,
      pending_contests: 0,
      pending_review_responses: 0,
    });
  });
});

/** A `vendor_requests` row with only the columns the queue counts key off. The
 *  target is `u(1)`, which `seedPendingReviews` creates. */
function req(n: number, kind: 'claim' | 'correction', status: string) {
  return {
    id: u(n),
    kind,
    status,
    targetType: 'product',
    targetId: u(1),
    submitterEmail: `s${n}@example.com`,
    body: 'b',
  };
}

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

  // An explicit `null` is the schema's documented way to CLEAR the name, and the
  // response must report the cleared row — not the pre-PATCH name. A `??` in the
  // response builder treats `null` as "key absent" and echoes the old value.
  it('clears display_name on an explicit null and reports the cleared value', async () => {
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada' });
    const res = await run(createUpdateAccountHandler(t.factory), 'patch', {
      display_name: null,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ display_name: null });
    const [row] = await t.db.select().from(profiles);
    expect(row!.displayName).toBeNull();
  });

  it('persists listing_view_preference alone without touching display_name', async () => {
    await t.db
      .insert(profiles)
      .values({ id: USER, displayName: 'Ada', listingViewPreference: null });

    const res = await run(createUpdateAccountHandler(t.factory), 'patch', {
      listing_view_preference: 'table',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      display_name: 'Ada',
      listing_view_preference: 'table',
    });

    const [row] = await t.db.select().from(profiles);
    expect(row!.listingViewPreference).toBe('table');
    // Present-key semantics: an untouched field keeps its value.
    expect(row!.displayName).toBe('Ada');

    // The audit mirrors ONLY the touched key — a toggle click must not log a
    // no-op display_name change it never made.
    const [audit] = await t.db.select().from(auditLog);
    expect(audit).toBeDefined();
    const asRecord = (v: unknown): Record<string, unknown> =>
      typeof v === 'string'
        ? (JSON.parse(v) as Record<string, unknown>)
        : (v as Record<string, unknown>);
    expect(asRecord(audit!.beforeState)).toEqual({ listing_view_preference: null });
    expect(asRecord(audit!.afterState)).toEqual({ listing_view_preference: 'table' });
  });

  it('clears listing_view_preference back to null (explicit)', async () => {
    await t.db
      .insert(profiles)
      .values({ id: USER, displayName: 'Ada', listingViewPreference: 'table' });
    const res = await run(createUpdateAccountHandler(t.factory), 'patch', {
      listing_view_preference: null,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ listing_view_preference: null });
    const [row] = await t.db.select().from(profiles);
    expect(row!.listingViewPreference).toBeNull();
  });

  it('rejects a PATCH that carries no updatable field', async () => {
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada' });
    const res = await run(createUpdateAccountHandler(t.factory), 'patch', {});
    expect(res.status).toBe(400);
    expect(await t.db.select().from(profiles)).toHaveLength(1);
  });

  it('rejects an out-of-vocabulary listing_view_preference', async () => {
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada' });
    const res = await run(createUpdateAccountHandler(t.factory), 'patch', {
      listing_view_preference: 'grid',
    });
    expect(res.status).toBe(400);
    const [row] = await t.db.select().from(profiles);
    expect(row!.listingViewPreference).toBeNull();
  });
});

describe('DELETE /api/account', () => {
  it("deletes the user's user_activity_daily rows in the erasure batch (AECI-1208)", async () => {
    await t.db.insert(profiles).values([{ id: USER }, { id: ADMIN_USER }]);
    const row = (userId: string, day: string) => ({
      userId,
      day,
      role: 'reviewer',
      firstSeenAt: `${day}T10:00:00.000Z`,
      lastSeenAt: `${day}T10:00:00.000Z`,
    });
    await t.db
      .insert(userActivityDaily)
      .values([row(USER, '2026-10-01'), row(USER, '2026-10-02'), row(ADMIN_USER, '2026-10-02')]);

    const res = await run(
      createDeleteAccountHandler(
        t.factory,
        vi.fn(async () => ({ ok: true })),
      ),
      'delete',
    );

    expect(res.status).toBe(200);
    const left = await t.db.select().from(userActivityDaily);
    expect(left.map((r) => r.userId)).toEqual([ADMIN_USER]);
  });

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
    const res = await runInProd(createDeleteAccountHandler(t.factory, deleteAuthUser), 'delete');
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

  it('erases an admin who granted a license and nulls licenses.granted_by (AECI-1358)', async () => {
    // The license replaced the entitlement row as the record of an admin grant, so
    // erasing that admin must still succeed. `licenses.granted_by` has no FK, so the
    // explicit statement in the batch is the only thing that clears it. The license
    // survives with its state: it is the vendor's commercial record.
    const STAMP = '2026-01-01T00:00:00.000Z';
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada', role: 'admin' });
    await t.db.insert(vendors).values({ id: u(2), slug: 'autodesk', companyName: 'Autodesk' });
    await t.db.insert(billingAccounts).values({ id: u(30), vendorId: u(2), name: 'Autodesk' });
    await t.db.insert(licenses).values({
      id: u(31),
      billingAccountId: u(30),
      source: 'invoice',
      startsAt: STAMP,
      grantedBy: USER,
    });

    const res = await run(
      createDeleteAccountHandler(
        t.factory,
        vi.fn(async () => ({ ok: true })),
      ),
      'delete',
    );
    expect(res.status).toBe(200);

    // The batch committed: the profile is gone rather than blocked.
    expect(await t.db.select().from(profiles)).toHaveLength(0);
    const [license] = await t.db.select().from(licenses);
    expect(license).toMatchObject({ id: u(31), grantedBy: null, endedAt: null });
  });

  it('nulls billing_accounts.created_by and licenses.granted_by, keeping both rows (AECI-1350)', async () => {
    // Neither column has an FK to `profiles`, so SQLite would leave the erased id in
    // place and the profile delete would still succeed. Only the explicit statements
    // in the erasure batch clear them. `updated_at` must not move: an erasure is not
    // a commercial change.
    const STAMP = '2026-01-01T00:00:00.000Z';
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada', role: 'admin' });
    await t.db.insert(vendors).values({ id: u(2), slug: 'autodesk', companyName: 'Autodesk' });
    await t.db.insert(billingAccounts).values({
      id: u(30),
      vendorId: u(2),
      name: 'Autodesk',
      createdBy: USER,
      createdAt: STAMP,
      updatedAt: STAMP,
    });
    await t.db.insert(licenses).values({
      id: u(31),
      billingAccountId: u(30),
      source: 'invoice',
      startsAt: STAMP,
      grantedBy: USER,
      createdAt: STAMP,
      updatedAt: STAMP,
    });
    // Someone else's grant is left alone.
    await t.db.insert(licenses).values({
      id: u(32),
      billingAccountId: u(30),
      source: 'complimentary',
      startsAt: STAMP,
      grantedBy: ADMIN_USER,
      createdAt: STAMP,
      updatedAt: STAMP,
    });

    const res = await run(
      createDeleteAccountHandler(
        t.factory,
        vi.fn(async () => ({ ok: true })),
      ),
      'delete',
    );
    expect(res.status).toBe(200);
    expect(await t.db.select().from(profiles)).toHaveLength(0);

    const [account] = await t.db.select().from(billingAccounts);
    expect(account).toMatchObject({ id: u(30), createdBy: null, updatedAt: STAMP });
    const rows = await t.db.select().from(licenses).orderBy(licenses.id);
    expect(rows.map((r) => [r.id, r.grantedBy, r.updatedAt, r.endedAt])).toEqual([
      [u(31), null, STAMP, null],
      [u(32), ADMIN_USER, STAMP, null],
    ]);
  });

  it('nulls a billing_email equal to the erased address and leaves others alone (AECI-1389)', async () => {
    // The session email is `me@example.com`. A matching address on ANY vendor's
    // account is nulled, case-insensitively; a different one is untouched. The
    // accounts survive and `updated_at` does not move.
    const STAMP = '2026-01-01T00:00:00.000Z';
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada' });
    await t.db.insert(vendors).values([
      { id: u(2), slug: 'autodesk', companyName: 'Autodesk' },
      { id: u(3), slug: 'bentley', companyName: 'Bentley' },
      { id: u(4), slug: 'trimble', companyName: 'Trimble' },
    ]);
    await t.db.insert(billingAccounts).values([
      { id: u(40), vendorId: u(2), name: 'A', billingEmail: 'me@example.com', updatedAt: STAMP },
      { id: u(41), vendorId: u(3), name: 'B', billingEmail: 'ME@Example.com', updatedAt: STAMP },
      { id: u(42), vendorId: u(4), name: 'T', billingEmail: 'ap@trimble.com', updatedAt: STAMP },
    ]);

    const res = await run(
      createDeleteAccountHandler(
        t.factory,
        vi.fn(async () => ({ ok: true })),
      ),
      'delete',
    );
    expect(res.status).toBe(200);

    const rows = await t.db.select().from(billingAccounts).orderBy(billingAccounts.id);
    expect(rows.map((r) => [r.id, r.billingEmail, r.updatedAt])).toEqual([
      [u(40), null, STAMP],
      [u(41), null, STAMP],
      [u(42), 'ap@trimble.com', STAMP],
    ]);
  });

  it('deletes the pending claim confirmations of the erased address, and no others (AECI-1435)', async () => {
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada' });
    const pending = (id: string, email: string) => ({
      id,
      kind: 'claim',
      tokenHash: `hash-${id}`,
      submitterEmail: email,
      payload: '{}',
      termsVersion: '1.0',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    await t.db
      .insert(requestConfirmations)
      .values([pending(u(50), 'me@example.com'), pending(u(51), 'other@example.com')]);

    const res = await run(
      createDeleteAccountHandler(
        t.factory,
        vi.fn(async () => ({ ok: true })),
      ),
      'delete',
    );
    expect(res.status).toBe(200);
    const rows = await t.db.select().from(requestConfirmations);
    expect(rows.map((r) => r.id)).toEqual([u(51)]);
  });

  it('nulls found_via_detail on all four tables for the erased address, keeping found_via (AECI-1063)', async () => {
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada' });
    await t.db.insert(vendors).values({ id: u(2), slug: 'autodesk', companyName: 'Autodesk' });
    const answer = { foundVia: 'ai_tool', foundViaDetail: 'my prompt' };
    await t.db.insert(mailingList).values([
      { email: 'Me@Example.com', ...answer },
      { email: 'other@example.com', ...answer },
    ]);
    await t.db.insert(feedback).values([
      { tools: 'x', email: 'me@example.com', ...answer },
      { tools: 'x', email: null, ...answer },
    ]);
    const claim = (id: string, email: string) => ({
      id,
      kind: 'claim',
      targetType: 'vendor',
      targetId: u(2),
      submitterEmail: email,
      body: '',
      ...answer,
    });
    await t.db
      .insert(vendorRequests)
      .values([claim(u(60), 'ME@example.com'), claim(u(61), 'other@example.com')]);
    const listing = (id: string, email: string) => ({
      id,
      listingName: 'L',
      website: 'https://l.example.com',
      submitterEmail: email,
      ...answer,
    });
    await t.db
      .insert(listingRequests)
      .values([listing(u(62), 'me@example.com'), listing(u(63), 'other@example.com')]);

    const batch = vi.spyOn(t.db, 'batch');
    const res = await run(
      createDeleteAccountHandler(
        t.factory,
        vi.fn(async () => ({ ok: true })),
      ),
      'delete',
    );
    expect(res.status).toBe(200);
    // One atomic erasure batch, these four statements inside it.
    expect(batch).toHaveBeenCalledTimes(1);

    const pairs = (rows: { foundVia: string | null; foundViaDetail: string | null }[]) =>
      rows.map((r) => [r.foundVia, r.foundViaDetail]);
    const kept = ['ai_tool', 'my prompt'];
    const erased = ['ai_tool', null];
    expect(pairs(await t.db.select().from(mailingList).orderBy(mailingList.id))).toEqual([
      erased,
      kept,
    ]);
    expect(pairs(await t.db.select().from(feedback).orderBy(feedback.id))).toEqual([erased, kept]);
    expect(pairs(await t.db.select().from(vendorRequests).orderBy(vendorRequests.id))).toEqual([
      erased,
      kept,
    ]);
    expect(pairs(await t.db.select().from(listingRequests).orderBy(listingRequests.id))).toEqual([
      erased,
      kept,
    ]);
  });

  it('nulls license_release_requests.requested_by and decided_by, keeping the rows (AECI-1373)', async () => {
    const STAMP = '2026-01-01T00:00:00.000Z';
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada', role: 'admin' });
    await t.db.insert(vendors).values({ id: u(2), slug: 'autodesk', companyName: 'Autodesk' });
    await t.db.insert(billingAccounts).values({
      id: u(30),
      vendorId: u(2),
      name: 'Autodesk',
      createdAt: STAMP,
      updatedAt: STAMP,
    });
    await t.db.insert(licenses).values({
      id: u(31),
      billingAccountId: u(30),
      source: 'invoice',
      startsAt: STAMP,
      createdAt: STAMP,
      updatedAt: STAMP,
    });
    const base = {
      licenseId: u(31),
      vendorId: u(2),
      billingAccountId: u(30),
      reason: 'Retired',
      createdAt: STAMP,
      updatedAt: STAMP,
    };
    await t.db.insert(licenseReleaseRequests).values([
      { ...base, id: u(40), requestedBy: USER, status: 'declined', decidedBy: ADMIN_USER },
      { ...base, id: u(41), requestedBy: ADMIN_USER, status: 'approved', decidedBy: USER },
    ]);

    const res = await run(
      createDeleteAccountHandler(
        t.factory,
        vi.fn(async () => ({ ok: true })),
      ),
      'delete',
    );
    expect(res.status).toBe(200);
    const rows = await t.db
      .select()
      .from(licenseReleaseRequests)
      .orderBy(licenseReleaseRequests.id);
    expect(rows.map((r) => [r.id, r.requestedBy, r.decidedBy, r.updatedAt])).toEqual([
      [u(40), null, ADMIN_USER, STAMP],
      [u(41), ADMIN_USER, null, STAMP],
    ]);
  });

  it('nulls product_proposals.decided_by, keeping the proposal and its payload (AECI-1416)', async () => {
    const STAMP = '2026-01-01T00:00:00.000Z';
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada', role: 'vendor_admin' });
    await t.db.insert(vendors).values({ id: u(2), slug: 'autodesk', companyName: 'Autodesk' });
    const base = {
      vendorId: u(2),
      payload: { ref: 'p:rec1', name: 'OpenRoads' },
      proposedAt: STAMP,
      decidedAt: STAMP,
      createdAt: STAMP,
      updatedAt: STAMP,
    };
    await t.db.insert(productProposals).values([
      { ...base, id: u(50), ref: 'p:rec1', decision: 'declined', decidedBy: USER },
      { ...base, id: u(51), ref: 'p:rec2', decision: 'accepted', decidedBy: ADMIN_USER },
    ]);

    const res = await run(
      createDeleteAccountHandler(
        t.factory,
        vi.fn(async () => ({ ok: true })),
      ),
      'delete',
    );
    expect(res.status).toBe(200);
    const rows = await t.db.select().from(productProposals).orderBy(productProposals.id);
    expect(rows.map((r) => [r.id, r.decision, r.decidedBy, r.updatedAt, r.payload])).toEqual([
      [u(50), 'declined', null, STAMP, base.payload],
      [u(51), 'accepted', ADMIN_USER, STAMP, base.payload],
    ]);
  });

  it('nulls the contest submitted_by / decided_by without deleting the contest (AECI-1008)', async () => {
    // Two more of the sixteen inbound FKs. The contest is the VENDOR's record, so it
    // survives; only the person who filed or decided it is severed.
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada', role: 'vendor_admin' });
    await t.db.insert(vendors).values({ id: u(2), slug: 'autodesk', companyName: 'Autodesk' });
    await t.db.insert(products).values([
      { id: u(3), slug: 'a', name: 'A' },
      { id: u(4), slug: 'b', name: 'B' },
    ]);
    await t.db
      .insert(integrations)
      .values({ id: u(5), sourceProductId: u(3), targetProductId: u(4) });
    await t.db.insert(integrationFieldChallenges).values({
      id: u(6),
      integrationId: u(5),
      field: 'name',
      proposedValue: 'New',
      reason: 'r',
      submitterVendorId: u(2),
      submittedBy: USER,
      decidedBy: USER,
      routedTo: 'aeci',
      status: 'declined',
    });

    const res = await run(
      createDeleteAccountHandler(
        t.factory,
        vi.fn(async () => ({ ok: true })),
      ),
      'delete',
    );
    expect(res.status).toBe(200);
    expect(await t.db.select().from(profiles)).toHaveLength(0);
    const [contest] = await t.db.select().from(integrationFieldChallenges);
    expect(contest).toMatchObject({ submittedBy: null, decidedBy: null, status: 'declined' });
  });

  it('nulls review_responses.author_profile_id / moderated_by and keeps the reply (AECI-1175)', async () => {
    // Two more inbound FKs (sixteen in all). The reply is the VENDOR's record, so it
    // survives; only the seat that wrote it and the admin who decided it are severed.
    // `updated_at` must not move: on a pending reply it is the queue age.
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada', role: 'vendor_admin' });
    await t.db.insert(vendors).values({ id: u(2), slug: 'autodesk', companyName: 'Autodesk' });
    await t.db.insert(products).values({ id: u(3), slug: 'a', name: 'A' });
    await t.db.insert(reviews).values({
      id: u(4),
      productId: u(3),
      ratingOverall: 4,
      ratingOnboarding: 4,
      title: 't',
      body: 'b',
      status: 'approved',
    });
    const STAMP = '2026-09-01T00:00:00.000Z';
    await t.db.insert(reviewResponses).values({
      id: u(5),
      reviewId: u(4),
      vendorId: u(2),
      authorProfileId: USER,
      moderatedBy: USER,
      body: 'Thanks',
      status: 'published',
      createdAt: STAMP,
      updatedAt: STAMP,
    });

    const res = await run(
      createDeleteAccountHandler(
        t.factory,
        vi.fn(async () => ({ ok: true })),
      ),
      'delete',
    );
    expect(res.status).toBe(200);
    expect(await t.db.select().from(profiles)).toHaveLength(0);
    const [reply] = await t.db.select().from(reviewResponses);
    expect(reply).toMatchObject({
      authorProfileId: null,
      moderatedBy: null,
      status: 'published',
      body: 'Thanks',
      updatedAt: STAMP,
    });
  });

  it('pins the inbound FKs to profiles(id) at nineteen — AUTH_AND_RLS.md §8 is the register', () => {
    // A new FK to `profiles` must be nulled in the erasure batch (or be SET NULL and
    // nulled explicitly) and added to the §8 table. This count fails first, so the
    // person adding the column is sent to both places.
    const rows = t.raw
      .prepare(
        `SELECT m.name AS tbl, f."from" AS col FROM sqlite_master m,
                pragma_foreign_key_list(m.name) f
          WHERE m.type = 'table' AND f."table" = 'profiles'
          ORDER BY m.name, f."from"`,
      )
      .all() as Array<{ tbl: string; col: string }>;
    expect(rows.map((r) => `${r.tbl}.${r.col}`)).toEqual([
      'audit_log.actor_id',
      // AECI-1534 (0098). SET NULL today. The explicit erasure null is AECI-1536 (§15.5).
      'claim_thread_messages.author_profile_id',
      // CASCADE: a read marker goes with its person.
      'claim_thread_reads.profile_id',
      'integration_field_challenges.decided_by',
      'integration_field_challenges.protest_decided_by',
      'integration_field_challenges.protest_replied_by',
      'integration_field_challenges.protested_by',
      'integration_field_challenges.submitted_by',
      'notification_preferences.profile_id',
      'profile_audiences.profile_id',
      'profile_details.profile_id',
      'review_responses.author_profile_id',
      'review_responses.moderated_by',
      'reviews.moderated_by',
      'reviews.reviewer_id',
      'vendor_requests.resolved_by',
      'vendor_seat_invites.invited_by_id',
      'workflow_instances.initiated_by',
      'workflow_transitions.actor_id',
    ]);
  });

  it('still succeeds (data erased) when the auth-user delete fails', async () => {
    await t.db.insert(profiles).values({ id: USER });
    const deleteAuthUser = vi.fn(async () => ({ ok: false, status: 500, error: 'boom' }));
    const res = await runInProd(createDeleteAccountHandler(t.factory, deleteAuthUser), 'delete');
    expect(res.status).toBe(200);
    expect(await t.db.select().from(profiles)).toHaveLength(0);
  });

  // AECI-531: a skipped or failed auth delete leaves the sign-in identity behind
  // after the D1 data is gone. It must log at error and count, never pass silently.
  const authDeleteMetric = () =>
    vi
      .mocked(submitCount)
      .mock.calls.filter(([, , , name]) => name === 'aeci.account.erasure.auth_delete')
      .map(([, , , , value, tags]) => ({ value, tags }));
  const errorLogs = () =>
    vi
      .mocked(logToPosthog)
      .mock.calls.map(([, , , entry]) => entry)
      .filter((entry) => entry.level === 'error');

  it('logs an error and counts skipped_no_creds when the service-role key is absent', async () => {
    await t.db.insert(profiles).values({ id: USER });
    const deleteAuthUser = vi.fn(async () => ({ ok: true, skipped: true }));
    const res = await runInProd(createDeleteAccountHandler(t.factory, deleteAuthUser), 'delete');

    expect(res.status).toBe(200);
    expect(await t.db.select().from(profiles)).toHaveLength(0);
    expect(authDeleteMetric()).toEqual([{ value: 1, tags: ['outcome:skipped_no_creds'] }]);
    const logs = errorLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      message: expect.stringContaining('skipped, no service-role key'),
      source: 'account',
      user_id: USER,
      outcome: 'skipped_no_creds',
    });
    // PII-free: the session email never reaches the log (AUTH_AND_RLS.md §8).
    expect(JSON.stringify(logs[0])).not.toContain('me@example.com');
  });

  it('logs an error and counts failed when GoTrue refuses the delete', async () => {
    await t.db.insert(profiles).values({ id: USER });
    const deleteAuthUser = vi.fn(async () => ({ ok: false, status: 500, error: 'boom' }));
    await runInProd(createDeleteAccountHandler(t.factory, deleteAuthUser), 'delete');

    expect(authDeleteMetric()).toEqual([{ value: 1, tags: ['outcome:failed'] }]);
    expect(errorLogs()).toEqual([
      expect.objectContaining({ outcome: 'failed', status: 500, reason: 'boom', user_id: USER }),
    ]);
  });

  it.each([
    [204, 'deleted'],
    [404, 'already_gone'],
  ] as const)('counts a %i as %s and logs no error', async (status, outcome) => {
    await t.db.insert(profiles).values({ id: USER });
    const deleteAuthUser = vi.fn(async () => ({ ok: true, status }));
    await runInProd(createDeleteAccountHandler(t.factory, deleteAuthUser), 'delete');

    expect(authDeleteMetric()).toEqual([{ value: 1, tags: [`outcome:${outcome}`] }]);
    expect(errorLogs()).toEqual([]);
  });

  // AECI-1468: one Supabase auth project backs every tier (ADR 0017), so only
  // production may delete the shared login. Every other tier erases D1 only.
  it.each([['development'], ['staging'], ['demo'], [undefined]] as const)(
    'keeps the shared login on ENV=%s and counts skipped_non_production',
    async (tier) => {
      await t.db.insert(profiles).values({ id: USER });
      const deleteAuthUser = vi.fn(async () => ({ ok: true, status: 204 }));
      const res = await runAs(
        createDeleteAccountHandler(t.factory, deleteAuthUser),
        'delete',
        'reviewer',
        undefined,
        { ...TEST_ENV, ENV: tier },
      );

      expect(res.status).toBe(200);
      expect(await t.db.select().from(profiles)).toHaveLength(0);
      expect(deleteAuthUser).not.toHaveBeenCalled();
      expect(authDeleteMetric()).toEqual([{ value: 1, tags: ['outcome:skipped_non_production'] }]);
      expect(errorLogs()).toEqual([]);
    },
  );

  it('deletes the shared login on ENV=production', async () => {
    await t.db.insert(profiles).values({ id: USER });
    const deleteAuthUser = vi.fn(async () => ({ ok: true, status: 204 }));
    await runInProd(createDeleteAccountHandler(t.factory, deleteAuthUser), 'delete');

    expect(deleteAuthUser).toHaveBeenCalledTimes(1);
    expect(deleteAuthUser).toHaveBeenCalledWith(
      expect.objectContaining({ ENV: 'production' }),
      USER,
    );
  });
});

// ─── AECI-1296: "About you" onboarding answers ─────────────────────────────────

const AUD_A = u(701);
const AUD_B = u(702);
const AUD_C = u(703);

async function seedAudiences(): Promise<void> {
  await t.db.insert(taxonomyAudiences).values([
    { id: AUD_A, slug: 'architecture', name: 'Architecture' },
    { id: AUD_B, slug: 'estimator', name: 'Estimator' },
    { id: AUD_C, slug: 'superintendent', name: 'Superintendent' },
  ]);
}

const asState = (v: unknown): Record<string, unknown> =>
  typeof v === 'string'
    ? (JSON.parse(v) as Record<string, unknown>)
    : (v as Record<string, unknown>);

describe('GET /api/account: onboarding state (AECI-1296)', () => {
  it('reports completed and the stored answers', async () => {
    await seedAudiences();
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada' });
    await t.db.insert(profileDetails).values({
      profileId: USER,
      companyType: 'architect',
      companySize: '11-50',
      primaryRole: 'manager',
      firmName: 'Acme Studio',
      linkedinUrl: 'https://www.linkedin.com/in/ada',
      onboardingSkippedAt: '2026-10-01T00:00:00.000Z',
      onboardingCompletedAt: '2026-10-02T00:00:00.000Z',
    });
    await t.db.insert(profileAudiences).values([
      { profileId: USER, audienceId: AUD_B },
      { profileId: USER, audienceId: AUD_A },
    ]);
    const res = await run(createGetAccountHandler(t.factory), 'get');
    expect(await res.json()).toMatchObject({
      onboarding: 'completed',
      details: {
        company_type: 'architect',
        company_size: '11-50',
        primary_role: 'manager',
        firm_name: 'Acme Studio',
        linkedin_url: 'https://www.linkedin.com/in/ada',
        audience_ids: [AUD_A, AUD_B],
      },
    });
  });

  it('reports skipped when only the skip is stamped', async () => {
    await t.db.insert(profiles).values({ id: USER });
    await t.db
      .insert(profileDetails)
      .values({ profileId: USER, onboardingSkippedAt: '2026-10-01T00:00:00.000Z' });
    const res = await run(createGetAccountHandler(t.factory), 'get');
    expect(await res.json()).toMatchObject({ onboarding: 'skipped' });
  });

  it('reads a stored value outside the current vocabulary as null', async () => {
    await t.db.insert(profiles).values({ id: USER });
    await t.db.insert(profileDetails).values({ profileId: USER, companyType: 'retired_value' });
    const res = await run(createGetAccountHandler(t.factory), 'get');
    expect(await res.json()).toMatchObject({ details: { company_type: null } });
  });

  it('suggests the provider name from the verified session', async () => {
    await t.db.insert(profiles).values({ id: USER });
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.use('*', async (c, next) => {
      c.set('auth', {
        userId: USER,
        email: 'me@example.com',
        fullName: 'Ada Lovelace',
        role: 'reviewer',
        vendorId: null,
        entitlementTier: 'unclaimed',
        entitlement: null,
      });
      await next();
    });
    a.get('/api/account', createGetAccountHandler(t.factory) as never);
    const res = await a.request('/api/account', {}, TEST_ENV, fakeExecutionContext());
    expect(await res.json()).toMatchObject({
      display_name: null,
      suggested_display_name: 'Ada Lovelace',
    });
  });
});

describe('PATCH /api/account: About you (AECI-1296)', () => {
  it('upserts the details, replaces the audiences and audits in one batch', async () => {
    await seedAudiences();
    await t.db.insert(profiles).values({ id: USER, displayName: 'Ada' });

    const first = await run(createUpdateAccountHandler(t.factory), 'patch', {
      company_type: 'general_contractor',
      company_size: '201-1000',
      primary_role: 'practitioner',
      firm_name: '  Turner Build  ',
      linkedin_url: 'HTTP://LinkedIn.com/in/ada-l/?trk=share#top',
      audience_ids: [AUD_A, AUD_B, AUD_A],
      onboarding: 'completed',
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      display_name: 'Ada',
      onboarding: 'completed',
      details: {
        company_type: 'general_contractor',
        company_size: '201-1000',
        primary_role: 'practitioner',
        firm_name: 'Turner Build',
        linkedin_url: 'https://www.linkedin.com/in/ada-l',
        audience_ids: [AUD_A, AUD_B],
      },
    });

    const [details] = await t.db.select().from(profileDetails);
    expect(details).toMatchObject({
      profileId: USER,
      firmName: 'Turner Build',
      linkedinUrl: 'https://www.linkedin.com/in/ada-l',
    });
    expect(details!.onboardingCompletedAt).not.toBeNull();

    const [audit] = await t.db.select().from(auditLog);
    expect(audit!.action).toBe('profile.updated');
    expect(asState(audit!.beforeState)).toEqual({
      company_type: null,
      company_size: null,
      primary_role: null,
      firm_name: null,
      linkedin_url: null,
      onboarding: 'pending',
      audience_ids: [],
    });
    expect(asState(audit!.afterState)).toMatchObject({
      company_type: 'general_contractor',
      onboarding: 'completed',
      audience_ids: [AUD_A, AUD_B],
    });

    // A second PATCH replaces the set and leaves untouched answers alone.
    const second = await run(createUpdateAccountHandler(t.factory), 'patch', {
      audience_ids: [AUD_C],
    });
    expect(await second.json()).toMatchObject({
      details: { company_type: 'general_contractor', audience_ids: [AUD_C] },
    });
    expect(await t.db.select().from(profileAudiences)).toEqual([
      expect.objectContaining({ profileId: USER, audienceId: AUD_C }),
    ]);
    expect(await t.db.select().from(profileDetails)).toHaveLength(1);
    expect(await t.db.select().from(auditLog)).toHaveLength(2);
  });

  it('records a skip, and a later save still reads as completed', async () => {
    await t.db.insert(profiles).values({ id: USER });
    const skip = await run(createUpdateAccountHandler(t.factory), 'patch', {
      onboarding: 'skipped',
    });
    expect(await skip.json()).toMatchObject({ onboarding: 'skipped' });
    const save = await run(createUpdateAccountHandler(t.factory), 'patch', {
      primary_role: 'IT',
      onboarding: 'completed',
    });
    expect(await save.json()).toMatchObject({ onboarding: 'completed' });
  });

  it('stores and reads back undisclosed on all three single choices', async () => {
    await t.db.insert(profiles).values({ id: USER });
    const res = await run(createUpdateAccountHandler(t.factory), 'patch', {
      company_type: 'undisclosed',
      company_size: 'undisclosed',
      primary_role: 'undisclosed',
    });
    expect(res.status).toBe(200);
    const [details] = await t.db.select().from(profileDetails);
    expect(details).toMatchObject({
      companyType: 'undisclosed',
      companySize: 'undisclosed',
      primaryRole: 'undisclosed',
    });
    const read = await run(createGetAccountHandler(t.factory), 'get');
    expect(await read.json()).toMatchObject({
      details: {
        company_type: 'undisclosed',
        company_size: 'undisclosed',
        primary_role: 'undisclosed',
      },
    });
  });

  it('stores and reads back a software company type and role', async () => {
    await t.db.insert(profiles).values({ id: USER });
    const res = await run(createUpdateAccountHandler(t.factory), 'patch', {
      company_type: 'integration_platform',
      primary_role: 'vendor_partnerships',
    });
    expect(res.status).toBe(200);
    const read = await run(createGetAccountHandler(t.factory), 'get');
    expect(await read.json()).toMatchObject({
      details: { company_type: 'integration_platform', primary_role: 'vendor_partnerships' },
    });
  });

  it('clears firm_name and linkedin_url on a blank string', async () => {
    await t.db.insert(profiles).values({ id: USER });
    await t.db.insert(profileDetails).values({
      profileId: USER,
      firmName: 'Acme',
      linkedinUrl: 'https://www.linkedin.com/in/ada',
    });
    const res = await run(createUpdateAccountHandler(t.factory), 'patch', {
      firm_name: '  ',
      linkedin_url: '',
    });
    expect(res.status).toBe(200);
    const [details] = await t.db.select().from(profileDetails);
    expect(details).toMatchObject({ firmName: null, linkedinUrl: null });
  });

  it('rejects a LinkedIn URL that is not a profile, and writes nothing', async () => {
    await t.db.insert(profiles).values({ id: USER });
    for (const bad of [
      'https://evil.example/in/ada',
      'https://www.linkedin.com/company/acme',
      'https://linkedin.com.evil.io/in/ada',
      'javascript:alert(1)',
    ]) {
      const res = await run(createUpdateAccountHandler(t.factory), 'patch', { linkedin_url: bad });
      expect(res.status, bad).toBe(400);
    }
    expect(await t.db.select().from(profileDetails)).toHaveLength(0);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('rejects an unknown audience id with a 400, and writes nothing', async () => {
    await seedAudiences();
    await t.db.insert(profiles).values({ id: USER });
    const res = await run(createUpdateAccountHandler(t.factory), 'patch', {
      audience_ids: [AUD_A, u(799)],
      onboarding: 'completed',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED', field: 'audience_ids' },
    });
    expect(await t.db.select().from(profileAudiences)).toHaveLength(0);
    expect(await t.db.select().from(profileDetails)).toHaveLength(0);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('rejects more than ten audiences and an out-of-vocabulary company type', async () => {
    await t.db.insert(profiles).values({ id: USER });
    const many = Array.from({ length: 11 }, (_, i) => u(710 + i));
    expect(
      (await run(createUpdateAccountHandler(t.factory), 'patch', { audience_ids: many })).status,
    ).toBe(400);
    expect(
      (await run(createUpdateAccountHandler(t.factory), 'patch', { company_type: 'bank' })).status,
    ).toBe(400);
  });
});

describe('DELETE /api/account: About you erasure (AECI-1296)', () => {
  it('cascades profile_details and profile_audiences with the profile', async () => {
    await seedAudiences();
    await t.db.insert(profiles).values([{ id: USER }, { id: ADMIN_USER }]);
    await t.db.insert(profileDetails).values([
      { profileId: USER, firmName: 'Acme', linkedinUrl: 'https://www.linkedin.com/in/ada' },
      { profileId: ADMIN_USER, firmName: 'Other' },
    ]);
    await t.db.insert(profileAudiences).values([
      { profileId: USER, audienceId: AUD_A },
      { profileId: ADMIN_USER, audienceId: AUD_A },
    ]);
    const deleteAuthUser = vi.fn(async () => ({ ok: true as const }));
    const res = await run(createDeleteAccountHandler(t.factory, deleteAuthUser as never), 'delete');
    expect(res.status).toBe(200);
    expect(await t.db.select().from(profileDetails)).toEqual([
      expect.objectContaining({ profileId: ADMIN_USER }),
    ]);
    expect(await t.db.select().from(profileAudiences)).toEqual([
      expect.objectContaining({ profileId: ADMIN_USER }),
    ]);
    // The taxonomy term itself survives a person's erasure.
    expect(await t.db.select().from(taxonomyAudiences)).toHaveLength(3);
  });
});
