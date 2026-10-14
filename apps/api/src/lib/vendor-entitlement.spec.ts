/**
 * The mirror sole-writer contract (AECI-609 / `docs/STAGE_2_PAID_TIERS_SPEC.md` §2).
 *
 * These are INVARIANT tests (§10) — they encode decisions, not behaviour, and must not
 * be deleted without reopening the spec. Three of them in particular:
 *
 *   1. The §2.3 second-seat matrix: an already-`active` row emits ZERO statements. An
 *      INSERT there would violate `vendor_entitlements_vendor_key` and roll back the
 *      entire seat grant — proven directly below, not just asserted about.
 *   2. `vendors.updated_at` moves IFF `vendors.verified` moves, in BOTH directions.
 *      The un-verify direction had never been tested (AECI-529 only reasoned about the
 *      flip to `true`). Missing it once left a lapsed vendor's `verified: true` on its
 *      Algolia record indefinitely (R2). The record drops the field since AECI-1266,
 *      and the stamp still feeds the portal's updates cursor.
 *   3. Neither builder ever emits one side of the *iff* without the other.
 *
 * Statements are asserted by OBSERVED EFFECT (build → `db.batch` → read the rows back)
 * rather than by inspecting SQL: the harness's `batch()` shim is a real better-sqlite3
 * transaction over the real migrations, so a broken guard or a violated index fails the
 * way it would on D1.
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
  vendorEntitlements,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { type BatchStmt, type BatchTuple } from './audit';
import {
  activateEntitlementStatements,
  deactivateEntitlementStatements,
  loadEntitlement,
  loadLicenseDualWrite,
  renewEntitlementStatements,
  type EntitlementBefore,
  type LicenseDualWriteBefore,
} from './vendor-entitlement';

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const OLD_TS = '2020-01-01T00:00:00.000Z';
const NOW = '2026-08-14T12:00:00.000Z';

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

async function seedVendor(overrides: { verified?: boolean; updatedAt?: string } = {}) {
  await t.db.insert(vendors).values({
    id: VENDOR_ID,
    slug: 'autodesk',
    companyName: 'Autodesk',
    verified: overrides.verified ?? false,
    updatedAt: overrides.updatedAt ?? OLD_TS,
  });
}

async function seedAdmin() {
  await t.db.insert(profiles).values({ id: ADMIN_ID, role: 'admin' });
}

/** Insert an entitlement row directly (bypassing the builders) to set up a state. */
async function seedEntitlement(status: string, periodEnd: string | null = null) {
  await t.db.insert(vendorEntitlements).values({
    vendorId: VENDOR_ID,
    tier: 'verified',
    status,
    periodEnd,
    grantedAt: OLD_TS,
    endedAt: status === 'active' ? null : OLD_TS,
    expiryNoticeSentAt: status === 'active' ? null : OLD_TS,
    createdAt: OLD_TS,
    updatedAt: OLD_TS,
  });
}

const vendorOf = async () =>
  (await t.db.select().from(vendors).where(eq(vendors.id, VENDOR_ID)))[0];
const entitlementOf = async () =>
  (
    await t.db.select().from(vendorEntitlements).where(eq(vendorEntitlements.vendorId, VENDOR_ID))
  )[0];
const audits = async () => t.db.select().from(auditLog);
/** The entitlement ledger only: the dual-write adds `billing_account` rows (AECI-1353). */
const entitlementAudits = async () =>
  (await audits()).filter((a) => a.entityType === 'vendor_entitlement');

/** The license-side pre-read of a vendor with no account, no license, no product. */
const NO_LICENSES: LicenseDualWriteBefore = {
  billingAccount: null,
  vendorLicenses: [],
  ownedProducts: [],
};

const activateArgs = (
  existing: EntitlementBefore | null,
  vendorWasVerified: boolean,
  licenses: LicenseDualWriteBefore = NO_LICENSES,
) => ({
  vendorId: VENDOR_ID,
  tier: 'verified',
  now: NOW,
  actorId: ADMIN_ID,
  actorType: 'admin' as const,
  existing,
  vendorWasVerified,
  grantedBy: ADMIN_ID,
  licenses,
  vendorName: 'Autodesk',
});

const deactivateArgs = (
  existing: EntitlementBefore | null,
  vendorWasVerified: boolean,
  licenses: LicenseDualWriteBefore = NO_LICENSES,
) => ({
  vendorId: VENDOR_ID,
  terminal: 'revoked' as const,
  now: NOW,
  actorId: ADMIN_ID,
  actorType: 'admin' as const,
  existing,
  vendorWasVerified,
  licenses,
});

// ─── loadEntitlement ─────────────────────────────────────────────────────────

describe('loadEntitlement', () => {
  it('returns null when the vendor has never had an entitlement', async () => {
    await seedVendor();
    expect(await loadEntitlement(t.db, VENDOR_ID)).toBeNull();
  });

  it('returns the branch + audit columns for an existing row', async () => {
    await seedVendor({ verified: true });
    await seedEntitlement('active', '2030-01-01T00:00:00.000Z');
    expect(await loadEntitlement(t.db, VENDOR_ID)).toMatchObject({
      tier: 'verified',
      status: 'active',
      periodEnd: '2030-01-01T00:00:00.000Z',
    });
  });
});

// ─── §2.3 activate matrix ────────────────────────────────────────────────────

describe('activateEntitlementStatements — the §2.3 matrix', () => {
  it('row 1 (no row): INSERTs the entitlement, flips verified, bumps updated_at, audits', async () => {
    await seedVendor({ verified: false, updatedAt: OLD_TS });
    await seedAdmin();

    const batch = activateEntitlementStatements(t.db, {
      ...activateArgs(null, false),
      arrangement: { payer: 'Autodesk AP', amount: 'USD 5,000 / yr', period_end: '2030-01-01' },
      sourceRequestId: null,
    });
    await t.db.batch(batch.stmts as BatchTuple);

    expect(batch.entitlementCreated).toBe(true);
    expect(batch.verifiedFlipped).toBe(true);
    expect(batch.reactivated).toBe(false);

    const ent = await entitlementOf();
    expect(ent).toMatchObject({
      status: 'active',
      tier: 'verified',
      payer: 'Autodesk AP',
      amount: 'USD 5,000 / yr',
      periodEnd: '2030-01-01',
      grantedBy: ADMIN_ID,
    });
    expect(ent!.endedAt).toBeNull();

    // The mirror moved, and `updated_at` moved with it (R2).
    const vendor = await vendorOf();
    expect(vendor!.verified).toBe(true);
    expect(vendor!.updatedAt).toBe(NOW);

    const rows = await entitlementAudits();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('vendor_entitlement.set');
    expect(rows[0]!.entityType).toBe('vendor_entitlement');
    // entity_id is the VENDOR id — that is what makes audit_log the history ledger.
    expect(rows[0]!.entityId).toBe(VENDOR_ID);
    expect(rows[0]!.metadata).toMatchObject({
      verified_flipped: true,
      entitlement_created: true,
      // AECI-1192: new rows spell the key camelCase; the column is canonical.
      vendorId: VENDOR_ID,
    });
    // AECI-1192 / AECI-1193: the vendor, and its plan BEFORE the grant (no row).
    expect(rows[0]).toMatchObject({
      vendorId: VENDOR_ID,
      vendorTier: 'none',
      vendorEntitlementStatus: 'none',
    });
  });

  it('row 2 (already active — the second-seat case): emits NOTHING at all', async () => {
    await seedVendor({ verified: true, updatedAt: OLD_TS });
    await seedEntitlement('active');

    const existing = await loadEntitlement(t.db, VENDOR_ID);
    const batch = activateEntitlementStatements(t.db, activateArgs(existing, true));

    expect(batch.stmts).toHaveLength(0);
    expect(batch.auditEntry).toBeNull();
    expect(batch.verifiedFlipped).toBe(false);
    expect(batch.entitlementCreated).toBe(false);
    expect(batch.reactivated).toBe(false);

    // Nothing to run, and therefore nothing churned.
    const vendor = await vendorOf();
    expect(vendor!.verified).toBe(true);
    expect(vendor!.updatedAt).toBe(OLD_TS);
    expect(await audits()).toHaveLength(0);
  });

  it('row 3 (inactive row — re-claim after revoke): UPDATEs to active and re-flips', async () => {
    await seedVendor({ verified: false, updatedAt: OLD_TS });
    await seedAdmin();
    await seedEntitlement('revoked');

    const existing = await loadEntitlement(t.db, VENDOR_ID);
    const batch = activateEntitlementStatements(t.db, {
      ...activateArgs(existing, false),
      arrangement: { period_end: '2031-01-01' },
    });
    await t.db.batch(batch.stmts as BatchTuple);

    expect(batch.entitlementCreated).toBe(false);
    expect(batch.reactivated).toBe(true);
    expect(batch.verifiedFlipped).toBe(true);

    const ent = await entitlementOf();
    expect(ent!.status).toBe('active');
    expect(ent!.periodEnd).toBe('2031-01-01');
    // Re-activation clears the terminal stamp AND the §7 idempotency fence, so the
    // new term earns its own expiry notice.
    expect(ent!.endedAt).toBeNull();
    expect(ent!.expiryNoticeSentAt).toBeNull();

    const vendor = await vendorOf();
    expect(vendor!.verified).toBe(true);
    expect(vendor!.updatedAt).toBe(NOW);

    expect((await audits())[0]!.metadata).toMatchObject({
      reactivated: true,
      entitlement_created: false,
      verified_flipped: true,
    });
  });

  it('row 2 matters: an unconditional INSERT would violate the unique index and roll the WHOLE batch back', async () => {
    await seedVendor({ verified: true });
    await seedEntitlement('active');

    // Simulate the bug the preload-and-emit-nothing branch prevents: a second
    // entitlement INSERT alongside an otherwise-benign statement.
    const bad: BatchStmt[] = [
      t.db.insert(vendorEntitlements).values({
        vendorId: VENDOR_ID,
        tier: 'verified',
        status: 'active',
        grantedAt: NOW,
      }),
      t.db.update(vendors).set({ companyName: 'Should Not Land' }).where(eq(vendors.id, VENDOR_ID)),
    ];

    await expect(t.db.batch(bad as BatchTuple)).rejects.toThrow();
    // The batch is atomic, so the benign statement rolled back with it — which is
    // exactly how a stray INSERT would take down the entire seat grant.
    expect((await vendorOf())!.companyName).toBe('Autodesk');
  });
});

// ─── deactivate ──────────────────────────────────────────────────────────────

describe('deactivateEntitlementStatements', () => {
  it('clears the mirror, stamps ended_at, and audits — leaving seats alone', async () => {
    await seedVendor({ verified: true, updatedAt: OLD_TS });
    await seedAdmin();
    await seedEntitlement('active', '2030-01-01T00:00:00.000Z');

    const existing = await loadEntitlement(t.db, VENDOR_ID);
    const batch = deactivateEntitlementStatements(t.db, deactivateArgs(existing, true));
    await t.db.batch(batch.stmts as BatchTuple);

    expect(batch.verifiedFlipped).toBe(true);

    const ent = await entitlementOf();
    expect(ent!.status).toBe('revoked');
    expect(ent!.endedAt).toBe(NOW);

    const vendor = await vendorOf();
    expect(vendor!.verified).toBe(false);

    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('vendor_entitlement.cleared');
    expect(rows[0]!.entityType).toBe('vendor_entitlement');
    expect(rows[0]!.metadata).toMatchObject({
      verified_flipped: true,
      terminal_status: 'revoked',
      // §5.2: clearing an entitlement is NOT a seat revoke and NOT a ban.
      seats_untouched: true,
    });
  });

  it('supports the amicable `expired` terminal as well as `revoked`', async () => {
    await seedVendor({ verified: true });
    await seedAdmin();
    await seedEntitlement('active');

    const existing = await loadEntitlement(t.db, VENDOR_ID);
    const batch = deactivateEntitlementStatements(t.db, {
      ...deactivateArgs(existing, true),
      terminal: 'expired',
    });
    await t.db.batch(batch.stmts as BatchTuple);

    expect((await entitlementOf())!.status).toBe('expired');
    expect((await vendorOf())!.verified).toBe(false);
  });

  it('is a no-op when there is no row, or the row is already inactive', async () => {
    await seedVendor({ verified: false });

    expect(deactivateEntitlementStatements(t.db, deactivateArgs(null, false)).stmts).toHaveLength(
      0,
    );

    await seedEntitlement('expired');
    const existing = await loadEntitlement(t.db, VENDOR_ID);
    const batch = deactivateEntitlementStatements(t.db, deactivateArgs(existing, false));
    expect(batch.stmts).toHaveLength(0);
    expect(batch.auditEntry).toBeNull();
  });

  it('does NOT self-heal drift by clearing verified with no entitlement transition behind it', async () => {
    // Down-drift (verified = 1, no active row) is the backfill script's job, not this
    // builder's — clearing the mirror here would be a write with nothing behind it.
    await seedVendor({ verified: true, updatedAt: OLD_TS });

    const batch = deactivateEntitlementStatements(t.db, deactivateArgs(null, true));
    expect(batch.stmts).toHaveLength(0);
    expect((await vendorOf())!.verified).toBe(true);
  });
});

// ─── R2: `vendors.updated_at` moves IFF `vendors.verified` moves ─────────────

describe('R2 — vendors.updated_at moves iff vendors.verified moves', () => {
  it('UP direction: bumps updated_at', async () => {
    await seedVendor({ verified: false, updatedAt: OLD_TS });
    await seedAdmin();

    const batch = activateEntitlementStatements(t.db, activateArgs(null, false));
    await t.db.batch(batch.stmts as BatchTuple);

    expect((await vendorOf())!.updatedAt).toBe(NOW);
  });

  it('DOWN direction: bumps updated_at (never tested before AECI-609 — R2)', async () => {
    // Without this, the nightly Algolia watermark never picks the flip up and a
    // lapsed vendor keeps `verified: true` on its Algolia record indefinitely.
    await seedVendor({ verified: true, updatedAt: OLD_TS });
    await seedAdmin();
    await seedEntitlement('active');

    const existing = await loadEntitlement(t.db, VENDOR_ID);
    const batch = deactivateEntitlementStatements(t.db, deactivateArgs(existing, true));
    await t.db.batch(batch.stmts as BatchTuple);

    expect((await vendorOf())!.verified).toBe(false);
    expect((await vendorOf())!.updatedAt).toBe(NOW);
  });

  it('a drifted self-heal creates the row WITHOUT bumping updated_at', async () => {
    // verified = 1 already, no entitlement row (the pre-backfill state). The guarded
    // `WHERE verified = 0` makes the vendors UPDATE a no-op, so the mirror does not
    // move and neither does the watermark — no needless nightly Algolia re-push.
    await seedVendor({ verified: true, updatedAt: OLD_TS });
    await seedAdmin();

    const batch = activateEntitlementStatements(t.db, activateArgs(null, true));
    await t.db.batch(batch.stmts as BatchTuple);

    expect(batch.verifiedFlipped).toBe(false);
    expect(await entitlementOf()).toBeDefined();
    const vendor = await vendorOf();
    expect(vendor!.verified).toBe(true);
    expect(vendor!.updatedAt).toBe(OLD_TS);
  });
});

// ─── The *iff*: never one side without the other ─────────────────────────────

describe('the mirror invariant — never one side of the iff without the other', () => {
  it('every non-empty batch carries an entitlement statement, a vendors statement, and an audit row', () => {
    // AECI-1353: the three lead every batch; the dual-write's license statements follow.
    const sqlOf = (stmt: BatchStmt) =>
      (stmt as unknown as { toSQL(): { sql: string } }).toSQL().sql;
    for (const batch of [
      activateEntitlementStatements(t.db, activateArgs(null, false)),
      activateEntitlementStatements(
        t.db,
        activateArgs({ id: 'e1', tier: 'verified', status: 'revoked', periodEnd: null }, false),
      ),
      deactivateEntitlementStatements(
        t.db,
        deactivateArgs({ id: 'e1', tier: 'verified', status: 'active', periodEnd: null }, true),
      ),
    ]) {
      const [entitlement, mirror, audit] = batch.stmts.map(sqlOf);
      expect(entitlement).toMatch(/^(insert into|update) "vendor_entitlements"/i);
      expect(mirror).toMatch(/^update "vendors" set "verified" = \?/i);
      expect(audit).toMatch(/^insert into "audit_log"/i);
      expect(batch.auditEntry).not.toBeNull();
    }
  });

  it('emits no workflow_instances row (§1.2 / R1 — the CHECK stays closed)', async () => {
    await seedVendor();
    await seedAdmin();
    const batch = activateEntitlementStatements(t.db, activateArgs(null, false));
    await t.db.batch(batch.stmts as BatchTuple);

    // `EntitlementBatch` has no `workflowEntry` field by design; prove nothing lands.
    const wf = await t.db.query.workflowInstances.findMany();
    expect(wf).toHaveLength(0);
  });
});

// ─── renew (AECI-532 / §5) ───────────────────────────────────────────────────

describe('renewEntitlementStatements', () => {
  const ACTIVE_BEFORE: EntitlementBefore = {
    id: 'e1',
    tier: 'verified',
    status: 'active',
    periodEnd: '2026-09-01',
  };

  const renewArgs = (
    existing: EntitlementBefore | null,
    licenses: LicenseDualWriteBefore = NO_LICENSES,
  ) => ({
    vendorId: VENDOR_ID,
    now: NOW,
    actorId: ADMIN_ID,
    actorType: 'admin' as const,
    existing,
    licenses,
  });

  /** Patch columns the shared `seedEntitlement` helper does not take. */
  const patchEntitlement = (values: Partial<typeof vendorEntitlements.$inferInsert>) =>
    t.db.update(vendorEntitlements).set(values).where(eq(vendorEntitlements.vendorId, VENDOR_ID));

  it('emits NO `vendors` statement — the mirror does not move on a renewal (R2)', async () => {
    await seedVendor({ verified: true });
    await seedAdmin();
    await seedEntitlement('active', '2026-09-01');

    const batch = renewEntitlementStatements(t.db, {
      ...renewArgs(ACTIVE_BEFORE),
      arrangement: { period_end: '2027-09-01' },
    });
    // Entitlement UPDATE + audit. A third statement here would be a `vendors` write
    // with no mirror transition behind it.
    expect(batch.stmts).toHaveLength(2);
    expect(batch.verifiedFlipped).toBe(false);
    for (const stmt of batch.stmts as unknown as { toSQL(): { sql: string } }[]) {
      expect(stmt.toSQL().sql).not.toMatch(/update\s+"?vendors"?/i);
    }

    await t.db.batch(batch.stmts as BatchTuple);
    const vendor = await vendorOf();
    expect(vendor!.verified).toBe(true);
    // The Algolia watermark must not move for a record whose indexed fields did not.
    expect(vendor!.updatedAt).toBe(OLD_TS);
    expect((await entitlementOf())!.periodEnd).toBe('2027-09-01');
  });

  it('patches only the supplied keys, keeping the arrangement recorded at grant time', async () => {
    await seedVendor({ verified: true });
    await seedAdmin();
    await seedEntitlement('active', '2026-09-01');
    await patchEntitlement({ invoiceRef: 'PO-1', payer: 'AP' });

    await t.db.batch(
      renewEntitlementStatements(t.db, {
        ...renewArgs(ACTIVE_BEFORE),
        arrangement: { period_end: '2027-09-01' },
      }).stmts as BatchTuple,
    );

    const row = await entitlementOf();
    expect(row!.periodEnd).toBe('2027-09-01');
    // A renewal that nulled these would destroy the paperwork the epic exists to keep.
    expect(row!.invoiceRef).toBe('PO-1');
    expect(row!.payer).toBe('AP');
  });

  it('clears the §7 fence only when a new period_end is supplied', async () => {
    await seedVendor({ verified: true });
    await seedAdmin();
    await seedEntitlement('active', '2026-09-01');
    await patchEntitlement({ expiryNoticeSentAt: '2026-08-01T00:00:00.000Z' });

    // Arrangement-only edit: the vendor already got this term's notice, so re-arming
    // the fence would send a duplicate.
    await t.db.batch(
      renewEntitlementStatements(t.db, {
        ...renewArgs(ACTIVE_BEFORE),
        arrangement: { invoice_ref: 'PO-2' },
      }).stmts as BatchTuple,
    );
    expect((await entitlementOf())!.expiryNoticeSentAt).toBe('2026-08-01T00:00:00.000Z');

    // A new term earns its own notice.
    await t.db.batch(
      renewEntitlementStatements(t.db, {
        ...renewArgs(ACTIVE_BEFORE),
        arrangement: { period_end: '2027-09-01' },
      }).stmts as BatchTuple,
    );
    expect((await entitlementOf())!.expiryNoticeSentAt).toBeNull();
  });

  it('is a no-op on a missing or non-active row (the §5 handler 422s that)', () => {
    expect(renewEntitlementStatements(t.db, renewArgs(null)).stmts).toHaveLength(0);
    expect(
      renewEntitlementStatements(
        t.db,
        renewArgs({ id: 'e1', tier: 'verified', status: 'revoked', periodEnd: null }),
      ).auditEntry,
    ).toBeNull();
  });
});

// ─── The dual-write (AECI-1353, E1.4) ────────────────────────────────────────

describe('the license dual-write', () => {
  const P1 = 'p-1';
  const P2 = 'p-2';
  const OTHER_VENDOR_ID = '33333333-3333-4333-8333-333333333333';

  async function seedProducts(...ids: string[]) {
    for (const id of ids) {
      await t.db.insert(products).values({ id, slug: id, name: id, promotionStatus: 'promoted' });
      await t.db.insert(productVendors).values({ productId: id, vendorId: VENDOR_ID });
    }
  }

  const licensesOf = async () => t.db.select().from(licenses).orderBy(licenses.assignedProductId);
  const preRead = () => loadLicenseDualWrite(t.db, VENDOR_ID);
  const run = async (stmts: BatchStmt[]) => {
    if (stmts.length > 0) await t.db.batch(stmts as BatchTuple);
  };

  /** AC 1: the licenses say what the entitlement row says. */
  async function expectLicensesMatchEntitlement() {
    const ent = (await entitlementOf())!;
    const vendor = (await vendorOf())!;
    const rows = await licensesOf();
    const live = rows.filter((l) => l.endedAt === null);
    expect(live.length > 0).toBe(ent.status === 'active');
    expect(vendor.verified).toBe(live.length > 0);
    for (const l of live) {
      expect(l.endsAt).toBe(ent.periodEnd ? new Date(ent.periodEnd).toISOString() : null);
    }
  }

  it('activate creates the account and one license per owned product, mapped from the row', async () => {
    await seedVendor({ verified: false, updatedAt: OLD_TS });
    await seedAdmin();
    await seedProducts(P1, P2);

    const batch = activateEntitlementStatements(t.db, {
      ...activateArgs(null, false, await preRead()),
      arrangement: { invoice_ref: 'PO-7', period_end: '2027-09-01' },
    });
    await run(batch.stmts);

    const [account] = await t.db.select().from(billingAccounts);
    expect(account).toMatchObject({ vendorId: VENDOR_ID, name: 'Autodesk', createdBy: ADMIN_ID });
    expect(batch.billingAccountCreatedId).toBe(account!.id);

    const rows = await licensesOf();
    expect(rows).toHaveLength(2);
    for (const [i, row] of rows.entries()) {
      expect(row).toMatchObject({
        billingAccountId: account!.id,
        source: 'invoice',
        startsAt: NOW,
        endsAt: '2027-09-01T00:00:00.000Z',
        endedAt: null,
        reference: 'PO-7',
        grantedBy: ADMIN_ID,
        assignedProductId: [P1, P2][i],
        assignedAt: NOW,
      });
    }

    // The flip moved the bit and `updated_at` once; the reconcile agreed (R2).
    expect(await vendorOf()).toMatchObject({ verified: true, updatedAt: NOW });

    // Entitlement row first, then the account, then one row per license.
    expect((await audits()).map((a) => a.action)).toEqual([
      'vendor_entitlement.set',
      'billing_account.created',
      'license.granted',
      'license.granted',
    ]);
    expect(batch.licenseAuditEntries.map((e) => e.action)).toEqual([
      'billing_account.created',
      'license.granted',
      'license.granted',
    ]);
    // The grant rows carry the entitlement row's audit tag, not the license source.
    expect(batch.licenseAuditEntries[1]!.metadata).toMatchObject({
      dual_write: 'vendor_entitlement',
      source: 'admin-entitlement',
    });
    expect(batch.licenseAuditEntries[0]!.metadata).toMatchObject({ source: 'admin-entitlement' });
    await expectLicensesMatchEntitlement();
  });

  it('a vendor with no products gets one unassigned license; period_end NULL is open-ended complimentary', async () => {
    await seedVendor();
    await seedAdmin();
    await t.db.insert(billingAccounts).values({ id: 'ba-1', vendorId: VENDOR_ID, name: 'A' });

    const batch = activateEntitlementStatements(t.db, {
      ...activateArgs(null, false, await preRead()),
      // The 2026-10-14 ruling: no end date wins over the invoice fields.
      arrangement: { invoice_ref: 'PO-1', amount: 'USD 5,000' },
    });
    await run(batch.stmts);

    // The account already existed: no second INSERT, no account audit row.
    expect(batch.billingAccountCreatedId).toBeNull();
    expect(await t.db.select().from(billingAccounts)).toHaveLength(1);
    const rows = await licensesOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      billingAccountId: 'ba-1',
      source: 'complimentary',
      endsAt: null,
      reference: 'PO-1',
      assignedProductId: null,
    });
    await expectLicensesMatchEntitlement();
  });

  it('a product another vendor already licenses stays unassigned instead of failing the batch', async () => {
    await seedVendor();
    await seedAdmin();
    await seedProducts(P1);
    await t.db.insert(vendors).values({ id: OTHER_VENDOR_ID, slug: 'other', companyName: 'O' });
    await t.db.insert(billingAccounts).values({ id: 'ba-x', vendorId: OTHER_VENDOR_ID, name: 'O' });
    await t.db.insert(licenses).values({
      id: 'l-x',
      billingAccountId: 'ba-x',
      source: 'complimentary',
      startsAt: OLD_TS,
      assignedProductId: P1,
      assignedAt: OLD_TS,
    });

    await run(
      activateEntitlementStatements(t.db, activateArgs(null, false, await preRead())).stmts,
    );

    const mine = (await licensesOf()).filter((l) => l.id !== 'l-x');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.assignedProductId).toBeNull();
    expect((await vendorOf())!.verified).toBe(true);
  });

  it('a reactivation over live licenses re-terms them and never grants a second set', async () => {
    await seedVendor();
    await seedAdmin();
    await seedProducts(P1);
    await seedEntitlement('revoked');
    await t.db.insert(billingAccounts).values({ id: 'ba-1', vendorId: VENDOR_ID, name: 'A' });
    await t.db.insert(licenses).values({
      id: 'l-1',
      billingAccountId: 'ba-1',
      source: 'complimentary',
      startsAt: OLD_TS,
      endsAt: '2026-01-01T00:00:00.000Z',
      assignedProductId: P1,
      assignedAt: OLD_TS,
    });

    const batch = activateEntitlementStatements(t.db, {
      ...activateArgs(await loadEntitlement(t.db, VENDOR_ID), false, await preRead()),
      arrangement: { period_end: '2028-01-01', amount: 'USD 1' },
    });
    await run(batch.stmts);

    const rows = await licensesOf();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'l-1',
      source: 'invoice',
      endsAt: '2028-01-01T00:00:00.000Z',
    });
    expect(batch.licenseAuditEntries.map((e) => e.action)).toEqual(['license.term_changed']);
    await expectLicensesMatchEntitlement();
  });

  it('a grant starts at period_start when the row has one; a re-term never moves it', async () => {
    await seedVendor();
    await seedAdmin();
    await run(
      activateEntitlementStatements(t.db, {
        ...activateArgs(null, false, await preRead()),
        arrangement: { period_start: '2026-09-01', period_end: '2027-09-01' },
      }).stmts,
    );
    expect((await licensesOf())[0]!.startsAt).toBe('2026-09-01T00:00:00.000Z');

    await run(
      renewEntitlementStatements(t.db, {
        vendorId: VENDOR_ID,
        now: LATER,
        actorId: ADMIN_ID,
        actorType: 'admin',
        existing: await loadEntitlement(t.db, VENDOR_ID),
        arrangement: { period_start: '2027-09-01', period_end: '2028-09-01' },
        licenses: await preRead(),
      }).stmts,
    );
    expect(await licensesOf()).toEqual([
      expect.objectContaining({
        startsAt: '2026-09-01T00:00:00.000Z',
        endsAt: '2028-09-01T00:00:00.000Z',
      }),
    ]);
  });

  it('the second-seat no-op is a no-op on the license side too', async () => {
    await seedVendor({ verified: true });
    await seedEntitlement('active');
    const batch = activateEntitlementStatements(
      t.db,
      activateArgs(await loadEntitlement(t.db, VENDOR_ID), true, await preRead()),
    );
    expect(batch.stmts).toHaveLength(0);
    expect(batch.licenseAuditEntries).toHaveLength(0);
    expect(batch.billingAccountCreatedId).toBeNull();
  });

  it('renew moves ends_at on the live licenses without moving vendors.updated_at', async () => {
    await seedVendor();
    await seedAdmin();
    await seedProducts(P1);
    await run(
      activateEntitlementStatements(t.db, {
        ...activateArgs(null, false, await preRead()),
        arrangement: { invoice_ref: 'PO-1', period_end: '2027-01-01' },
      }).stmts,
    );
    await t.db.update(vendors).set({ updatedAt: OLD_TS }).where(eq(vendors.id, VENDOR_ID));

    const batch = renewEntitlementStatements(t.db, {
      vendorId: VENDOR_ID,
      now: LATER,
      actorId: ADMIN_ID,
      actorType: 'admin',
      existing: await loadEntitlement(t.db, VENDOR_ID),
      arrangement: { period_end: '2028-01-01' },
      licenses: await preRead(),
    });
    await run(batch.stmts);

    const [license] = await licensesOf();
    // The invoice ref recorded at grant time still drives the source and reference.
    expect(license).toMatchObject({
      source: 'invoice',
      reference: 'PO-1',
      endsAt: '2028-01-01T00:00:00.000Z',
      updatedAt: LATER,
    });
    expect(batch.licenseAuditEntries.map((e) => e.action)).toEqual(['license.term_changed']);
    expect(batch.licenseAuditEntries[0]!.metadata).toMatchObject({
      source: 'admin-entitlement',
      dual_write: 'vendor_entitlement',
    });
    expect(await vendorOf()).toMatchObject({ verified: true, updatedAt: OLD_TS });
    await expectLicensesMatchEntitlement();
  });

  it.each([
    ['revoked', 'revoked'],
    ['expired', 'lapsed'],
  ] as const)(
    'deactivate %s ends every live license as %s; flip and reconcile converge on false',
    async (terminal, endReason) => {
      await seedVendor();
      await seedAdmin();
      await seedProducts(P1, P2);
      await run(
        activateEntitlementStatements(t.db, activateArgs(null, false, await preRead())).stmts,
      );
      await t.db.update(vendors).set({ updatedAt: OLD_TS }).where(eq(vendors.id, VENDOR_ID));

      const batch = deactivateEntitlementStatements(t.db, {
        ...deactivateArgs(await loadEntitlement(t.db, VENDOR_ID), true, await preRead()),
        terminal,
        now: LATER,
      });
      await run(batch.stmts);

      const rows = await licensesOf();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        // Hand-back: an ended license keeps its product (decision 14).
        expect(row).toMatchObject({ endedAt: LATER, endReason });
        expect(row.assignedProductId).not.toBeNull();
      }
      expect(await vendorOf()).toMatchObject({ verified: false, updatedAt: LATER });
      expect(batch.licenseAuditEntries.map((e) => e.action)).toEqual([
        `license.${endReason}`,
        `license.${endReason}`,
      ]);
      await expectLicensesMatchEntitlement();
    },
  );

  it('the guarded flip runs before the reconcile in every builder', async () => {
    await seedVendor();
    await seedAdmin();
    const sqlOf = (stmt: BatchStmt) =>
      (stmt as unknown as { toSQL(): { sql: string } }).toSQL().sql;
    const batch = activateEntitlementStatements(t.db, activateArgs(null, false));
    const vendorStmts = batch.stmts.map(sqlOf).filter((q) => /^update "vendors"/i.test(q));
    expect(vendorStmts).toHaveLength(2);
    expect(vendorStmts[0]).toMatch(/"verified" = \?, "updated_at" = \?/i);
    expect(vendorStmts[1]).toMatch(/"verified" = exists \(/i);
    expect(sqlOf(batch.stmts.at(-1)!)).toBe(vendorStmts[1]);
  });
});

const LATER = '2026-08-15T12:00:00.000Z';
