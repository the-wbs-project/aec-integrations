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
 *      flip to `true`); miss it and a lapsed vendor keeps a Verified badge in Algolia
 *      indefinitely (R2).
 *   3. Neither builder ever emits one side of the *iff* without the other.
 *
 * Statements are asserted by OBSERVED EFFECT (build → `db.batch` → read the rows back)
 * rather than by inspecting SQL: the harness's `batch()` shim is a real better-sqlite3
 * transaction over the real migrations, so a broken guard or a violated index fails the
 * way it would on D1.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, profiles, vendorEntitlements, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { type BatchStmt, type BatchTuple } from './audit';
import {
  activateEntitlementStatements,
  deactivateEntitlementStatements,
  loadEntitlement,
  renewEntitlementStatements,
  type EntitlementBefore,
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

const activateArgs = (existing: EntitlementBefore | null, vendorWasVerified: boolean) => ({
  vendorId: VENDOR_ID,
  tier: 'verified',
  now: NOW,
  actorId: ADMIN_ID,
  actorType: 'admin' as const,
  existing,
  vendorWasVerified,
  grantedBy: ADMIN_ID,
});

const deactivateArgs = (existing: EntitlementBefore | null, vendorWasVerified: boolean) => ({
  vendorId: VENDOR_ID,
  terminal: 'revoked' as const,
  now: NOW,
  actorId: ADMIN_ID,
  actorType: 'admin' as const,
  existing,
  vendorWasVerified,
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

    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('vendor_entitlement.set');
    expect(rows[0]!.entityType).toBe('vendor_entitlement');
    // entity_id is the VENDOR id — that is what makes audit_log the history ledger.
    expect(rows[0]!.entityId).toBe(VENDOR_ID);
    expect(rows[0]!.metadata).toMatchObject({
      verified_flipped: true,
      entitlement_created: true,
      vendor_id: VENDOR_ID,
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
    // lapsed vendor keeps a Verified badge in search indefinitely.
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
      expect(batch.stmts).toHaveLength(3);
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

  const renewArgs = (existing: EntitlementBefore | null) => ({
    vendorId: VENDOR_ID,
    now: NOW,
    actorId: ADMIN_ID,
    actorType: 'admin' as const,
    existing,
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
