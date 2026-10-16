/**
 * `PUT /api/vendor/billing/email` (AECI-1389, E5.3) over the in-memory D1, with the
 * session stubbed the way `vendor-billing.spec.ts` stubs it. The guard cells (401 for
 * anon, the role and ban cells) are in `vendor.authz-matrix.spec.ts`, and the limiter
 * registration in `vendor-billing-email.registration.spec.ts`. This file covers what
 * the handler decides: owner seats only, the stored value, the audit row, and the
 * no-op on an unchanged address.
 */

import { ApiErrorCode, UpdateBillingEmailResponseSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, billingAccounts, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { seedBillingAccount } from '../test/licenses';
import { createUpdateBillingEmailHandler } from './vendor-billing-email';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = uuid(1);
const OTHER_VENDOR = uuid(2);
const OWNER = uuid(100);
const MEMBER = uuid(101);

const session = (over: Partial<AuthzVariables['auth']> = {}): AuthzVariables['auth'] => ({
  userId: OWNER,
  email: 'owner@acme.com',
  role: 'vendor_admin',
  vendorId: VENDOR,
  entitlementTier: 'unclaimed',
  entitlement: null,
  ...over,
});

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'acme', companyName: 'Acme' },
    { id: OTHER_VENDOR, slug: 'globex', companyName: 'Globex' },
  ]);
  await t.db.insert(profiles).values([
    { id: OWNER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
    { id: MEMBER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: false },
  ]);
});
afterEach(() => t.dispose());

async function call(auth: AuthzVariables['auth'], body: unknown) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.put('/api/vendor/billing/email', createUpdateBillingEmailHandler(t.factory));
  const res = await app.fetch(
    new Request('http://x/api/vendor/billing/email', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    TEST_ENV,
    fakeExecutionContext(),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any };
}

const stored = async (id: string) =>
  (await t.db.select().from(billingAccounts).where(eq(billingAccounts.id, id)))[0]!.billingEmail;

describe('PUT /api/vendor/billing/email', () => {
  it('stores the owner’s address lower-cased and writes one audit row', async () => {
    const account = await seedBillingAccount(t.db, VENDOR);
    const { status, body } = await call(session(), { billing_email: '  AP@Acme.COM ' });

    expect(status).toBe(200);
    expect(UpdateBillingEmailResponseSchema.parse(body)).toEqual({
      billing_account: { id: account, billing_email: 'ap@acme.com' },
    });
    expect(await stored(account)).toBe('ap@acme.com');

    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'billing_account.email_changed',
      entityType: 'billing_account',
      entityId: account,
      actorId: OWNER,
      actorType: 'user',
      vendorId: VENDOR,
    });
    expect(audits[0]!.beforeState).toEqual({ billing_email: null });
    expect(audits[0]!.afterState).toEqual({ billing_email: 'ap@acme.com' });
    expect(audits[0]!.metadata).toMatchObject({ source: 'vendor-portal' });
  });

  it('clears the address on null', async () => {
    const account = await seedBillingAccount(t.db, VENDOR);
    await t.db
      .update(billingAccounts)
      .set({ billingEmail: 'ap@acme.com' })
      .where(eq(billingAccounts.id, account));

    const { status, body } = await call(session(), { billing_email: null });
    expect(status).toBe(200);
    expect(body.billing_account.billing_email).toBeNull();
    expect(await stored(account)).toBeNull();
    const [audit] = await t.db.select().from(auditLog);
    expect(audit!.beforeState).toEqual({ billing_email: 'ap@acme.com' });
    expect(audit!.afterState).toEqual({ billing_email: null });
  });

  it('an unchanged address answers 200 and writes no audit row', async () => {
    const account = await seedBillingAccount(t.db, VENDOR);
    await t.db
      .update(billingAccounts)
      .set({ billingEmail: 'ap@acme.com', updatedAt: '2026-01-01T00:00:00.000Z' })
      .where(eq(billingAccounts.id, account));

    const { status, body } = await call(session(), { billing_email: 'AP@acme.com' });
    expect(status).toBe(200);
    expect(body.billing_account.billing_email).toBe('ap@acme.com');
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    const [row] = await t.db.select().from(billingAccounts);
    expect(row!.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('touches only the caller’s own account', async () => {
    const ours = await seedBillingAccount(t.db, VENDOR);
    const theirs = await seedBillingAccount(t.db, OTHER_VENDOR);
    await call(session(), { billing_email: 'ap@acme.com' });
    expect(await stored(ours)).toBe('ap@acme.com');
    expect(await stored(theirs)).toBeNull();
  });

  it('rejects a member seat with 403 and writes nothing', async () => {
    const account = await seedBillingAccount(t.db, VENDOR);
    const { status, body } = await call(session({ userId: MEMBER }), {
      billing_email: 'ap@acme.com',
    });
    expect(status).toBe(403);
    expect(body.error.code).toBe(ApiErrorCode.FORBIDDEN);
    expect(await stored(account)).toBeNull();
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('answers 404 when the vendor has no billing account', async () => {
    const { status, body } = await call(session(), { billing_email: 'ap@acme.com' });
    expect(status).toBe(404);
    expect(body.error.code).toBe(ApiErrorCode.NOT_FOUND);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it.each([
    ['an invalid address', { billing_email: 'not-an-email' }],
    ['a missing field', {}],
    ['an unknown key', { billing_email: 'ap@acme.com', extra: true }],
  ])('rejects %s with 400', async (_label, payload) => {
    const account = await seedBillingAccount(t.db, VENDOR);
    const { status } = await call(session(), payload);
    expect(status).toBe(400);
    expect(await stored(account)).toBeNull();
  });
});
