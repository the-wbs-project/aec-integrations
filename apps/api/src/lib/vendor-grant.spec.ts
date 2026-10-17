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
 * deleted it. Since AECI-1367 no claim grant composes an entitlement at all: every
 * approval lands on Free.
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

import {
  auditLog,
  billingAccounts,
  profiles,
  vendorEntitlements,
  vendorRequests,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { type BatchStmt, type BatchTuple } from './audit';
import { ensureBillingAccountStatements } from './billing-account';
import {
  grantSeatStatements,
  provisionSeatStatements,
  rejectClaimStatements,
  revokeSeatStatements,
  type GrantSeatParams,
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

const grantArgs = (
  vendorWasVerified: boolean,
  over: Partial<GrantSeatParams> = {},
): GrantSeatParams => ({
  billingAccountCreated: false,
  userId: CLAIMANT_ID,
  vendorId: VENDOR_ID,
  vendorPlan: { tier: 'none', status: 'none' as const },
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
  submitterName: null,
  reason: null,
  targetType: 'vendor',
  targetId: VENDOR_ID,
  ...over,
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
  it('grantSeatStatements emits six statements, none of them on vendors', () => {
    const { stmts } = grantSeatStatements(t.db, grantArgs(false));

    // The flip AECI-519 shipped here lived at index 1. It is gone.
    expect(vendorsStatements(stmts)).toEqual([]);
    expect(stmts).toHaveLength(6);
    // AECI-1333: the decision-race sentinel is first, ahead of every write.
    expect(sqlOf(stmts[0]!)).toMatch(/json\(/);
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
      vendorPlan: { tier: 'none', status: 'none' as const },
      actorId: ADMIN_ID,
      actorType: 'admin',
      now: NOW,
      profileBefore: { role: 'vendor_admin', vendorId: VENDOR_ID },
    });

    expect(vendorsStatements(reject.stmts)).toEqual([]);
    expect(vendorsStatements(revoke.stmts)).toEqual([]);
  });
});

// AECI-1374 (decision 15): a seat revoked changes nothing in billing. The last seat
// included: revokeSeatStatements does not know how many seats remain, and the admin
// route adds only planVendorHandback (asserted clean in `vendor-handback.spec.ts`).
describe('revokeSeatStatements writes nothing in billing (decision 15)', () => {
  it('names no `licenses` or `billing_accounts` statement', () => {
    const { stmts } = revokeSeatStatements(t.db, {
      userId: CLAIMANT_ID,
      vendorId: VENDOR_ID,
      vendorPlan: { tier: 'verified', status: 'active' as const },
      actorId: ADMIN_ID,
      actorType: 'admin',
      now: NOW,
      profileBefore: { role: 'vendor_admin', vendorId: VENDOR_ID },
      reason: 'Left the company',
    });
    expect(stmts.length).toBeGreaterThan(0);
    expect(stmts.map(sqlOf).filter((sql) => /"licenses"|"billing_accounts"/.test(sql))).toEqual([]);
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
    // …and the vendor row is exactly as seeded. No claim grant moves `verified`
    // since AECI-1367.
    expect(after!.verified).toBe(false);
    expect(after!.updatedAt).toBe(OLD_TS);
    expect(after).toEqual(before);
  });
});

// ─── The audit row (AECI-1367: every approval lands on Free) ─────────────────

describe('the claim audit row', () => {
  it('records no verified flip, equal before/after snapshots and no plan', async () => {
    await seed(false);
    const { stmts, auditEntry } = grantSeatStatements(t.db, grantArgs(false));
    await t.db.batch(stmts as BatchTuple);

    expect(auditEntry.beforeState).toMatchObject({ vendor_verified: false });
    expect(auditEntry.afterState).toMatchObject({ vendor_verified: false });
    expect(auditEntry.metadata).toMatchObject({ verified_flipped: false });
    expect(auditEntry.metadata).not.toHaveProperty('plan');
    expect(auditEntry.metadata).not.toHaveProperty('entitlement');

    const rows = await t.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('vendor_claim.granted');
  });

  it('keeps vendor_verified: true on an already-verified vendor', () => {
    const { auditEntry } = grantSeatStatements(t.db, grantArgs(true));
    expect(auditEntry.beforeState).toMatchObject({ vendor_verified: true });
    expect(auditEntry.afterState).toMatchObject({ vendor_verified: true });
    expect(auditEntry.metadata).toMatchObject({ verified_flipped: false });
  });

  it.each([true, false])('says billing_account_created: %s', (created) => {
    const { auditEntry } = grantSeatStatements(
      t.db,
      grantArgs(false, { billingAccountCreated: created }),
    );
    expect(auditEntry.metadata).toMatchObject({ billing_account_created: created });
  });
});

// ─── AECI-1367: the claimant is an owner only when the vendor has none ───────

describe('grantSeatStatements owner rule (Portal §11a.4)', () => {
  const OTHER_ID = '66666666-6666-4666-8666-666666666666';
  const OTHER_VENDOR_ID = '77777777-7777-4777-8777-777777777777';

  const ownerOf = async (id: string) =>
    (await t.db.select().from(profiles).where(eq(profiles.id, id)))[0]!.seatOwner;

  /** A second claim on the same vendor, so the second grant's resolve has a row. */
  async function seedSecondClaim(requestId: string) {
    await t.db.insert(vendorRequests).values({
      id: requestId,
      kind: 'claim',
      status: 'open',
      targetType: 'vendor',
      targetId: VENDOR_ID,
      submitterEmail: 'second@vendor.com',
      body: 'Me too.',
    });
  }

  it('makes the first claimant on a vendor with no owner an owner', async () => {
    await seed(false);
    await t.db.batch(grantSeatStatements(t.db, grantArgs(false)).stmts as BatchTuple);
    expect(await ownerOf(CLAIMANT_ID)).toBe(true);
  });

  it('makes a later claimant on a vendor with an unbanned owner a non-owner', async () => {
    await seed(false);
    await t.db
      .insert(profiles)
      .values({ id: OTHER_ID, role: 'vendor_admin', vendorId: VENDOR_ID, seatOwner: true });
    await t.db.batch(grantSeatStatements(t.db, grantArgs(false)).stmts as BatchTuple);

    expect(await ownerOf(CLAIMANT_ID)).toBe(false);
    expect(await ownerOf(OTHER_ID)).toBe(true);
  });

  it('ignores a banned owner, a non-owner seat and another vendor’s owner', async () => {
    await seed(false);
    await t.db.insert(vendors).values({ id: OTHER_VENDOR_ID, slug: 'other', companyName: 'Other' });
    await t.db.insert(profiles).values([
      {
        id: OTHER_ID,
        role: 'vendor_admin',
        vendorId: VENDOR_ID,
        seatOwner: true,
        bannedAt: NOW,
      },
      {
        id: '88888888-8888-4888-8888-888888888888',
        role: 'vendor_admin',
        vendorId: VENDOR_ID,
        seatOwner: false,
      },
      {
        id: '99999999-9999-4999-8999-999999999999',
        role: 'vendor_admin',
        vendorId: OTHER_VENDOR_ID,
        seatOwner: true,
      },
    ]);
    await t.db.batch(grantSeatStatements(t.db, grantArgs(false)).stmts as BatchTuple);

    expect(await ownerOf(CLAIMANT_ID)).toBe(true);
  });

  it('two first approvals in sequence: only the first becomes an owner', async () => {
    // D1 runs one batch at a time. Both batches were BUILT before either ran, the way
    // two admins' concurrent approvals would be, so only SQL can tell them apart.
    await seed(false);
    const SECOND_REQUEST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await seedSecondClaim(SECOND_REQUEST);
    const first = grantSeatStatements(t.db, grantArgs(false));
    const second = grantSeatStatements(
      t.db,
      grantArgs(false, {
        userId: OTHER_ID,
        requestId: SECOND_REQUEST,
        workflowId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      }),
    );
    await t.db.batch(first.stmts as BatchTuple);
    await t.db.batch(second.stmts as BatchTuple);

    expect(await ownerOf(CLAIMANT_ID)).toBe(true);
    expect(await ownerOf(OTHER_ID)).toBe(false);
  });

  it('never demotes an existing owner of this vendor on the conflict path', async () => {
    await seed(false);
    // The claimant already holds an owner seat here, and is the vendor's only owner.
    // The subquery therefore sees an owner (itself) and computes 0. The CASE keeps 1.
    await t.db
      .insert(profiles)
      .values({ id: CLAIMANT_ID, role: 'vendor_admin', vendorId: VENDOR_ID, seatOwner: true });
    await t.db.batch(
      grantSeatStatements(
        t.db,
        grantArgs(false, {
          seatCreated: false,
          profileBefore: { role: 'vendor_admin', vendorId: VENDOR_ID },
        }),
      ).stmts as BatchTuple,
    );
    expect(await ownerOf(CLAIMANT_ID)).toBe(true);
  });

  it('an existing reviewer row takes the computed value on the conflict path', async () => {
    await seed(false);
    await t.db
      .insert(profiles)
      .values({ id: OTHER_ID, role: 'vendor_admin', vendorId: VENDOR_ID, seatOwner: true });
    // A stale `seat_owner = 1` on a reviewer row (owner of nothing here) is not kept.
    await t.db.insert(profiles).values({ id: CLAIMANT_ID, role: 'reviewer', seatOwner: true });
    await t.db.batch(
      grantSeatStatements(
        t.db,
        grantArgs(false, {
          seatCreated: false,
          profileBefore: { role: 'reviewer', vendorId: null },
        }),
      ).stmts as BatchTuple,
    );
    expect(await ownerOf(CLAIMANT_ID)).toBe(false);
  });
});

// ─── AECI-1280: the grant fills an EMPTY display_name, never a set one ───────

describe('grantSeatStatements fills an empty display_name from the claim (AECI-1280)', () => {
  /** The `ON CONFLICT … DO UPDATE SET` half of the seat upsert. */
  const conflictSet = (p: GrantSeatParams): string =>
    sqlOf(grantSeatStatements(t.db, p).stmts[1]!).split(/on conflict/i)[1] ?? '';

  const seatName = async () =>
    (await t.db.select().from(profiles).where(eq(profiles.id, CLAIMANT_ID)))[0]!.displayName;

  it('sets display_name only through the fill-if-empty COALESCE, and no other owned column', () => {
    const conflict = conflictSet(grantArgs(false, { submitterName: 'Sam Submitter' }));

    expect(conflict).toMatch(/"display_name" = COALESCE\(NULLIF\(trim\(/);
    for (const forbidden of [
      '"banned_at"',
      '"ban_reason"',
      '"work_email_verified"',
      '"trust_tier"',
      '"theme_preference"',
    ]) {
      expect(conflict).not.toContain(forbidden);
    }
  });

  it.each([
    ['null', null],
    ['blank', '   '],
    ['over the account cap', 'x'.repeat(81)],
  ])('leaves display_name out of the set list when the name is %s', (_label, submitterName) => {
    const p = grantArgs(false, { submitterName });
    expect(conflictSet(p)).not.toContain('"display_name"');
    expect(grantSeatStatements(t.db, p).auditEntry.metadata).toMatchObject({
      display_name_filled: false,
    });
  });

  it.each([
    ['null', null],
    ['blank', '  '],
  ])('fills an existing %s name and says so in the audit row', async (_label, before) => {
    await seed(false);
    await t.db.insert(profiles).values({ id: CLAIMANT_ID, role: 'reviewer', displayName: before });
    const { stmts, auditEntry } = grantSeatStatements(
      t.db,
      grantArgs(false, {
        seatCreated: false,
        profileBefore: { role: 'reviewer', vendorId: null, displayName: before },
        submitterName: '  Sam Submitter ',
      }),
    );
    await t.db.batch(stmts as BatchTuple);

    expect(await seatName()).toBe('Sam Submitter');
    expect(auditEntry.metadata).toMatchObject({ display_name_filled: true });
    expect(auditEntry.beforeState).toMatchObject({ seat_display_name: before });
    expect(auditEntry.afterState).toMatchObject({ seat_display_name: 'Sam Submitter' });
  });

  it('never overwrites a name the user set', async () => {
    await seed(false);
    await t.db
      .insert(profiles)
      .values({ id: CLAIMANT_ID, role: 'reviewer', displayName: 'Jane Doe' });
    const { stmts, auditEntry } = grantSeatStatements(
      t.db,
      grantArgs(false, {
        seatCreated: false,
        profileBefore: { role: 'reviewer', vendorId: null, displayName: 'Jane Doe' },
        submitterName: 'Sam Submitter',
      }),
    );
    await t.db.batch(stmts as BatchTuple);

    expect(await seatName()).toBe('Jane Doe');
    expect(auditEntry.metadata).toMatchObject({ display_name_filled: false });
    expect(auditEntry.afterState).toMatchObject({ seat_display_name: 'Jane Doe' });
  });

  it('keeps a name set after the snapshot was read (the SQL guard, not the snapshot, decides)', async () => {
    await seed(false);
    await t.db
      .insert(profiles)
      .values({ id: CLAIMANT_ID, role: 'reviewer', displayName: 'Set Mid-Flight' });
    const { stmts } = grantSeatStatements(
      t.db,
      grantArgs(false, {
        seatCreated: false,
        // A stale snapshot: the account had no name when the handler read it.
        profileBefore: { role: 'reviewer', vendorId: null, displayName: null },
        submitterName: 'Sam Submitter',
      }),
    );
    await t.db.batch(stmts as BatchTuple);

    expect(await seatName()).toBe('Set Mid-Flight');
  });

  it('writes the name on a brand-new seat (grant before first sign-in)', async () => {
    await seed(false);
    const { stmts, auditEntry } = grantSeatStatements(
      t.db,
      grantArgs(false, { submitterName: 'Sam Submitter' }),
    );
    await t.db.batch(stmts as BatchTuple);

    expect(await seatName()).toBe('Sam Submitter');
    expect(auditEntry.metadata).toMatchObject({ display_name_filled: true });
    expect(auditEntry.beforeState).toMatchObject({ seat_display_name: null });
  });
});

// ─── AECI-740: the standalone provision ──────────────────────────────────────

const provisionArgs = (before: ProvisionProfileBefore | null = null) => ({
  userId: CLAIMANT_ID,
  vendorId: VENDOR_ID,
  vendorPlan: { tier: 'none', status: 'none' as const },
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
    // entitlement row, so a statement on either table could flip `verified`,
    // which this seat must never do.
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
    // LOAD-BEARING since AECI-1192: leg 3 of `auditScopeWhere` matches the
    // `vendor_id` COLUMN, the only leg that reaches a `vendor_seat.*` row on the
    // vendor's own audit tab. The metadata key is spelled `vendorId` on new rows.
    expect(auditEntry.vendorId).toBe(VENDOR_ID);
    expect(auditEntry.vendorPlan).toEqual({ tier: 'none', status: 'none' });
    expect(metadata['vendorId']).toBe(VENDOR_ID);
    expect(metadata['vendor_id']).toBeUndefined();
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
    // match. The whole claim of this endpoint is "a seat, and no `verified`".
    await seed(false);
    const beforeRow = await vendorOf();

    await t.db.batch(provisionSeatStatements(t.db, provisionArgs()).stmts as BatchTuple);

    expect(await vendorOf()).toEqual(beforeRow);
    const seat = (await t.db.select().from(profiles).where(eq(profiles.id, CLAIMANT_ID)))[0];
    expect(seat).toMatchObject({ role: 'vendor_admin', vendorId: VENDOR_ID, seatOwner: true });
    // No entitlement or license was opened, so `license_mirror_drift` (which counts
    // `verified = 1` XOR a live license) sees nothing on either side, §8.9(4).
    expect(await t.db.select().from(vendorEntitlements)).toEqual([]);
    expect((await t.db.select().from(auditLog))[0]?.action).toBe('vendor_seat.provisioned');
  });
});

// ─── The billing account composes in without touching `vendors` (AECI-1351) ──

describe('the seat batch plus ensureBillingAccountStatements', () => {
  const accountArgs = (existing: { id: string } | null) => ({
    vendorId: VENDOR_ID,
    name: 'Autodesk, Inc.',
    createdBy: ADMIN_ID,
    actorType: 'admin' as const,
    existing,
    now: NOW,
    vendorPlan: { tier: 'none', status: 'none' as const },
    source: 'admin-moderation',
  });

  it('first owner: the composed batch names no `vendors` and leaves the row byte-identical', async () => {
    await seed(false);
    const before = await vendorOf();

    const grant = grantSeatStatements(t.db, grantArgs(false));
    const account = ensureBillingAccountStatements(t.db, accountArgs(null));
    const stmts = [...grant.stmts, ...account.stmts];
    expect(vendorsStatements(stmts)).toEqual([]);
    await t.db.batch(stmts as BatchTuple);

    expect(await vendorOf()).toEqual(before);
    expect(await t.db.select().from(billingAccounts)).toHaveLength(1);
    // The seat the account came with is an owner seat (decision 10's flag).
    const seat = (await t.db.select().from(profiles).where(eq(profiles.id, CLAIMANT_ID)))[0];
    expect(seat!.seatOwner).toBe(true);
  });

  it('second seat: the account half adds nothing, so the batch is the seat batch alone', () => {
    const grant = grantSeatStatements(t.db, grantArgs(true));
    const account = ensureBillingAccountStatements(t.db, accountArgs({ id: 'existing' }));
    expect(account.stmts).toEqual([]);
    expect(account.auditEntry).toBeNull();
    expect([...grant.stmts, ...account.stmts]).toHaveLength(6);
  });

  it('provision: the owner seat and the account land together, vendors untouched', async () => {
    await seed(false);
    const before = await vendorOf();

    const stmts = [
      ...provisionSeatStatements(t.db, provisionArgs()).stmts,
      ...ensureBillingAccountStatements(t.db, accountArgs(null)).stmts,
    ];
    expect(vendorsStatements(stmts)).toEqual([]);
    await t.db.batch(stmts as BatchTuple);

    expect(await vendorOf()).toEqual(before);
    expect((await t.db.select().from(auditLog)).map((r) => r.action).sort()).toEqual([
      'billing_account.created',
      'vendor_seat.provisioned',
    ]);
  });
});
