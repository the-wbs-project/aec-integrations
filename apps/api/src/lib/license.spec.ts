/**
 * The license write module (AECI-1352, E1.3). INVARIANT tests: they encode the
 * issue's acceptance criteria and must not be deleted without reopening it.
 *
 *  1. One audit row per license written, in the same batch, `entity_type =
 *     'billing_account'`, `entity_id` = the account, `metadata.license_id`.
 *  2. Every no-op returns the one frozen empty batch.
 *  3. The mirror reconcile is the ONLY `vendors` statement, the LAST statement, and
 *     byte-identical across builders.
 *  4. An ended license keeps `assigned_product_id`.
 *  5. Every date is stored as full ISO (`toISOString()`), including date-only input.
 *
 * Asserted by observed effect (build → `db.batch` → read back) on the real migrations,
 * plus SQL-level checks on the statements.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auditLog,
  billingAccounts,
  licenses,
  productVendors,
  products,
  profiles,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { type BatchStmt, type BatchTuple } from './audit';
import {
  assignLicenseStatements,
  clearVendorBannedFlagsStatements,
  endLicensesStatements,
  grantLicensesStatements,
  lapseTermStatements,
  loadOwnedProductLicenseState,
  loadVendorLicenses,
  reconcileVerifiedMirror,
  setCancelAtTermEndStatements,
  setLicensesTermStatements,
  setReleaseAtRenewalStatements,
  toIsoTimestamp,
  unassignLicenseStatements,
  type LicenseBatch,
  type LicenseBefore,
} from './license';

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_VENDOR_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = 'ba-1';
const OTHER_ACCOUNT_ID = 'ba-2';
const OLD_TS = '2020-01-01T00:00:00.000Z';
const NOW = '2026-10-14T12:00:00.000Z';
const LATER = '2026-10-15T12:00:00.000Z';
const P1 = 'p-1';
const P2 = 'p-2';

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN_ID, role: 'admin' });
  await t.db.insert(vendors).values([
    { id: VENDOR_ID, slug: 'acme', companyName: 'Acme', verified: false, updatedAt: OLD_TS },
    { id: OTHER_VENDOR_ID, slug: 'other', companyName: 'Other', verified: false },
  ]);
  await t.db.insert(products).values([
    { id: P1, slug: 'acme-one', name: 'Acme One', promotionStatus: 'promoted' },
    { id: P2, slug: 'acme-two', name: 'Acme Two', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(billingAccounts).values([
    { id: ACCOUNT_ID, vendorId: VENDOR_ID, name: 'Acme' },
    { id: OTHER_ACCOUNT_ID, vendorId: OTHER_VENDOR_ID, name: 'Other' },
  ]);
});
afterEach(() => t.dispose());

const run = async (batch: LicenseBatch) => {
  if (batch.stmts.length > 0) await t.db.batch(batch.stmts as BatchTuple);
};
const vendorOf = async (id = VENDOR_ID) =>
  (await t.db.select().from(vendors).where(eq(vendors.id, id)))[0]!;
const licenseOf = async (id: string) =>
  (await t.db.select().from(licenses).where(eq(licenses.id, id)))[0]!;
const audits = async () => t.db.select().from(auditLog);
const setVerified = async (verified: boolean) =>
  t.db.update(vendors).set({ verified, updatedAt: OLD_TS }).where(eq(vendors.id, VENDOR_ID));

/** Insert a license directly, bypassing the builders, to set up a state. */
async function seedLicense(
  id: string,
  over: Partial<typeof licenses.$inferInsert> = {},
): Promise<void> {
  await t.db.insert(licenses).values({
    id,
    billingAccountId: ACCOUNT_ID,
    source: 'complimentary',
    startsAt: OLD_TS,
    endsAt: '2027-10-14T00:00:00.000Z',
    createdAt: OLD_TS,
    updatedAt: OLD_TS,
    ...over,
  });
}

async function ctx(vendorId = VENDOR_ID) {
  return {
    vendorId,
    now: NOW,
    actorId: ADMIN_ID,
    actorType: 'admin' as const,
    vendorLicenses: await loadVendorLicenses(t.db, vendorId),
    vendorWasVerified: (await vendorOf(vendorId)).verified,
  };
}

const sqlOf = (stmt: BatchStmt) => (stmt as unknown as { toSQL(): { sql: string } }).toSQL();
const touchesVendors = (stmt: BatchStmt) => /^update "vendors"/i.test(sqlOf(stmt).sql);

// ─── Dates ───────────────────────────────────────────────────────────────────

describe('toIsoTimestamp', () => {
  it('turns a date-only input into full ISO at UTC midnight', () => {
    expect(toIsoTimestamp('2027-01-31')).toBe('2027-01-31T00:00:00.000Z');
  });

  it('normalises a Date and an offset timestamp to the one Z spelling', () => {
    expect(toIsoTimestamp(new Date(NOW))).toBe(NOW);
    expect(toIsoTimestamp('2026-10-14T14:00:00+02:00')).toBe(NOW);
  });

  it('throws on an unparseable date rather than storing it', () => {
    expect(() => toIsoTimestamp('soon')).toThrow(RangeError);
  });
});

// ─── loadVendorLicenses ──────────────────────────────────────────────────────

describe('loadVendorLicenses', () => {
  it("returns only this vendor's licenses, across its billing accounts", async () => {
    await seedLicense('l-1');
    await seedLicense('l-x', { billingAccountId: OTHER_ACCOUNT_ID });
    const rows = await loadVendorLicenses(t.db, VENDOR_ID);
    expect(rows.map((r) => r.id)).toEqual(['l-1']);
    expect(rows[0]).toMatchObject({ billingAccountId: ACCOUNT_ID, endedAt: null });
  });
});

// ─── Grant ───────────────────────────────────────────────────────────────────

describe('grantLicensesStatements', () => {
  it('inserts N licenses with normalised dates, one audit row each, and flips the mirror', async () => {
    const batch = grantLicensesStatements(t.db, {
      ...(await ctx()),
      billingAccountId: ACCOUNT_ID,
      count: 2,
      licenseSource: 'invoice',
      startsAt: '2026-10-14',
      endsAt: '2027-10-14',
      reference: 'PO-123',
      grantedBy: ADMIN_ID,
      productIds: [P1],
      licenseIds: ['l-a', 'l-b'],
    });
    expect(batch.verifiedFlipped).toBe(true);
    await run(batch);

    const a = await licenseOf('l-a');
    const b = await licenseOf('l-b');
    for (const row of [a, b]) {
      expect(row).toMatchObject({
        billingAccountId: ACCOUNT_ID,
        source: 'invoice',
        startsAt: '2026-10-14T00:00:00.000Z',
        endsAt: '2027-10-14T00:00:00.000Z',
        endedAt: null,
        reference: 'PO-123',
        grantedBy: ADMIN_ID,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    expect(a.assignedProductId).toBe(P1);
    expect(a.assignedAt).toBe(NOW);
    expect(b.assignedProductId).toBeNull();

    const v = await vendorOf();
    expect(v.verified).toBe(true);
    expect(v.updatedAt).toBe(NOW);

    const rows = await audits();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.action).toBe('license.granted');
      expect(row.entityType).toBe('billing_account');
      expect(row.entityId).toBe(ACCOUNT_ID);
      expect(row.vendorId).toBe(VENDOR_ID);
      // The plan BEFORE the grant: no license at all.
      expect(row.vendorTier).toBe('none');
      expect(row.vendorEntitlementStatus).toBe('none');
    }
    const byLicense = new Map(
      rows.map((r) => [(r.metadata as { license_id: string }).license_id, r]),
    );
    expect(byLicense.get('l-a')?.productId).toBe(P1);
    expect(byLicense.get('l-b')?.productId).toBeNull();
    expect(batch.auditEntries).toHaveLength(2);
  });

  it('a monthly grant stores ends_at null and defaults starts_at to now', async () => {
    await run(
      grantLicensesStatements(t.db, {
        ...(await ctx()),
        billingAccountId: ACCOUNT_ID,
        count: 1,
        licenseSource: 'stripe',
        endsAt: null,
        stripeSubscriptionId: 'sub_1',
        licenseIds: ['l-m'],
      }),
    );
    expect(await licenseOf('l-m')).toMatchObject({
      startsAt: NOW,
      endsAt: null,
      stripeSubscriptionId: 'sub_1',
    });
  });

  it('count 0 is the frozen no-op; a bad source or count throws', async () => {
    const base = { ...(await ctx()), billingAccountId: ACCOUNT_ID, endsAt: null };
    expect(
      grantLicensesStatements(t.db, { ...base, count: 0, licenseSource: 'stripe' }).stmts,
    ).toEqual([]);
    expect(() =>
      grantLicensesStatements(t.db, { ...base, count: 1, licenseSource: 'gift' as 'stripe' }),
    ).toThrow(RangeError);
    expect(() =>
      grantLicensesStatements(t.db, { ...base, count: 1.5, licenseSource: 'stripe' }),
    ).toThrow(RangeError);
    expect(() =>
      grantLicensesStatements(t.db, {
        ...base,
        count: 1,
        licenseSource: 'stripe',
        productIds: [P1, P2],
      }),
    ).toThrow(RangeError);
  });

  it('a second grant to an already-verified vendor leaves vendors.updated_at alone', async () => {
    await seedLicense('l-1');
    await setVerified(true);
    const batch = grantLicensesStatements(t.db, {
      ...(await ctx()),
      billingAccountId: ACCOUNT_ID,
      count: 1,
      licenseSource: 'complimentary',
      endsAt: '2027-01-31',
    });
    expect(batch.verifiedFlipped).toBe(false);
    await run(batch);
    expect(await vendorOf()).toMatchObject({ verified: true, updatedAt: OLD_TS });
    // The plan BEFORE: one live license.
    expect((await audits())[0]).toMatchObject({
      vendorTier: 'verified',
      vendorEntitlementStatus: 'active',
    });
  });
});

// ─── Assign / unassign ───────────────────────────────────────────────────────

describe('grantLicensesStatements — the audit tag', () => {
  it("records the caller's `source` tag in metadata, apart from the license source", async () => {
    const batch = grantLicensesStatements(t.db, {
      ...(await ctx()),
      billingAccountId: ACCOUNT_ID,
      count: 1,
      licenseSource: 'invoice',
      endsAt: null,
      source: 'admin-entitlement',
    });
    await run(batch);
    const [row] = await audits();
    expect(row!.metadata).toMatchObject({ source: 'admin-entitlement' });
    expect((await t.db.select().from(licenses))[0]!.source).toBe('invoice');
  });

  it('defaults the audit tag to admin-license when the caller passes none', async () => {
    await run(
      grantLicensesStatements(t.db, {
        ...(await ctx()),
        billingAccountId: ACCOUNT_ID,
        count: 1,
        licenseSource: 'stripe',
        endsAt: null,
      }),
    );
    expect((await audits())[0]!.metadata).toMatchObject({ source: 'admin-license' });
  });
});

describe('assignLicenseStatements', () => {
  it('puts a live unassigned license on a product and audits the product', async () => {
    await seedLicense('l-1');
    await setVerified(true);
    const batch = assignLicenseStatements(t.db, {
      ...(await ctx()),
      licenseId: 'l-1',
      productId: P1,
    });
    await run(batch);
    expect(await licenseOf('l-1')).toMatchObject({
      assignedProductId: P1,
      assignedAt: NOW,
      updatedAt: NOW,
    });
    const [row] = await audits();
    expect(row).toMatchObject({
      action: 'license.assigned',
      entityType: 'billing_account',
      entityId: ACCOUNT_ID,
      productId: P1,
      vendorId: VENDOR_ID,
    });
    expect((row!.metadata as { license_id: string }).license_id).toBe('l-1');
    // Assigning does not move the mirror.
    expect(await vendorOf()).toMatchObject({ verified: true, updatedAt: OLD_TS });
  });

  it('is a no-op on an assigned, ended, or foreign license', async () => {
    await seedLicense('l-assigned', { assignedProductId: P1, assignedAt: OLD_TS });
    await seedLicense('l-ended', { endedAt: OLD_TS });
    await seedLicense('l-foreign', { billingAccountId: OTHER_ACCOUNT_ID });
    const c = await ctx();
    for (const licenseId of ['l-assigned', 'l-ended', 'l-foreign', 'l-missing']) {
      const batch = assignLicenseStatements(t.db, { ...c, licenseId, productId: P2 });
      expect(batch.stmts).toHaveLength(0);
      expect(Object.isFrozen(batch)).toBe(true);
    }
  });

  it('the SQL guard holds when the pre-read is stale: a concurrent assign wins', async () => {
    await seedLicense('l-1');
    const stale = await ctx();
    await run(assignLicenseStatements(t.db, { ...stale, licenseId: 'l-1', productId: P1 }));
    // Built from the same pre-read, so the TS gate passes; the WHERE must refuse.
    await run(assignLicenseStatements(t.db, { ...stale, licenseId: 'l-1', productId: P2 }));
    expect((await licenseOf('l-1')).assignedProductId).toBe(P1);
  });
});

describe('unassignLicenseStatements', () => {
  it('returns the license to the pool, still live, and clears release-at-renewal', async () => {
    await seedLicense('l-1', {
      assignedProductId: P1,
      assignedAt: OLD_TS,
      releaseAtRenewal: true,
    });
    await setVerified(true);
    await run(unassignLicenseStatements(t.db, { ...(await ctx()), licenseId: 'l-1' }));
    expect(await licenseOf('l-1')).toMatchObject({
      assignedProductId: null,
      assignedAt: null,
      releaseAtRenewal: false,
      endedAt: null,
    });
    expect((await audits())[0]).toMatchObject({ action: 'license.unassigned', productId: P1 });
    expect(await vendorOf()).toMatchObject({ verified: true, updatedAt: OLD_TS });
  });

  it('is a no-op on an unassigned license', async () => {
    await seedLicense('l-1');
    expect(
      unassignLicenseStatements(t.db, { ...(await ctx()), licenseId: 'l-1' }).stmts,
    ).toHaveLength(0);
  });
});

// ─── Flags ───────────────────────────────────────────────────────────────────

describe('setReleaseAtRenewalStatements', () => {
  it('sets and clears the flag, and no-ops when unchanged', async () => {
    await seedLicense('l-1', { assignedProductId: P1, assignedAt: OLD_TS });
    await run(
      setReleaseAtRenewalStatements(t.db, { ...(await ctx()), licenseId: 'l-1', release: true }),
    );
    expect((await licenseOf('l-1')).releaseAtRenewal).toBe(true);
    expect(
      setReleaseAtRenewalStatements(t.db, { ...(await ctx()), licenseId: 'l-1', release: true })
        .stmts,
    ).toHaveLength(0);
    await run(
      setReleaseAtRenewalStatements(t.db, {
        ...(await ctx()),
        now: LATER,
        licenseId: 'l-1',
        release: false,
      }),
    );
    expect((await licenseOf('l-1')).releaseAtRenewal).toBe(false);
    expect((await audits()).map((r) => r.action).sort()).toEqual([
      'license.release_at_renewal_cleared',
      'license.release_at_renewal_set',
    ]);
  });

  it('will not set the flag on an unassigned license, but clears a stray one there', async () => {
    await seedLicense('l-pool');
    expect(
      setReleaseAtRenewalStatements(t.db, { ...(await ctx()), licenseId: 'l-pool', release: true })
        .stmts,
    ).toHaveLength(0);
    await t.db.update(licenses).set({ releaseAtRenewal: true }).where(eq(licenses.id, 'l-pool'));
    await run(
      setReleaseAtRenewalStatements(t.db, {
        ...(await ctx()),
        licenseId: 'l-pool',
        release: false,
      }),
    );
    expect((await licenseOf('l-pool')).releaseAtRenewal).toBe(false);
  });

  it.each([
    ['unassigned (an approved early release)', null],
    ['moved to another product', P2],
  ])(
    'the SQL guard holds when the pre-read is stale: a license %s since the read stays unflagged (AECI-1388)',
    async (_label, productNow) => {
      await seedLicense('l-1', { assignedProductId: P1, assignedAt: OLD_TS });
      const set = setReleaseAtRenewalStatements(t.db, {
        ...(await ctx()),
        licenseId: 'l-1',
        release: true,
      });
      expect(sqlOf(set.stmts[0]!).sql).toMatch(/"licenses"\."assigned_product_id" = \?/i);

      await t.db
        .update(licenses)
        .set({ assignedProductId: productNow, assignedAt: productNow ? NOW : null })
        .where(eq(licenses.id, 'l-1'));
      await run(set);
      expect((await licenseOf('l-1')).releaseAtRenewal).toBe(false);
    },
  );
});

describe('setCancelAtTermEndStatements', () => {
  it('flags every live license given, skips ended and foreign ones, one audit row each', async () => {
    await seedLicense('l-1');
    await seedLicense('l-2', { assignedProductId: P1, assignedAt: OLD_TS });
    await seedLicense('l-ended', { endedAt: OLD_TS });
    await seedLicense('l-foreign', { billingAccountId: OTHER_ACCOUNT_ID });
    const batch = setCancelAtTermEndStatements(t.db, {
      ...(await ctx()),
      licenseIds: ['l-1', 'l-2', 'l-ended', 'l-foreign'],
      cancel: true,
      cancelReason: 'vendor-banned',
    });
    expect(batch.auditEntries).toHaveLength(2);
    await run(batch);
    for (const id of ['l-1', 'l-2']) {
      expect(await licenseOf(id)).toMatchObject({
        cancelAtTermEnd: true,
        cancelReason: 'vendor-banned',
      });
    }
    expect((await licenseOf('l-foreign')).cancelAtTermEnd).toBe(false);
    expect((await audits()).every((r) => r.action === 'license.cancel_at_term_end_set')).toBe(true);

    // Same again: nothing changes, so the frozen no-op.
    expect(
      setCancelAtTermEndStatements(t.db, {
        ...(await ctx()),
        licenseIds: ['l-1', 'l-2'],
        cancel: true,
        cancelReason: 'vendor-banned',
      }).stmts,
    ).toHaveLength(0);

    // Clearing drops the reason too.
    await run(
      setCancelAtTermEndStatements(t.db, {
        ...(await ctx()),
        licenseIds: ['l-1'],
        cancel: false,
      }),
    );
    expect(await licenseOf('l-1')).toMatchObject({ cancelAtTermEnd: false, cancelReason: null });
  });

  it('throws on a cancel reason outside LICENSE_CANCEL_REASONS (AECI-1374)', async () => {
    await seedLicense('l-1');
    const c = await ctx();
    expect(() =>
      setCancelAtTermEndStatements(t.db, {
        ...c,
        licenseIds: ['l-1'],
        cancel: true,
        cancelReason: 'ban',
      }),
    ).toThrow(RangeError);
  });

  it('ifCancelReason touches only licenses carrying that reason, read and commit (AECI-1374)', async () => {
    await seedLicense('l-banned', { cancelAtTermEnd: true, cancelReason: 'vendor-banned' });
    await seedLicense('l-other', { cancelAtTermEnd: true, cancelReason: null });
    await seedLicense('l-raced', { cancelAtTermEnd: true, cancelReason: 'vendor-banned' });
    const batch = setCancelAtTermEndStatements(t.db, {
      ...(await ctx()),
      licenseIds: ['l-banned', 'l-other', 'l-raced'],
      cancel: false,
      ifCancelReason: 'vendor-banned',
    });
    // The pre-read filter: l-other is skipped.
    expect(
      batch.auditEntries.map((e) => (e.metadata as { license_id: string }).license_id),
    ).toEqual(['l-banned', 'l-raced']);
    // Another writer re-flags l-raced between the read and the commit: the guard holds.
    await t.db.update(licenses).set({ cancelReason: null }).where(eq(licenses.id, 'l-raced'));
    await run(batch);
    expect(await licenseOf('l-banned')).toMatchObject({
      cancelAtTermEnd: false,
      cancelReason: null,
    });
    expect(await licenseOf('l-other')).toMatchObject({ cancelAtTermEnd: true, cancelReason: null });
    expect(await licenseOf('l-raced')).toMatchObject({ cancelAtTermEnd: true, cancelReason: null });
  });
});

describe('clearVendorBannedFlagsStatements (ruled 2026-10-15)', () => {
  const params = {
    vendorId: VENDOR_ID,
    now: NOW,
    actorId: ADMIN_ID,
    actorType: 'admin' as const,
    source: 'admin-moderation',
    extraMetadata: { seat_user_id: 'seat-1' },
  };

  it('clears live vendor-banned flags only, one audit row each', async () => {
    await seedLicense('l-banned', { cancelAtTermEnd: true, cancelReason: 'vendor-banned' });
    await seedLicense('l-other', { cancelAtTermEnd: true, cancelReason: null });
    await seedLicense('l-ended', {
      cancelAtTermEnd: true,
      cancelReason: 'vendor-banned',
      endedAt: OLD_TS,
    });
    await seedLicense('l-foreign', {
      billingAccountId: OTHER_ACCOUNT_ID,
      cancelAtTermEnd: true,
      cancelReason: 'vendor-banned',
    });
    const batch = await clearVendorBannedFlagsStatements(t.db, params);
    expect(batch.auditEntries).toHaveLength(1);
    expect(batch.auditEntries[0]).toMatchObject({
      action: 'license.cancel_at_term_end_cleared',
      entityType: 'billing_account',
      entityId: ACCOUNT_ID,
      vendorId: VENDOR_ID,
    });
    expect(batch.auditEntries[0]!.metadata).toMatchObject({
      source: 'admin-moderation',
      seat_user_id: 'seat-1',
      license_id: 'l-banned',
    });
    await run(batch);
    expect(await licenseOf('l-banned')).toMatchObject({
      cancelAtTermEnd: false,
      cancelReason: null,
    });
    expect(await licenseOf('l-other')).toMatchObject({ cancelAtTermEnd: true, cancelReason: null });
    expect(await licenseOf('l-ended')).toMatchObject({
      cancelAtTermEnd: true,
      cancelReason: 'vendor-banned',
    });
    expect(await licenseOf('l-foreign')).toMatchObject({
      cancelAtTermEnd: true,
      cancelReason: 'vendor-banned',
    });
  });

  it('is the empty no-op when nothing is flagged vendor-banned', async () => {
    await seedLicense('l-other', { cancelAtTermEnd: true, cancelReason: null });
    const batch = await clearVendorBannedFlagsStatements(t.db, params);
    expect(batch.stmts).toHaveLength(0);
    expect(batch.auditEntries).toHaveLength(0);
  });
});

// ─── End ─────────────────────────────────────────────────────────────────────

describe('endLicensesStatements', () => {
  it('ends by id, KEEPS assigned_product_id, and drops the mirror on the last live one', async () => {
    await seedLicense('l-1', { assignedProductId: P1, assignedAt: OLD_TS });
    await setVerified(true);
    const batch = endLicensesStatements(t.db, {
      ...(await ctx()),
      target: { licenseIds: ['l-1'] },
      endReason: 'lapsed',
    });
    expect(batch.verifiedFlipped).toBe(true);
    await run(batch);
    expect(await licenseOf('l-1')).toMatchObject({
      endedAt: NOW,
      endReason: 'lapsed',
      assignedProductId: P1,
      cancelReason: null,
    });
    expect(await vendorOf()).toMatchObject({ verified: false, updatedAt: NOW });
    const [row] = await audits();
    expect(row).toMatchObject({
      action: 'license.lapsed',
      entityType: 'billing_account',
      productId: P1,
      vendorTier: 'verified',
      vendorEntitlementStatus: 'active',
    });
    expect(row!.metadata).toMatchObject({ license_id: 'l-1' });
    expect(row!.afterState).toMatchObject({ ended_at: NOW, end_reason: 'lapsed' });
  });

  it('ends every live license on a Stripe subscription, and only those', async () => {
    await seedLicense('l-1', { stripeSubscriptionId: 'sub_1', source: 'stripe' });
    await seedLicense('l-2', { stripeSubscriptionId: 'sub_1', source: 'stripe' });
    await seedLicense('l-3', { stripeSubscriptionId: 'sub_2', source: 'stripe' });
    await setVerified(true);
    const batch = endLicensesStatements(t.db, {
      ...(await ctx()),
      target: { stripeSubscriptionId: 'sub_1' },
      endReason: 'lapsed',
    });
    expect(batch.auditEntries).toHaveLength(2);
    expect(batch.verifiedFlipped).toBe(false);
    await run(batch);
    expect((await licenseOf('l-1')).endedAt).toBe(NOW);
    expect((await licenseOf('l-2')).endedAt).toBe(NOW);
    expect((await licenseOf('l-3')).endedAt).toBeNull();
    // l-3 is still live: the mirror does not move, nor does updated_at.
    expect(await vendorOf()).toMatchObject({ verified: true, updatedAt: OLD_TS });
  });

  it('a revoke stores end_reason, leaves cancel_reason alone, and the snapshot reads it', async () => {
    await seedLicense('l-1', { cancelAtTermEnd: true, cancelReason: 'vendor-banned' });
    await setVerified(true);
    await run(
      endLicensesStatements(t.db, {
        ...(await ctx()),
        target: { licenseIds: ['l-1'] },
        endReason: 'revoked',
        reason: 'misrepresentation',
      }),
    );
    expect(await licenseOf('l-1')).toMatchObject({
      endedAt: NOW,
      endReason: 'revoked',
      cancelReason: 'vendor-banned',
    });
    expect((await audits())[0]).toMatchObject({ action: 'license.revoked' });

    // The next write's snapshot now records the revoked plan.
    const next = await ctx();
    const later = grantLicensesStatements(t.db, {
      ...next,
      billingAccountId: ACCOUNT_ID,
      count: 1,
      licenseSource: 'complimentary',
      endsAt: null,
    });
    expect(later.auditEntries[0]!.vendorPlan).toEqual({ tier: 'verified', status: 'revoked' });
  });

  it('throws on an end reason outside the vocabulary', async () => {
    await seedLicense('l-1');
    const c = await ctx();
    expect(() =>
      endLicensesStatements(t.db, {
        ...c,
        target: { licenseIds: ['l-1'] },
        endReason: 'expired' as 'lapsed',
      }),
    ).toThrow(RangeError);
  });

  it('is the frozen no-op when no target is live', async () => {
    await seedLicense('l-ended', { endedAt: OLD_TS });
    const c = await ctx();
    expect(
      endLicensesStatements(t.db, {
        ...c,
        target: { licenseIds: ['l-ended'] },
        endReason: 'lapsed',
      }).stmts,
    ).toHaveLength(0);
    expect(
      endLicensesStatements(t.db, {
        ...c,
        target: { stripeSubscriptionId: 'sub_none' },
        endReason: 'released',
      }).stmts,
    ).toHaveLength(0);
  });
});

describe('endLicensesStatements — expectEndsAt (AECI-1404)', () => {
  const TERM = '2027-10-14T00:00:00.000Z';

  it('guards the UPDATE on the scanned ends_at, so an extend that lands first wins', async () => {
    await seedLicense('l-1', { endsAt: TERM });
    const batch = endLicensesStatements(t.db, {
      ...(await ctx()),
      target: { licenseIds: ['l-1'] },
      endReason: 'lapsed',
      expectEndsAt: TERM,
    });
    expect(sqlOf(batch.stmts[0]!).sql).toMatch(/"ends_at" = \?/);
    // An admin extend commits between the read and the batch.
    await t.db.update(licenses).set({ endsAt: '2028-10-14T00:00:00.000Z' });
    await run(batch);
    expect((await licenseOf('l-1')).endedAt).toBeNull();
  });

  it('skips a target whose pre-read ends_at is not the expected term', async () => {
    await seedLicense('l-1', { endsAt: '2028-10-14T00:00:00.000Z' });
    const batch = endLicensesStatements(t.db, {
      ...(await ctx()),
      target: { licenseIds: ['l-1'] },
      endReason: 'lapsed',
      expectEndsAt: TERM,
    });
    expect(batch.stmts).toHaveLength(0);
  });
});

describe('lapseTermStatements (AECI-1404)', () => {
  const TERM = '2027-10-14T00:00:00.000Z';

  it('ends the term: flagged licenses released, the rest lapsed, one reconcile', async () => {
    await setVerified(true);
    await seedLicense('l-1', { endsAt: TERM, assignedProductId: P1, assignedAt: OLD_TS });
    await seedLicense('l-2', {
      endsAt: TERM,
      assignedProductId: P2,
      assignedAt: OLD_TS,
      releaseAtRenewal: true,
    });
    await seedLicense('l-pool', { endsAt: TERM });
    // Another term on the same account, and a monthly license: neither is touched.
    await seedLicense('l-later', { endsAt: '2028-10-14T00:00:00.000Z' });
    await seedLicense('l-monthly', { endsAt: null });

    const batch = lapseTermStatements(t.db, {
      ...(await ctx()),
      actorId: null,
      actorType: 'system',
      billingAccountId: ACCOUNT_ID,
      endsAt: TERM,
    });
    expect(batch.stmts.filter(touchesVendors)).toHaveLength(1);
    expect(batch.verifiedFlipped).toBe(false);
    expect(batch.ended).toEqual(
      expect.arrayContaining([
        { licenseId: 'l-1', productId: P1, cause: 'lapsed' },
        { licenseId: 'l-2', productId: P2, cause: 'released' },
        { licenseId: 'l-pool', productId: null, cause: 'lapsed' },
      ]),
    );
    expect(batch.ended).toHaveLength(3);
    await run(batch);

    expect(await licenseOf('l-1')).toMatchObject({
      endedAt: NOW,
      endReason: 'lapsed',
      assignedProductId: P1,
    });
    expect(await licenseOf('l-2')).toMatchObject({ endedAt: NOW, endReason: 'released' });
    expect((await licenseOf('l-later')).endedAt).toBeNull();
    expect((await licenseOf('l-monthly')).endedAt).toBeNull();
    const actions = (await audits()).map((a) => a.action).sort();
    expect(actions).toEqual(['license.lapsed', 'license.lapsed', 'license.released']);
  });

  it('predicts the flip once, over the whole term', async () => {
    await setVerified(true);
    await seedLicense('l-1', { endsAt: TERM, assignedProductId: P1, assignedAt: OLD_TS });
    await seedLicense('l-2', { endsAt: TERM, releaseAtRenewal: true, assignedProductId: P2 });
    const batch = lapseTermStatements(t.db, {
      ...(await ctx()),
      billingAccountId: ACCOUNT_ID,
      endsAt: TERM,
    });
    expect(batch.verifiedFlipped).toBe(true);
    for (const entry of batch.auditEntries) {
      expect(entry.metadata).toMatchObject({ verified_flipped: true });
    }
    await run(batch);
    expect((await vendorOf()).verified).toBe(false);
  });

  it('is empty when nothing on the term is live', async () => {
    await seedLicense('l-1', { endsAt: TERM, endedAt: OLD_TS, endReason: 'revoked' });
    const batch = lapseTermStatements(t.db, {
      ...(await ctx()),
      billingAccountId: ACCOUNT_ID,
      endsAt: TERM,
    });
    expect(batch.stmts).toHaveLength(0);
    expect(batch.ended).toEqual([]);
  });
});

// ─── The mirror reconcile ────────────────────────────────────────────────────

describe('the mirror reconcile', () => {
  /** One non-no-op batch from every builder, built against one pre-read. */
  async function everyBuilder(): Promise<LicenseBatch[]> {
    await seedLicense('l-free');
    await seedLicense('l-held', { assignedProductId: P1, assignedAt: OLD_TS });
    const c = await ctx();
    return [
      grantLicensesStatements(t.db, {
        ...c,
        billingAccountId: ACCOUNT_ID,
        count: 1,
        licenseSource: 'complimentary',
        endsAt: null,
      }),
      assignLicenseStatements(t.db, { ...c, licenseId: 'l-free', productId: P2 }),
      unassignLicenseStatements(t.db, { ...c, licenseId: 'l-held' }),
      setReleaseAtRenewalStatements(t.db, { ...c, licenseId: 'l-held', release: true }),
      setCancelAtTermEndStatements(t.db, { ...c, licenseIds: ['l-held'], cancel: true }),
      endLicensesStatements(t.db, {
        ...c,
        target: { licenseIds: ['l-held'] },
        endReason: 'lapsed',
      }),
      // AECI-1353.
      setLicensesTermStatements(t.db, { ...c, licenseIds: ['l-held'], endsAt: '2028-01-01' }),
      // AECI-1404.
      lapseTermStatements(t.db, {
        ...c,
        billingAccountId: ACCOUNT_ID,
        endsAt: '2027-10-14T00:00:00.000Z',
      }),
    ];
  }

  it('is the last statement, the only vendors statement, and identical across builders', async () => {
    const batches = await everyBuilder();
    const expected = sqlOf(reconcileVerifiedMirror(t.db, VENDOR_ID, NOW));
    for (const batch of batches) {
      expect(batch.stmts.length).toBeGreaterThan(0);
      expect(batch.stmts.filter(touchesVendors)).toHaveLength(1);
      expect(sqlOf(batch.stmts.at(-1)!)).toEqual(expected);
    }
  });

  it('writes verified as EXISTS(live license) guarded on verified <> EXISTS', () => {
    const { sql } = sqlOf(reconcileVerifiedMirror(t.db, VENDOR_ID, NOW));
    expect(sql).toMatch(/set "verified" = exists \(select 1 from "licenses"/i);
    expect(sql).toMatch(/"licenses"\."ended_at" is null/i);
    expect(sql).toMatch(/"vendors"\."verified" <> exists \(/i);
  });

  it('every builder emits exactly one audit row per license statement', async () => {
    for (const batch of await everyBuilder()) {
      // license statements + audit rows + 1 reconcile.
      expect(batch.stmts).toHaveLength(batch.auditEntries.length * 2 + 1);
    }
  });

  it('every no-op is the same frozen empty batch', async () => {
    await seedLicense('l-ended', { endedAt: OLD_TS });
    const c = await ctx();
    const noOps = [
      grantLicensesStatements(t.db, {
        ...c,
        billingAccountId: ACCOUNT_ID,
        count: 0,
        licenseSource: 'stripe',
        endsAt: null,
      }),
      assignLicenseStatements(t.db, { ...c, licenseId: 'l-ended', productId: P1 }),
      unassignLicenseStatements(t.db, { ...c, licenseId: 'l-ended' }),
      setReleaseAtRenewalStatements(t.db, { ...c, licenseId: 'l-ended', release: true }),
      setCancelAtTermEndStatements(t.db, { ...c, licenseIds: ['l-ended'], cancel: true }),
      endLicensesStatements(t.db, {
        ...c,
        target: { licenseIds: ['l-ended'] },
        endReason: 'lapsed',
      }),
      // AECI-1353.
      setLicensesTermStatements(t.db, { ...c, licenseIds: ['l-ended'], endsAt: null }),
    ];
    for (const batch of noOps) {
      expect(batch).toBe(noOps[0]);
      expect(Object.isFrozen(batch)).toBe(true);
      expect(Object.isFrozen(batch.stmts)).toBe(true);
      expect(batch).toEqual({ stmts: [], auditEntries: [], verifiedFlipped: false });
    }
  });

  it('leaves a correct mirror alone and lifts a drifted one on the next write', async () => {
    await setVerified(true);
    await seedLicense('l-ended', { endedAt: OLD_TS });
    await seedLicense('l-2', { assignedProductId: P1, assignedAt: OLD_TS });
    await run(
      setReleaseAtRenewalStatements(t.db, { ...(await ctx()), licenseId: 'l-2', release: true }),
    );
    // l-2 is live, so true stays true and updated_at stays put (R2).
    expect(await vendorOf()).toMatchObject({ verified: true, updatedAt: OLD_TS });

    // verified = 0 with a live license (drift): a write that moves no license state
    // across "live" still reconciles it.
    await setVerified(false);
    await run(
      setReleaseAtRenewalStatements(t.db, { ...(await ctx()), licenseId: 'l-2', release: false }),
    );
    expect(await vendorOf()).toMatchObject({ verified: true, updatedAt: NOW });
  });

  it("never touches another vendor's mirror", async () => {
    await seedLicense('l-x', { billingAccountId: OTHER_ACCOUNT_ID });
    await run(
      grantLicensesStatements(t.db, {
        ...(await ctx()),
        billingAccountId: ACCOUNT_ID,
        count: 1,
        licenseSource: 'complimentary',
        endsAt: null,
      }),
    );
    expect((await vendorOf(OTHER_VENDOR_ID)).verified).toBe(false);
  });
});

// ─── Term (AECI-1353) ────────────────────────────────────────────────────────

describe('setLicensesTermStatements', () => {
  it('moves ends_at, source and reference on live licenses, one audit row each', async () => {
    await setVerified(true);
    await seedLicense('l-1', { expiryNoticeSentAt: OLD_TS, reference: 'PO-1' });
    await seedLicense('l-2', { assignedProductId: P1, assignedAt: OLD_TS });
    await seedLicense('l-ended', { endedAt: OLD_TS });

    const batch = setLicensesTermStatements(t.db, {
      ...(await ctx()),
      licenseIds: ['l-1', 'l-2', 'l-ended', 'l-1'],
      endsAt: '2028-01-31',
      licenseSource: 'invoice',
      reference: 'PO-2',
      source: 'admin-entitlement',
    });
    await run(batch);

    expect(batch.auditEntries).toHaveLength(2);
    expect(batch.verifiedFlipped).toBe(false);
    for (const id of ['l-1', 'l-2']) {
      expect(await licenseOf(id)).toMatchObject({
        endsAt: '2028-01-31T00:00:00.000Z',
        source: 'invoice',
        reference: 'PO-2',
        updatedAt: NOW,
        endedAt: null,
      });
    }
    // A new term earns its own expiry notice.
    expect((await licenseOf('l-1')).expiryNoticeSentAt).toBeNull();
    // Ended licenses are history; no un-end, no re-term.
    expect((await licenseOf('l-ended')).endsAt).toBe('2027-10-14T00:00:00.000Z');

    const rows = await audits();
    expect(rows.map((r) => r.action)).toEqual(['license.term_changed', 'license.term_changed']);
    expect(rows[1]).toMatchObject({
      entityType: 'billing_account',
      entityId: ACCOUNT_ID,
      vendorId: VENDOR_ID,
      productId: P1,
    });
    // `licenseSource` is the license's; `source` stays the audit tag.
    expect(rows[0]!.metadata).toMatchObject({ license_id: 'l-1', source: 'admin-entitlement' });
    // The mirror was right, so `updated_at` stays put (R2).
    expect(await vendorOf()).toMatchObject({ verified: true, updatedAt: OLD_TS });
  });

  it('leaves source and reference alone when absent, and keeps the fence when ends_at holds', async () => {
    await seedLicense('l-1', { expiryNoticeSentAt: OLD_TS, reference: 'PO-1' });
    await run(
      setLicensesTermStatements(t.db, {
        ...(await ctx()),
        licenseIds: ['l-1'],
        endsAt: '2027-10-14T00:00:00.000Z',
        reference: 'PO-9',
      }),
    );
    expect(await licenseOf('l-1')).toMatchObject({
      source: 'complimentary',
      reference: 'PO-9',
      expiryNoticeSentAt: OLD_TS,
    });
  });

  it('expectUnchanged matches no row once ends_at, source or reference moved since the read', async () => {
    await seedLicense('l-1', { reference: 'PO-1' });
    const c = await ctx();
    const build = () =>
      setLicensesTermStatements(t.db, {
        ...c,
        licenseIds: ['l-1'],
        endsAt: '2028-01-31',
        expectUnchanged: true,
      });
    for (const moved of [
      { endsAt: '2029-01-01T00:00:00.000Z' },
      { source: 'invoice' as const },
      { reference: null },
    ]) {
      await t.db.update(licenses).set(moved).where(eq(licenses.id, 'l-1'));
      await run(build());
      expect((await licenseOf('l-1')).endsAt).not.toBe('2028-01-31T00:00:00.000Z');
      // Put the read values back for the next axis.
      await t.db
        .update(licenses)
        .set({ endsAt: '2027-10-14T00:00:00.000Z', source: 'complimentary', reference: 'PO-1' })
        .where(eq(licenses.id, 'l-1'));
    }
    // Unmoved, including a NULL compared NULL-safe: the guarded UPDATE lands.
    await run(build());
    expect((await licenseOf('l-1')).endsAt).toBe('2028-01-31T00:00:00.000Z');
  });

  it('expectUnchanged compares a NULL ends_at and reference NULL-safe', async () => {
    await seedLicense('l-1', { endsAt: null, reference: null });
    await run(
      setLicensesTermStatements(t.db, {
        ...(await ctx()),
        licenseIds: ['l-1'],
        endsAt: '2028-01-31',
        expectUnchanged: true,
      }),
    );
    expect((await licenseOf('l-1')).endsAt).toBe('2028-01-31T00:00:00.000Z');
  });

  it('is the frozen no-op when nothing changes, and throws on an unknown source', async () => {
    await seedLicense('l-1');
    const c = await ctx();
    const same = setLicensesTermStatements(t.db, {
      ...c,
      licenseIds: ['l-1'],
      endsAt: '2027-10-14',
    });
    expect(same.stmts).toHaveLength(0);
    expect(Object.isFrozen(same)).toBe(true);
    expect(() =>
      setLicensesTermStatements(t.db, {
        ...c,
        licenseIds: ['l-1'],
        endsAt: null,
        licenseSource: 'barter' as never,
      }),
    ).toThrow(RangeError);
  });
});

describe('loadOwnedProductLicenseState', () => {
  it("lists the vendor's owned products and whether any live license holds each", async () => {
    await t.db.insert(productVendors).values([
      { productId: P2, vendorId: VENDOR_ID, isPrimary: true },
      { productId: P1, vendorId: VENDOR_ID, isPrimary: true },
      // Co-owned: another vendor's live license holds P1.
      { productId: P1, vendorId: OTHER_VENDOR_ID, isPrimary: false },
    ]);
    await seedLicense('l-x', {
      billingAccountId: OTHER_ACCOUNT_ID,
      assignedProductId: P1,
      assignedAt: OLD_TS,
    });
    // An ended license on P2 does not hold it.
    await seedLicense('l-old', { assignedProductId: P2, assignedAt: OLD_TS, endedAt: OLD_TS });

    expect(await loadOwnedProductLicenseState(t.db, VENDOR_ID)).toEqual([
      { productId: P1, licensed: true },
      { productId: P2, licensed: false },
    ]);
  });
});

// Keep the pre-read type honest: a Drizzle row projection is a LicenseBefore.
const _typecheck: (rows: Awaited<ReturnType<typeof loadVendorLicenses>>) => LicenseBefore[] = (
  rows,
) => rows;
void _typecheck;
