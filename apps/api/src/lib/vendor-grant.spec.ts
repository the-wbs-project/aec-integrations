/**
 * The claim batch-builders' sole-writer contract (AECI-612 /
 * `docs/STAGE_2_PAID_TIERS_SPEC.md` §6 step 8, §10 "Mirror sole-writer").
 *
 * This is an INVARIANT test (§10) — it encodes a decision, not behaviour, and must not
 * be deleted without reopening the spec.
 *
 * **`lib/vendor-grant.ts` must never emit a statement that touches `vendors`.**
 * `vendors.verified` is a denormalized MIRROR of `vendor_entitlements` (§2.1); the
 * *iff* it encodes is only safe under D1's no-interactive-transactions model if both
 * sides move inside one `db.batch`, so exactly one module emits both —
 * `lib/vendor-entitlement.ts`. AECI-519 originally shipped the flip here, and AECI-612
 * deleted it; `routes/admin-claims.ts` now concatenates
 * `activateEntitlementStatements` into the same batch.
 *
 * Two independent guards, because each catches what the other cannot:
 *
 *  1. **Structural** — the generated SQL of every statement, asserted not to name the
 *     `vendors` table. Catches a re-added write even if it happens to be a no-op in a
 *     given fixture (e.g. guarded on a state the fixture never has).
 *  2. **Observed effect** — run the grant batch ALONE against the in-memory D1 and
 *     assert the vendor row is byte-identical afterwards. Catches a write that evades
 *     the SQL match (`db.update(schema.vendors)`, raw SQL) — the same blind spot
 *     `eslint.config.base.mjs` records for Guard 1.
 *
 * The complement to this file is `vendor-entitlement.spec.ts`, which proves the mirror
 * DOES move — from the one module allowed to move it.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, profiles, vendorEntitlements, vendorRequests, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { type BatchStmt, type BatchTuple } from './audit';
import {
  grantSeatStatements,
  provisionSeatStatements,
  rejectClaimStatements,
  revokeSeatStatements,
  type ProvisionProfileBefore,
} from './vendor-grant';

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const CLAIMANT_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_ID = '44444444-4444-4444-8444-444444444444';
const OLD_TS = '2020-01-01T00:00:00.000Z';
const NOW = '2026-08-18T12:00:00.000Z';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

/**
 * The SQL a batch statement will run. `BatchItem<'sqlite'>` is `RunnableQuery`, which
 * does not declare `toSQL()` even though every Drizzle builder implements it — hence
 * the cast. Asserting on generated SQL (rather than on the builder's internals) is
 * what makes this guard survive a Drizzle upgrade.
 */
function sqlOf(stmt: BatchStmt): string {
  return (stmt as unknown as { toSQL(): { sql: string } }).toSQL().sql;
}

/** Statements whose SQL names the `vendors` table. Matches the QUOTED identifier so
 *  `"vendor_requests"` and `"vendor_entitlements"` are not false positives. */
function vendorsStatements(stmts: BatchStmt[]): string[] {
  return stmts.map(sqlOf).filter((sql) => /"vendors"/.test(sql));
}

const grantArgs = (vendorWasVerified: boolean) => ({
  userId: CLAIMANT_ID,
  vendorId: VENDOR_ID,
  requestId: REQUEST_ID,
  actorId: ADMIN_ID,
  actorType: 'admin' as const,
  resolvedAt: NOW,
  fromStatus: 'open',
  vendorWasVerified,
  workflowId: '55555555-5555-4555-8555-555555555555',
  existingWf: false,
  identityOutcome: 'linked' as const,
  seatCreated: true,
  profileBefore: null,
  reason: null,
  targetType: 'vendor',
  targetId: VENDOR_ID,
});

async function seed(verified: boolean) {
  await t.db.insert(profiles).values({ id: ADMIN_ID, role: 'admin' });
  await t.db.insert(vendors).values({
    id: VENDOR_ID,
    slug: 'autodesk',
    companyName: 'Autodesk, Inc.',
    verified,
    updatedAt: OLD_TS,
  });
  await t.db.insert(vendorRequests).values({
    id: REQUEST_ID,
    kind: 'claim',
    status: 'open',
    targetType: 'vendor',
    targetId: VENDOR_ID,
    submitterEmail: 'submitter@vendor.com',
    body: 'We build this and would like to claim the listing.',
  });
}

const vendorOf = async () =>
  (await t.db.select().from(vendors).where(eq(vendors.id, VENDOR_ID)))[0];

// ─── Guard 1: structural — no statement names `vendors` ──────────────────────

describe('the claim builders never emit a `vendors` statement (§6 step 8)', () => {
  it('grantSeatStatements emits five statements, none of them on vendors', () => {
    const { stmts } = grantSeatStatements(t.db, grantArgs(false));

    // The flip AECI-519 shipped here lived at index 1. It is gone.
    expect(vendorsStatements(stmts)).toEqual([]);
    expect(stmts).toHaveLength(5);
    // Positively: the seat, the request resolve, the workflow + its transition, the audit.
    const sql = stmts.map(sqlOf).join('\n');
    expect(sql).toContain('"profiles"');
    expect(sql).toContain('"vendor_requests"');
    expect(sql).toContain('"workflow_instances"');
    expect(sql).toContain('"workflow_transitions"');
    expect(sql).toContain('"audit_log"');
  });

  it('holds for the already-verified vendor too (not an artefact of the fixture)', () => {
    expect(vendorsStatements(grantSeatStatements(t.db, grantArgs(true)).stmts)).toEqual([]);
  });

  it('rejectClaimStatements and revokeSeatStatements are clean as well', () => {
    const reject = rejectClaimStatements(t.db, {
      requestId: REQUEST_ID,
      actorId: ADMIN_ID,
      actorType: 'admin',
      resolvedAt: NOW,
      fromStatus: 'open',
      workflowId: '55555555-5555-4555-8555-555555555555',
      existingWf: false,
      reason: null,
      targetType: 'vendor',
      targetId: VENDOR_ID,
    });
    const revoke = revokeSeatStatements(t.db, {
      userId: CLAIMANT_ID,
      vendorId: VENDOR_ID,
      actorId: ADMIN_ID,
      actorType: 'admin',
      now: NOW,
      profileBefore: { role: 'vendor_admin', vendorId: VENDOR_ID },
    });

    expect(vendorsStatements(reject.stmts)).toEqual([]);
    expect(vendorsStatements(revoke.stmts)).toEqual([]);
  });
});

// ─── Guard 2: observed effect — the vendor row is untouched ──────────────────

describe('running the grant batch alone leaves `vendors` byte-identical', () => {
  it('does not flip verified and does not churn updated_at', async () => {
    await seed(false);
    const before = await vendorOf();

    const { stmts } = grantSeatStatements(t.db, grantArgs(false));
    await t.db.batch(stmts as BatchTuple);

    const after = await vendorOf();
    // The seat DID land — this is a real grant, not a no-op batch.
    expect((await t.db.select().from(profiles).where(eq(profiles.id, CLAIMANT_ID)))[0]!.role).toBe(
      'vendor_admin',
    );
    // …and the vendor row is exactly as seeded. `verified` moves only when
    // `activateEntitlementStatements` is composed in (routes/admin-claims.ts).
    expect(after!.verified).toBe(false);
    expect(after!.updatedAt).toBe(OLD_TS);
    expect(after).toEqual(before);
  });
});

// ─── The audit shape is UNCHANGED (§6 step 2) ────────────────────────────────

describe('the claim audit row still records the verification outcome', () => {
  it('keeps verified_flipped + the before/after vendor_verified snapshots', async () => {
    await seed(false);
    const { stmts, auditEntry } = grantSeatStatements(t.db, grantArgs(false));
    await t.db.batch(stmts as BatchTuple);

    // Pure metadata with no statement behind it — which is exactly why deleting the
    // `vendors` UPDATE was invisible to every shipped claim assertion.
    expect(auditEntry.beforeState).toMatchObject({ vendor_verified: false });
    expect(auditEntry.afterState).toMatchObject({ vendor_verified: true });
    expect(auditEntry.metadata).toMatchObject({ verified_flipped: true });

    const rows = await t.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('vendor_claim.granted');
    expect(rows[0]!.metadata).toMatchObject({ verified_flipped: true });
  });

  it('reports verified_flipped: false for a second seat on an already-verified vendor', () => {
    const { auditEntry } = grantSeatStatements(t.db, grantArgs(true));
    expect(auditEntry.metadata).toMatchObject({ verified_flipped: false });
    expect(auditEntry.beforeState).toMatchObject({ vendor_verified: true });
  });
});

// ─── AECI-740: the standalone provision ──────────────────────────────────────

const provisionArgs = (before: ProvisionProfileBefore | null = null) => ({
  userId: CLAIMANT_ID,
  vendorId: VENDOR_ID,
  actorId: ADMIN_ID,
  actorType: 'admin' as const,
  now: NOW,
  identityOutcome: 'linked' as const,
  profileBefore: before,
  isPureConnectorVendor: true,
  reason: null,
});

describe('provisionSeatStatements is a seat and nothing else (§8.9(2))', () => {
  it('emits exactly two statements — the seat upsert and its audit row', () => {
    const { stmts } = provisionSeatStatements(t.db, provisionArgs());

    expect(stmts).toHaveLength(2);
    const sql = stmts.map(sqlOf).join('\n');
    expect(sql).toContain('"profiles"');
    expect(sql).toContain('"audit_log"');
  });

  it('names neither `vendors` nor `vendor_entitlements`', () => {
    // The §8.9(2) fence, structurally: `vendors.verified` mirrors off an ACTIVE
    // entitlement row, so a statement on either table would light the verified
    // badge this seat must never carry.
    const { stmts } = provisionSeatStatements(t.db, provisionArgs());
    const sql = stmts.map(sqlOf).join('\n');

    expect(vendorsStatements(stmts)).toEqual([]);
    expect(sql).not.toContain('"vendor_entitlements"');
    // And no workflow row: a seat is not a claim state change, and
    // `workflow_instances_type_check` is a closed CHECK besides.
    expect(sql).not.toContain('"workflow_instances"');
    expect(sql).not.toContain('"workflow_transitions"');
  });

  it('the upsert clobbers only role, vendor_id, seat_owner and updated_at', () => {
    // The §2 no-clobber contract. A provision landing after the holder's first
    // sign-in must not reset `display_name`, `work_email_verified`, `trust_tier`
    // — or, most importantly, the ban columns, whose sole writer is
    // `PATCH /api/admin/reviewers/:id` (`routes/banned-at-writers.spec.ts`).
    const [upsert] = provisionSeatStatements(t.db, provisionArgs()).stmts;
    const conflict = sqlOf(upsert!).split(/on conflict/i)[1] ?? '';

    expect(conflict).toContain('"role"');
    expect(conflict).toContain('"vendor_id"');
    expect(conflict).toContain('"seat_owner"');
    expect(conflict).toContain('"updated_at"');
    for (const forbidden of [
      '"banned_at"',
      '"ban_reason"',
      '"display_name"',
      '"work_email_verified"',
      '"trust_tier"',
      '"theme_preference"',
    ]) {
      expect(conflict).not.toContain(forbidden);
    }
  });

  it('says `entitlement_granted: false` out loud, and carries metadata.vendor_id', () => {
    const { auditEntry } = provisionSeatStatements(t.db, provisionArgs());
    const metadata = auditEntry.metadata as Record<string, unknown>;

    expect(auditEntry.action).toBe('vendor_seat.provisioned');
    expect(auditEntry.entityType).toBe('profile');
    expect(auditEntry.entityId).toBe(CLAIMANT_ID);
    expect(metadata['entitlement_granted']).toBe(false);
    // LOAD-BEARING: leg 3 of `auditScopeWhere` matches on this JSON path, and it
    // is the only leg that reaches a `vendor_seat.*` row on the vendor's own
    // audit tab. Without it the row exists and is invisible.
    expect(metadata['vendor_id']).toBe(VENDOR_ID);
    expect(metadata['is_pure_connector_vendor']).toBe(true);
    expect(metadata['seat_created']).toBe(true);
    expect(auditEntry.afterState).toMatchObject({
      role: 'vendor_admin',
      vendor_id: VENDOR_ID,
      seat_owner: true,
    });
  });

  it('flags a banned holder in the trail without writing the ban columns', () => {
    const { auditEntry, stmts } = provisionSeatStatements(
      t.db,
      provisionArgs({ role: 'reviewer', vendorId: null, seatOwner: false, bannedAt: OLD_TS }),
    );

    expect((auditEntry.metadata as Record<string, unknown>)['seat_banned']).toBe(true);
    expect(auditEntry.beforeState).toMatchObject({ role: 'reviewer', seat_owner: false });
    // Scoped to the ON CONFLICT clause, which is the branch that runs for an
    // account that already has a `profiles` row. The INSERT column list names
    // every defaulted column and is unreachable here by definition.
    expect(sqlOf(stmts[0]!).split(/on conflict/i)[1]).not.toContain('"banned_at"');
  });

  it('leaves the vendor row byte-identical when run against D1', async () => {
    // Guard 2, the observed-effect half: catches a write that evades the SQL
    // match. The whole claim of this endpoint is "a seat, and no badge".
    await seed(false);
    const beforeRow = await vendorOf();

    await t.db.batch(provisionSeatStatements(t.db, provisionArgs()).stmts as BatchTuple);

    expect(await vendorOf()).toEqual(beforeRow);
    const seat = (await t.db.select().from(profiles).where(eq(profiles.id, CLAIMANT_ID)))[0];
    expect(seat).toMatchObject({ role: 'vendor_admin', vendorId: VENDOR_ID, seatOwner: true });
    // No entitlement was opened, so `entitlement_mirror_drift` (which counts
    // `verified = 1` XOR an active row) sees nothing on either side — §8.9(4).
    expect(await t.db.select().from(vendorEntitlements)).toEqual([]);
    expect((await t.db.select().from(auditLog))[0]?.action).toBe('vendor_seat.provisioned');
  });
});
