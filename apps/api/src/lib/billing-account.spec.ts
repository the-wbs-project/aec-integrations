/**
 * The billing-account builder (AECI-1351, E1.2 of `docs/VENDOR_SIGNUP_PROCESS.md` §5)
 * on the in-memory D1 harness.
 *
 * The matrix: a vendor with no account gets one row plus its `billing_account.created`
 * audit row; a vendor that already has one gets the frozen no-op (zero statements, no
 * audit row). No statement names `vendors`, so neither path moves `vendors.updated_at`.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, billingAccounts, profiles, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { type BatchStmt, type BatchTuple } from './audit';
import {
  BILLING_ACCOUNT_CREATED_ACTION,
  BILLING_ACCOUNT_EMAIL_CHANGED_ACTION,
  BILLING_ACCOUNT_ENTITY_TYPE,
  billingEmailStatements,
  ensureBillingAccountStatements,
  loadBillingAccount,
  loadBillingAccountEmail,
  type BillingEmailParams,
  type EnsureBillingAccountParams,
} from './billing-account';

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '44444444-4444-4444-8444-444444444444';
const OLD_TS = '2020-01-01T00:00:00.000Z';
const NOW = '2026-10-14T12:00:00.000Z';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN_ID, role: 'admin' });
  await t.db.insert(vendors).values({
    id: VENDOR_ID,
    slug: 'autodesk',
    companyName: 'Autodesk, Inc.',
    updatedAt: OLD_TS,
  });
});
afterEach(() => t.dispose());

const args = (over: Partial<EnsureBillingAccountParams> = {}): EnsureBillingAccountParams => ({
  vendorId: VENDOR_ID,
  name: 'Autodesk, Inc.',
  createdBy: ADMIN_ID,
  actorType: 'admin',
  existing: null,
  now: NOW,
  vendorPlan: { tier: 'none', status: 'none' },
  source: 'admin-moderation',
  sourceRequestId: REQUEST_ID,
  ...over,
});

function sqlOf(stmt: BatchStmt): string {
  return (stmt as unknown as { toSQL(): { sql: string } }).toSQL().sql;
}

describe('loadBillingAccount', () => {
  it('returns null for a vendor with no account', async () => {
    expect(await loadBillingAccount(t.db, VENDOR_ID)).toBeNull();
  });

  it('returns the account id once one exists', async () => {
    const batch = ensureBillingAccountStatements(t.db, args());
    await t.db.batch(batch.stmts as BatchTuple);
    expect(await loadBillingAccount(t.db, VENDOR_ID)).toEqual({ id: batch.billingAccountId });
  });
});

describe('ensureBillingAccountStatements', () => {
  it('first owner: INSERTs one account and its audit row', async () => {
    const batch = ensureBillingAccountStatements(t.db, args());
    expect(batch.stmts).toHaveLength(2);
    await t.db.batch(batch.stmts as BatchTuple);

    const accounts = await t.db.select().from(billingAccounts);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: batch.billingAccountId,
      vendorId: VENDOR_ID,
      name: 'Autodesk, Inc.',
      billingEmail: null,
      stripeCustomerId: null,
      createdBy: ADMIN_ID,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: BILLING_ACCOUNT_CREATED_ACTION,
      entityType: BILLING_ACCOUNT_ENTITY_TYPE,
      entityId: batch.billingAccountId,
      actorId: ADMIN_ID,
      actorType: 'admin',
      vendorId: VENDOR_ID,
      vendorTier: 'none',
      vendorEntitlementStatus: 'none',
    });
    expect(audits[0]!.afterState).toEqual({
      vendor_id: VENDOR_ID,
      name: 'Autodesk, Inc.',
      billing_email: null,
    });
    expect(audits[0]!.metadata).toEqual({
      source: 'admin-moderation',
      vendorId: VENDOR_ID,
      source_request_id: REQUEST_ID,
    });
    expect(batch.auditEntry).toMatchObject({ id: audits[0]!.id });
  });

  it('existing account: the frozen no-op, nothing written, nothing audited', async () => {
    const first = ensureBillingAccountStatements(t.db, args());
    await t.db.batch(first.stmts as BatchTuple);

    const second = ensureBillingAccountStatements(
      t.db,
      args({ existing: { id: first.billingAccountId! } }),
    );
    expect(second.stmts).toEqual([]);
    expect(second.auditEntry).toBeNull();
    expect(second.billingAccountId).toBeNull();
    expect(Object.isFrozen(second)).toBe(true);
    expect(Object.isFrozen(second.stmts)).toBe(true);

    expect(await t.db.select().from(billingAccounts)).toHaveLength(1);
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
  });

  it('never names `vendors`, so vendors.updated_at stays put', async () => {
    const batch = ensureBillingAccountStatements(t.db, args());
    expect(batch.stmts.map(sqlOf).filter((sql) => /"vendors"/.test(sql))).toEqual([]);
    await t.db.batch(batch.stmts as BatchTuple);
    const [vendor] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR_ID));
    expect(vendor!.updatedAt).toBe(OLD_TS);
  });

  it('normalises the timestamp and omits source_request_id off the claim path', async () => {
    const batch = ensureBillingAccountStatements(
      t.db,
      args({ now: '2026-10-14T12:00:00Z', sourceRequestId: undefined }),
    );
    await t.db.batch(batch.stmts as BatchTuple);
    const [account] = await t.db.select().from(billingAccounts);
    expect(account!.createdAt).toBe(NOW);
    const [audit] = await t.db.select().from(auditLog);
    expect(audit!.metadata).not.toHaveProperty('source_request_id');
  });

  it('a second INSERT for the same vendor trips the unique index (the race rolls back)', async () => {
    await t.db.batch(ensureBillingAccountStatements(t.db, args()).stmts as BatchTuple);
    // Both racers saw `existing: null`; the loser's batch must fail whole.
    const loser = ensureBillingAccountStatements(t.db, args());
    await expect(t.db.batch(loser.stmts as BatchTuple)).rejects.toThrow();
    expect(await t.db.select().from(billingAccounts)).toHaveLength(1);
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
  });
});

describe('billingEmailStatements (AECI-1389)', () => {
  const OWNER_ID = '33333333-3333-4333-8333-333333333333';

  async function seedAccount(): Promise<string> {
    // `audit_log.actor_id` references `profiles`.
    await t.db.insert(profiles).values({ id: OWNER_ID, role: 'vendor_admin', vendorId: VENDOR_ID });
    const batch = ensureBillingAccountStatements(t.db, args());
    await t.db.batch(batch.stmts as BatchTuple);
    await t.db.delete(auditLog);
    return batch.billingAccountId!;
  }

  const emailArgs = (id: string, over: Partial<BillingEmailParams> = {}): BillingEmailParams => ({
    billingAccountId: id,
    vendorId: VENDOR_ID,
    before: null,
    email: 'ap@autodesk.com',
    now: '2026-10-16T09:00:00Z',
    actorId: OWNER_ID,
    actorType: 'user',
    vendorPlan: { tier: 'managed', status: 'active' },
    source: 'vendor-portal',
    ...over,
  });

  it('sets the address, lower-cased and trimmed, with one audit row naming the vendor', async () => {
    const id = await seedAccount();
    const batch = billingEmailStatements(t.db, emailArgs(id, { email: '  AP@Autodesk.com ' }));
    expect(batch.billingEmail).toBe('ap@autodesk.com');
    await t.db.batch(batch.stmts as BatchTuple);

    expect(await loadBillingAccountEmail(t.db, VENDOR_ID)).toEqual({
      id,
      billingEmail: 'ap@autodesk.com',
    });
    const [account] = await t.db.select().from(billingAccounts);
    expect(account!.updatedAt).toBe('2026-10-16T09:00:00.000Z');

    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: BILLING_ACCOUNT_EMAIL_CHANGED_ACTION,
      entityType: BILLING_ACCOUNT_ENTITY_TYPE,
      entityId: id,
      actorId: OWNER_ID,
      actorType: 'user',
      vendorId: VENDOR_ID,
    });
    expect(audits[0]!.beforeState).toEqual({ billing_email: null });
    expect(audits[0]!.afterState).toEqual({ billing_email: 'ap@autodesk.com' });
    expect(audits[0]!.metadata).toEqual({ source: 'vendor-portal', vendorId: VENDOR_ID });
  });

  it('clears the address on null', async () => {
    const id = await seedAccount();
    const batch = billingEmailStatements(
      t.db,
      emailArgs(id, { before: 'ap@autodesk.com', email: null }),
    );
    await t.db.batch(batch.stmts as BatchTuple);
    expect(batch.billingEmail).toBeNull();
    const [audit] = await t.db.select().from(auditLog);
    expect(audit!.afterState).toEqual({ billing_email: null });
  });

  it('an unchanged address writes nothing and audits nothing', () => {
    const batch = billingEmailStatements(
      t.db,
      emailArgs('any', { before: 'ap@autodesk.com', email: 'AP@autodesk.com' }),
    );
    expect(batch.stmts).toEqual([]);
    expect(batch.auditEntry).toBeNull();
    expect(batch.billingEmail).toBe('ap@autodesk.com');
  });

  it('never names `vendors`', async () => {
    const id = await seedAccount();
    const batch = billingEmailStatements(t.db, emailArgs(id));
    expect(batch.stmts.map(sqlOf).filter((sql) => /"vendors"/.test(sql))).toEqual([]);
  });
});
