/**
 * The legal retention prune (AECI-1638, ADR 0058) against the in-memory D1 harness. Time
 * travel goes through the `now` argument, so every cutoff is computed from {@link NOW}.
 *
 * The cases that lose data if they regress are the ones that must stay: an exempt audit
 * action, a claimed vendor, a vendor with a live license, a grant not five years past its
 * end, a claim not closed six years ago, a gone vendor with no `vendor.deleted` record,
 * and anything under a hold. Row counts are read back with
 * `select`, never from a batch return value (the harness's batch shim answers from
 * better-sqlite3, not D1).
 */

import { AUDIT_LOG_PRUNE_EXEMPT_ACTIONS } from '@aeci/shared';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agreementAcceptances,
  attestations,
  auditLog,
  billingAccounts,
  claims,
  connectorCatalogs,
  connectorEvidencedPairs,
  connectorPairs,
  connectorStubMappings,
  connectorStubs,
  integrationFieldChallenges,
  integrations,
  licenseGrants,
  licenses,
  listingRequests,
  litigationHolds,
  products,
  productVendors,
  profiles,
  reviews,
  taxonomyDataObjects,
  termsAcceptances,
  vendorRequests,
  vendors,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { pruneAuditIds } from './acceptance-chain';
import {
  emitLegalRetentionPruneMetrics,
  isLegalRetentionRaceError,
  LEGAL_PRUNABLE,
  LEGAL_RETENTION_IDS_PER_TABLE,
  LEGAL_RETENTION_ROWS_METRIC,
  LEGAL_RETENTION_RUN_METRIC,
  legalCutoffs,
  runLegalRetentionPrune,
  runLegalRetentionPruneWithReplan,
  shiftYears,
} from './legal-retention-prune';
import { MAX_CHUNKS_PER_TABLE, PRUNE_CHUNK_ROWS } from './retention-prune';

/** A fixed "now", far enough out that every period has fallen due for some row. */
const NOW = new Date('2034-06-15T03:00:00.000Z');
const CUT = legalCutoffs(NOW);

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
/** `n` days before (negative) or after an ISO instant. */
const shift = (at: string, days: number) => iso(Date.parse(at) + days * DAY);
/** `years` calendar years before NOW's midnight, then `days` more. */
const yearsAgo = (years: number, days = 0) =>
  shift(`${shiftYears('2034-06-15', -years)}T00:00:00.000Z`, -days);

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const auditRows = () => t.db.select().from(auditLog);
const acceptanceIds = async () =>
  (await t.db.select({ id: agreementAcceptances.id }).from(agreementAcceptances))
    .map((r) => r.id)
    .sort();
const grantIds = async () =>
  (await t.db.select({ id: licenseGrants.id }).from(licenseGrants)).map((r) => r.id).sort();
const pruneRows = async () =>
  (await auditRows()).filter(
    (r) =>
      r.action === 'retention.pruned' &&
      (r.metadata as { source?: string } | null)?.source === 'legal-retention-prune',
  );

async function seedAudit(action: string, createdAt: string, id = crypto.randomUUID()) {
  await t.db.insert(auditLog).values({ id, actorType: 'system', action, createdAt });
  return id;
}

/** A vendor, its billing account, and optional licenses. */
async function seedVendor(
  id: string,
  opts: {
    claimEndedAt: string | null;
    licenses?: { id: string; endedAt: string | null; grantId?: string }[];
  },
) {
  await t.db.insert(vendors).values({
    id,
    slug: id,
    companyName: `Company ${id}`,
    ownedAt: '2025-01-01T00:00:00.000Z',
    claimEndedAt: opts.claimEndedAt,
  });
  await t.db.insert(billingAccounts).values({ id: `ba-${id}`, vendorId: id, name: id });
  for (const l of opts.licenses ?? []) {
    await t.db.insert(licenses).values({
      id: l.id,
      billingAccountId: `ba-${id}`,
      source: 'complimentary',
      startsAt: '2025-01-01T00:00:00.000Z',
      endedAt: l.endedAt,
      licenseGrantId: l.grantId ?? null,
    });
  }
}

async function seedAcceptance(
  id: string,
  vendorId: string | null,
  opts: {
    acceptedAt?: string;
    grantId?: string;
    billingAccountId?: string;
    vendorRequestId?: string;
    listingRequestId?: string;
  } = {},
) {
  await t.db.insert(agreementAcceptances).values({
    id,
    document: 'vendor_terms',
    version: '1.0',
    source: opts.grantId ? 'grant' : 'claim',
    email: 'signer@example.test',
    vendorId,
    billingAccountId: opts.billingAccountId ?? null,
    licenseGrantId: opts.grantId ?? null,
    vendorRequestId: opts.vendorRequestId ?? null,
    listingRequestId: opts.listingRequestId ?? null,
    acceptedAt: opts.acceptedAt ?? '2025-02-01T00:00:00.000Z',
  });
}

/** A claim (`vendor_requests`, kind `claim`) on a company or, the legacy shape, a product. */
async function seedClaim(
  id: string,
  opts: {
    status: 'open' | 'in_review' | 'resolved' | 'rejected';
    resolvedAt?: string | null;
    targetType?: 'vendor' | 'product';
    targetId?: string;
  },
) {
  await t.db.insert(vendorRequests).values({
    id,
    kind: 'claim',
    targetType: opts.targetType ?? 'vendor',
    targetId: opts.targetId ?? 'v-target',
    submitterEmail: 'claimant@example.test',
    body: 'Claim',
    status: opts.status,
    resolvedAt: opts.resolvedAt ?? null,
  });
}

/** The `vendor.deleted` row `lib/retract-vendor.ts` writes when it deletes a vendor. */
async function seedVendorDeleted(vendorId: string, createdAt: string, id = `vd-${vendorId}`) {
  await t.db.insert(auditLog).values({
    id,
    actorType: 'system',
    action: 'vendor.deleted',
    entityType: 'vendor',
    entityId: vendorId,
    vendorId,
    createdAt,
  });
  return id;
}

async function seedGrant(
  id: string,
  vendorId: string,
  opts: { status: string; decidedAt?: string | null; billingAccountId?: string },
) {
  await t.db.insert(licenseGrants).values({
    id,
    billingAccountId: opts.billingAccountId ?? `ba-${vendorId}`,
    vendorId,
    kind: 'grant',
    source: 'complimentary',
    quantity: 1,
    endsAt: '2026-01-01T00:00:00.000Z',
    termsVersion: '1.0',
    status: opts.status,
    decidedAt: opts.decidedAt ?? null,
  });
}

async function seedHold(scope: 'global' | 'vendor', vendorId: string | null, released = false) {
  await t.db.insert(litigationHolds).values({
    scope,
    vendorId,
    reason: 'Matter pending',
    placedBy: 'admin-1',
    placedAt: '2034-01-01T00:00:00.000Z',
    releasedAt: released ? '2034-02-01T00:00:00.000Z' : null,
    releasedBy: released ? 'admin-1' : null,
    releaseReason: released ? 'Matter closed' : null,
  });
}

describe('cutoffs', () => {
  it('shifts calendar years, and a Feb 29 lands on Feb 28, the earlier day', () => {
    expect(shiftYears('2034-06-15', -6)).toBe('2028-06-15');
    expect(shiftYears('2032-02-29', -6)).toBe('2026-02-28');
    expect(shiftYears('2032-02-29', -4)).toBe('2028-02-29');
  });

  it('puts the audit cutoff 1461 days before UTC midnight, and the others on calendar years', () => {
    expect(CUT).toEqual({
      audit: iso(Date.parse('2034-06-15T00:00:00.000Z') - 1461 * DAY),
      acceptance: '2028-06-15T00:00:00.000Z',
      grant: '2029-06-15T00:00:00.000Z',
    });
  });
});

describe('the four-year audit part', () => {
  it('deletes a row one day past the cutoff and keeps one a day inside it', async () => {
    const old = await seedAudit('vendor.updated', shift(CUT.audit, -1));
    const atCutoff = await seedAudit('vendor.updated', CUT.audit);
    const young = await seedAudit('vendor.updated', shift(CUT.audit, 1));

    const result = await runLegalRetentionPrune(t.db, NOW);

    const ids = (await auditRows()).map((r) => r.id);
    expect(ids).not.toContain(old);
    expect(ids).toContain(atCutoff);
    expect(ids).toContain(young);
    expect(result).toMatchObject({ status: 'pruned', rowsDeleted: 1 });
    expect(result.tables.find((x) => x.table === 'audit_log')).toMatchObject({
      rowsDeleted: 1,
      truncated: false,
      cutoff: CUT.audit,
    });
  });

  it('keeps every exempt action whatever its age, and escapes the underscore in a prefix', async () => {
    const ancient = shift(CUT.audit, -900);
    const kept = [
      ...AUDIT_LOG_PRUNE_EXEMPT_ACTIONS,
      'litigation_hold.placed',
      'litigation_hold.released',
      'agreement.accepted',
      'agreement.linked',
      'agreement.evidence_removed',
      'terms.accepted',
      'terms.evidence_removed',
    ];
    const keptIds = await Promise.all(kept.map((action) => seedAudit(action, ancient)));
    // `_` is a LIKE wildcard. Unescaped, this lookalike would be exempt too.
    const lookalike = await seedAudit('litigationXhold.placed', ancient);

    await runLegalRetentionPrune(t.db, NOW);

    const ids = (await auditRows()).map((r) => r.id);
    for (const id of keptIds) expect(ids).toContain(id);
    expect(ids).not.toContain(lookalike);
  });

  it('pages the (created_at, id) row value across a chunk boundary with a tie', async () => {
    // Every row shares one created_at, so only the id breaks the tie at the boundary.
    const at = shift(CUT.audit, -10);
    const n = PRUNE_CHUNK_ROWS + 7;
    t.raw
      .prepare(
        `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ?)
         INSERT INTO audit_log (id, actor_type, action, created_at)
         SELECT printf('a-%06d', i), 'system', 'vendor.updated', ? FROM s`,
      )
      .run(n, at);
    const young = await seedAudit('vendor.updated', shift(CUT.audit, 1));

    const result = await runLegalRetentionPrune(t.db, NOW);

    const left = await auditRows();
    expect(left.map((r) => r.id).filter((id) => id.startsWith('a-'))).toEqual([]);
    expect(left.map((r) => r.id)).toContain(young);
    expect(result.tables.find((x) => x.table === 'audit_log')).toMatchObject({
      rowsDeleted: n,
      truncated: false,
    });
  });

  it('stops at MAX_CHUNKS_PER_TABLE chunks and reports truncated; the next run continues', async () => {
    const cap = PRUNE_CHUNK_ROWS * MAX_CHUNKS_PER_TABLE;
    t.raw
      .prepare(
        `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ?)
         INSERT INTO audit_log (id, actor_type, action, created_at)
         SELECT printf('b-%06d', i), 'system', 'vendor.updated',
                strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-' || (i % 50) || ' seconds') FROM s`,
      )
      .run(cap + 3, shift(CUT.audit, -1));

    const first = await runLegalRetentionPrune(t.db, NOW);
    expect(first.tables.find((x) => x.table === 'audit_log')).toMatchObject({
      rowsDeleted: cap,
      truncated: true,
    });
    // The run's own retention.pruned row is exempt, so only the three seeded rows remain.
    expect((await auditRows()).filter((r) => r.id.startsWith('b-'))).toHaveLength(3);

    const second = await runLegalRetentionPrune(t.db, NOW);
    expect(second.tables.find((x) => x.table === 'audit_log')).toMatchObject({
      rowsDeleted: 3,
      truncated: false,
    });
  });

  it('writes no audit row when nothing was deleted', async () => {
    await seedAudit('vendor.updated', shift(CUT.audit, 1));
    const result = await runLegalRetentionPrune(t.db, NOW);
    expect(result).toMatchObject({ status: 'pruned', rowsDeleted: 0 });
    expect(result.status === 'pruned' && result.auditEntry).toBeFalsy();
    expect(await pruneRows()).toEqual([]);
  });
});

describe('the acceptance part', () => {
  it('never touches a claimed vendor', async () => {
    await seedVendor('v-claimed', { claimEndedAt: null });
    await seedAcceptance('acc-claimed', 'v-claimed', { acceptedAt: yearsAgo(12) });
    await runLegalRetentionPrune(t.db, NOW);
    expect(await acceptanceIds()).toEqual(['acc-claimed']);
  });

  it('never touches a vendor that holds a live license', async () => {
    await seedVendor('v-live', {
      claimEndedAt: yearsAgo(9),
      licenses: [{ id: 'l-live', endedAt: null }],
    });
    await seedAcceptance('acc-live', 'v-live', { acceptedAt: yearsAgo(12) });
    await runLegalRetentionPrune(t.db, NOW);
    expect(await acceptanceIds()).toEqual(['acc-live']);
  });

  it('keeps an account that ended under six years ago and deletes one six years and a day ago', async () => {
    await seedVendor('v-young', { claimEndedAt: shift(CUT.acceptance, 30) });
    await seedVendor('v-old', { claimEndedAt: shift(CUT.acceptance, -1) });
    await seedAcceptance('acc-young', 'v-young', { acceptedAt: yearsAgo(10) });
    await seedAcceptance('acc-old', 'v-old', { acceptedAt: yearsAgo(10) });

    const result = await runLegalRetentionPrune(t.db, NOW);

    expect(await acceptanceIds()).toEqual(['acc-young']);
    expect(result.tables.find((x) => x.table === 'agreement_acceptances')).toMatchObject({
      rowsDeleted: 1,
      cutoff: CUT.acceptance,
    });
  });

  it('dates the account end from the later of the claim end and the last license end', async () => {
    // The claim ended nine years ago, but a license ran until five years ago.
    await seedVendor('v-license', {
      claimEndedAt: yearsAgo(9),
      licenses: [{ id: 'l-late', endedAt: yearsAgo(5) }],
    });
    await seedAcceptance('acc-license', 'v-license', { acceptedAt: yearsAgo(10) });
    await runLegalRetentionPrune(t.db, NOW);
    expect(await acceptanceIds()).toEqual(['acc-license']);
  });

  it('restarts the clock on a reclaim', async () => {
    // Accepted long ago, claim ended long ago, then reclaimed and ended again last year.
    await seedVendor('v-reclaimed', { claimEndedAt: yearsAgo(1) });
    await seedAcceptance('acc-reclaimed', 'v-reclaimed', { acceptedAt: yearsAgo(12) });
    await runLegalRetentionPrune(t.db, NOW);
    expect(await acceptanceIds()).toEqual(['acc-reclaimed']);
  });

  it('keeps a grant and its acceptance until five years after the grant ends', async () => {
    await seedVendor('v-grant', { claimEndedAt: yearsAgo(8) });
    // Expired four years ago: under five.
    await seedGrant('g-young', 'v-grant', { status: 'expired', decidedAt: yearsAgo(4) });
    // Withdrawn five years and a day ago.
    await seedGrant('g-old', 'v-grant', { status: 'withdrawn', decidedAt: yearsAgo(5, 1) });
    // Still waiting for acceptance: it has not ended.
    await seedGrant('g-pending', 'v-grant', { status: 'pending_acceptance' });
    await seedAcceptance('acc-g-young', 'v-grant', { grantId: 'g-young', acceptedAt: yearsAgo(9) });
    await seedAcceptance('acc-g-old', 'v-grant', { grantId: 'g-old', acceptedAt: yearsAgo(9) });
    await seedAcceptance('acc-claim', 'v-grant', { acceptedAt: yearsAgo(9) });

    const result = await runLegalRetentionPrune(t.db, NOW);

    expect(await acceptanceIds()).toEqual(['acc-g-young']);
    expect(await grantIds()).toEqual(['g-pending', 'g-young']);
    expect(result.tables.find((x) => x.table === 'license_grants')).toMatchObject({
      rowsDeleted: 1,
      cutoff: CUT.grant,
    });
  });

  it('dates an accepted grant from its last license end, and keeps it while one is live', async () => {
    await seedVendor('v-lic', {
      claimEndedAt: yearsAgo(8),
      licenses: [
        { id: 'l-g1a', endedAt: yearsAgo(9), grantId: 'g-1' },
        { id: 'l-g1b', endedAt: yearsAgo(7), grantId: 'g-1' },
      ],
    });
    await seedGrant('g-1', 'v-lic', { status: 'accepted', decidedAt: yearsAgo(10) });
    await seedAcceptance('acc-g1', 'v-lic', { grantId: 'g-1', acceptedAt: yearsAgo(10) });

    await runLegalRetentionPrune(t.db, NOW);

    expect(await acceptanceIds()).toEqual([]);
    expect(await grantIds()).toEqual([]);
  });

  it('keeps a gone vendor with no vendor.deleted record, and a NULL-vendor row of an open claim', async () => {
    await seedClaim('claim-open', { status: 'open' });
    await seedAcceptance('acc-null', null, {
      acceptedAt: yearsAgo(15),
      vendorRequestId: 'claim-open',
    });
    await seedAcceptance('acc-gone', 'v-gone', { acceptedAt: yearsAgo(15) });
    await runLegalRetentionPrune(t.db, NOW);
    expect(await acceptanceIds()).toEqual(['acc-gone', 'acc-null']);
  });

  it('dates a legacy checkout row with no vendor_id by its billing account’s vendor', async () => {
    await seedVendor('v-ended', { claimEndedAt: yearsAgo(7) });
    await seedVendor('v-live', { claimEndedAt: null });
    await seedAcceptance('acc-ended', null, {
      acceptedAt: yearsAgo(10),
      billingAccountId: 'ba-v-ended',
    });
    await seedAcceptance('acc-live', null, {
      acceptedAt: yearsAgo(10),
      billingAccountId: 'ba-v-live',
    });
    await runLegalRetentionPrune(t.db, NOW);
    expect(await acceptanceIds()).toEqual(['acc-live']);
  });

  it('deletes an acceptance’s agreement.* audit rows in the same batch, and keeps the rest', async () => {
    await seedVendor('v-old', { claimEndedAt: yearsAgo(7) });
    await seedVendor('v-young', { claimEndedAt: yearsAgo(1) });
    await seedAcceptance('acc-old', 'v-old', { acceptedAt: yearsAgo(10) });
    await seedAcceptance('acc-young', 'v-young', { acceptedAt: yearsAgo(10) });
    const ancient = yearsAgo(10);
    await t.db.insert(auditLog).values([
      {
        id: 'au-old',
        actorType: 'user',
        action: 'agreement.accepted',
        entityType: 'agreement_acceptance',
        entityId: 'acc-old',
        createdAt: ancient,
      },
      {
        id: 'au-young',
        actorType: 'user',
        action: 'agreement.accepted',
        entityType: 'agreement_acceptance',
        entityId: 'acc-young',
        createdAt: ancient,
      },
      {
        // No `acceptance_ids` array, so it can never be matched: kept.
        id: 'au-linked',
        actorType: 'admin',
        action: 'agreement.linked',
        entityType: 'vendor_request',
        entityId: 'claim-1',
        createdAt: ancient,
      },
      {
        id: 'au-evidence',
        actorType: 'system',
        action: 'agreement.evidence_removed',
        entityType: 'agreement_acceptance',
        entityId: null,
        metadata: { acceptance_ids: ['acc-old'] },
        createdAt: ancient,
      },
    ]);

    const result = await runLegalRetentionPrune(t.db, NOW);

    const ids = (await auditRows()).map((r) => r.id);
    expect(ids).not.toContain('au-old');
    // Its only acceptance went in this batch, so the evidence row goes too.
    expect(ids).not.toContain('au-evidence');
    expect(ids).toEqual(expect.arrayContaining(['au-young', 'au-linked']));
    expect(result.tables.find((x) => x.table === 'audit_log')).toMatchObject({
      rowsDeleted: 2,
      companionRowsDeleted: 2,
    });
  });

  it('caps each table at LEGAL_RETENTION_IDS_PER_TABLE ids and reports truncated', async () => {
    await seedVendor('v-many', { claimEndedAt: yearsAgo(7) });
    t.raw
      .prepare(
        `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ?)
         INSERT INTO agreement_acceptances (id, document, version, source, email, vendor_id, accepted_at, created_at)
         SELECT printf('acc-%04d', i), 'vendor_terms', '1.0', 'claim', 'x@example.test', 'v-many', ?, ? FROM s`,
      )
      .run(LEGAL_RETENTION_IDS_PER_TABLE + 5, yearsAgo(10), yearsAgo(10));

    const result = await runLegalRetentionPrune(t.db, NOW);

    expect(result.tables.find((x) => x.table === 'agreement_acceptances')).toMatchObject({
      rowsDeleted: LEGAL_RETENTION_IDS_PER_TABLE,
      truncated: true,
    });
    expect(await acceptanceIds()).toHaveLength(5);
  });
});

describe('arm B: a claim never approved (ruling 48)', () => {
  it('deletes the row and its agreement.accepted row once the rejected claim closed six years and a day ago', async () => {
    await seedClaim('claim-old', { status: 'rejected', resolvedAt: shift(CUT.acceptance, -1) });
    await seedAcceptance('acc-b', null, { acceptedAt: yearsAgo(7), vendorRequestId: 'claim-old' });
    await t.db.insert(auditLog).values({
      id: 'au-b',
      actorType: 'user',
      action: 'agreement.accepted',
      entityType: 'agreement_acceptance',
      entityId: 'acc-b',
      createdAt: yearsAgo(7),
    });

    const result = await runLegalRetentionPrune(t.db, NOW);

    expect(await acceptanceIds()).toEqual([]);
    expect((await auditRows()).map((r) => r.id)).not.toContain('au-b');
    expect(result.tables.find((x) => x.table === 'agreement_acceptances')).toMatchObject({
      rowsDeleted: 1,
    });
    const [run] = await pruneRows();
    expect(
      (run!.metadata as { tables: { table: string; ids?: string[] }[] }).tables,
    ).toContainEqual(expect.objectContaining({ table: 'agreement_acceptances', ids: ['acc-b'] }));
  });

  it('keeps a claim closed six years less a day ago, and a row accepted inside the window', async () => {
    await seedClaim('claim-young', { status: 'rejected', resolvedAt: shift(CUT.acceptance, 1) });
    await seedAcceptance('acc-young', null, {
      acceptedAt: yearsAgo(7),
      vendorRequestId: 'claim-young',
    });
    // The claim closed long ago, but this acceptance is inside the six years.
    await seedClaim('claim-late', { status: 'rejected', resolvedAt: yearsAgo(8) });
    await seedAcceptance('acc-late', null, {
      acceptedAt: shift(CUT.acceptance, 1),
      vendorRequestId: 'claim-late',
    });
    await runLegalRetentionPrune(t.db, NOW);
    expect(await acceptanceIds()).toEqual(['acc-late', 'acc-young']);
  });

  it('keeps the row of an open, in-review or approved claim, however old', async () => {
    await seedClaim('claim-open', { status: 'open' });
    await seedClaim('claim-review', { status: 'in_review' });
    await seedClaim('claim-resolved', { status: 'resolved', resolvedAt: yearsAgo(9) });
    for (const id of ['claim-open', 'claim-review', 'claim-resolved']) {
      await seedAcceptance(`acc-${id}`, null, { acceptedAt: yearsAgo(10), vendorRequestId: id });
    }
    await runLegalRetentionPrune(t.db, NOW);
    expect(await acceptanceIds()).toEqual([
      'acc-claim-open',
      'acc-claim-resolved',
      'acc-claim-review',
    ]);
  });

  it('a vendor hold on the claimed company keeps it, by vendor or legacy product target; a hold on another vendor does not', async () => {
    await seedVendor('v-target', { claimEndedAt: null });
    await seedVendor('v-other', { claimEndedAt: null });
    await t.db.insert(products).values({ id: 'p-target', slug: 'p-target', name: 'Target' });
    await t.db.insert(productVendors).values({ productId: 'p-target', vendorId: 'v-target' });
    await seedClaim('claim-v', { status: 'rejected', resolvedAt: yearsAgo(7) });
    await seedClaim('claim-p', {
      status: 'rejected',
      resolvedAt: yearsAgo(7),
      targetType: 'product',
      targetId: 'p-target',
    });
    await seedClaim('claim-x', {
      status: 'rejected',
      resolvedAt: yearsAgo(7),
      targetId: 'v-other',
    });
    for (const id of ['claim-v', 'claim-p', 'claim-x']) {
      await seedAcceptance(`acc-${id}`, null, { acceptedAt: yearsAgo(8), vendorRequestId: id });
    }
    await seedHold('vendor', 'v-target');

    await runLegalRetentionPrune(t.db, NOW);

    expect(await acceptanceIds()).toEqual(['acc-claim-p', 'acc-claim-v']);
  });
});

describe('arm C: no date but the acceptance', () => {
  it('deletes a listing-request row and an unlinked row six years and a day after acceptance, and keeps a younger one', async () => {
    await t.db.insert(listingRequests).values({
      id: 'lr-1',
      listingName: 'Example',
      website: 'https://example.test',
      submitterEmail: 'lister@example.test',
    });
    await seedAcceptance('acc-listing', null, {
      acceptedAt: shift(CUT.acceptance, -1),
      listingRequestId: 'lr-1',
    });
    await seedAcceptance('acc-orphan', null, { acceptedAt: shift(CUT.acceptance, -1) });
    await seedAcceptance('acc-young', null, { acceptedAt: shift(CUT.acceptance, 1) });

    await runLegalRetentionPrune(t.db, NOW);

    expect(await acceptanceIds()).toEqual(['acc-young']);
  });

  it('is not arm C when a billing account is set: the account’s live vendor keeps it', async () => {
    await seedVendor('v-live', { claimEndedAt: null });
    await seedAcceptance('acc-billed', null, {
      acceptedAt: yearsAgo(10),
      billingAccountId: 'ba-v-live',
    });
    await runLegalRetentionPrune(t.db, NOW);
    expect(await acceptanceIds()).toEqual(['acc-billed']);
  });
});

describe('arm D: the vendor row is gone', () => {
  it('deletes the acceptance and its vendor.deleted row in one batch, six years and a day after the deletion', async () => {
    const vd = await seedVendorDeleted('v-gone', shift(CUT.acceptance, -1));
    await seedAcceptance('acc-gone', 'v-gone', { acceptedAt: yearsAgo(10) });

    const result = await runLegalRetentionPrune(t.db, NOW);

    expect(await acceptanceIds()).toEqual([]);
    expect((await auditRows()).map((r) => r.id)).not.toContain(vd);
    expect(result.tables.find((x) => x.table === 'audit_log')).toMatchObject({
      companionRowsDeleted: 1,
    });
  });

  it('keeps the vendor.deleted row while another acceptance or grant of that vendor remains', async () => {
    // The second acceptance is held by the grant floor: its grant ended four years ago.
    await seedVendor('v-host', { claimEndedAt: null });
    await seedGrant('g-floor', 'v-gone', {
      status: 'expired',
      decidedAt: yearsAgo(4),
      billingAccountId: 'ba-v-host',
    });
    const vd = await seedVendorDeleted('v-gone', yearsAgo(7));
    await seedAcceptance('acc-due', 'v-gone', { acceptedAt: yearsAgo(10) });
    await seedAcceptance('acc-floor', 'v-gone', { acceptedAt: yearsAgo(10), grantId: 'g-floor' });

    await runLegalRetentionPrune(t.db, NOW);

    expect(await acceptanceIds()).toEqual(['acc-floor']);
    expect(await grantIds()).toEqual(['g-floor']);
    expect((await auditRows()).map((r) => r.id)).toContain(vd);

    // Two years on the grant floor has passed: the grant, the last acceptance and the
    // vendor.deleted row go together.
    await runLegalRetentionPrune(t.db, new Date('2036-06-15T03:00:00.000Z'));
    expect(await acceptanceIds()).toEqual([]);
    expect(await grantIds()).toEqual([]);
    expect((await auditRows()).map((r) => r.id)).not.toContain(vd);
  });

  it('keeps a deletion under six years old, a gone vendor with no record, and a gone vendor under hold', async () => {
    await seedVendorDeleted('v-young', shift(CUT.acceptance, 1));
    await seedAcceptance('acc-young', 'v-young', { acceptedAt: yearsAgo(10) });
    await seedAcceptance('acc-norecord', 'v-norecord', { acceptedAt: yearsAgo(10) });
    await seedVendorDeleted('v-held', yearsAgo(8));
    await seedAcceptance('acc-held', 'v-held', { acceptedAt: yearsAgo(10) });
    await seedHold('vendor', 'v-held');

    await runLegalRetentionPrune(t.db, NOW);

    expect(await acceptanceIds()).toEqual(['acc-held', 'acc-norecord', 'acc-young']);
    const ids = (await auditRows()).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['vd-v-young', 'vd-v-held']));
  });

  it('dates the deletion from the latest vendor.deleted row', async () => {
    await seedVendorDeleted('v-twice', yearsAgo(9), 'vd-first');
    await seedVendorDeleted('v-twice', shift(CUT.acceptance, 1), 'vd-second');
    await seedAcceptance('acc-twice', 'v-twice', { acceptedAt: yearsAgo(10) });
    await runLegalRetentionPrune(t.db, NOW);
    expect(await acceptanceIds()).toEqual(['acc-twice']);
  });

  it('deletes a grant of a gone vendor by the same rule', async () => {
    await seedVendor('v-host', { claimEndedAt: null });
    await seedGrant('g-old', 'v-gone', {
      status: 'withdrawn',
      decidedAt: yearsAgo(6),
      billingAccountId: 'ba-v-host',
    });
    await seedGrant('g-young', 'v-young', {
      status: 'withdrawn',
      decidedAt: yearsAgo(6),
      billingAccountId: 'ba-v-host',
    });
    await seedGrant('g-norecord', 'v-norecord', {
      status: 'withdrawn',
      decidedAt: yearsAgo(6),
      billingAccountId: 'ba-v-host',
    });
    const vd = await seedVendorDeleted('v-gone', yearsAgo(7));
    await seedVendorDeleted('v-young', yearsAgo(5));

    const result = await runLegalRetentionPrune(t.db, NOW);

    expect(await grantIds()).toEqual(['g-norecord', 'g-young']);
    expect((await auditRows()).map((r) => r.id)).not.toContain(vd);
    const [run] = await pruneRows();
    expect(
      (run!.metadata as { tables: { table: string; ids?: string[] }[] }).tables,
    ).toContainEqual(expect.objectContaining({ table: 'license_grants', ids: ['g-old'] }));
    expect(result.tables.find((x) => x.table === 'audit_log')).toMatchObject({
      companionRowsDeleted: 1,
    });
  });
});

describe('the vendor.deleted row in the four-year part', () => {
  it('keeps one older than four years while an acceptance names its vendor, and deletes one no acceptance names', async () => {
    // Deleted five years ago: past the four-year cutoff, inside the six-year one.
    const named = await seedVendorDeleted('v-named', yearsAgo(5));
    await seedAcceptance('acc-named', 'v-named', { acceptedAt: yearsAgo(10) });
    const bare = await seedVendorDeleted('v-bare', yearsAgo(5));
    // The same id promoted back: its rows are dated by its account, so the old row is an
    // ordinary four-year row.
    await seedVendor('v-back', { claimEndedAt: null });
    await seedAcceptance('acc-back', 'v-back', { acceptedAt: yearsAgo(10) });
    const back = await seedVendorDeleted('v-back', yearsAgo(5));

    const result = await runLegalRetentionPrune(t.db, NOW);

    const ids = (await auditRows()).map((r) => r.id);
    expect(ids).toContain(named);
    expect(ids).not.toContain(bare);
    expect(ids).not.toContain(back);
    expect(await acceptanceIds()).toEqual(['acc-back', 'acc-named']);
    expect(result.tables.find((x) => x.table === 'audit_log')).toMatchObject({ rowsDeleted: 2 });
  });
});

describe('every arm under a global hold', () => {
  async function seedEveryArm() {
    await seedVendor('v-a', { claimEndedAt: yearsAgo(7) });
    await seedAcceptance('acc-a', 'v-a', { acceptedAt: yearsAgo(10) });
    await seedClaim('claim-b', { status: 'rejected', resolvedAt: yearsAgo(7) });
    await seedAcceptance('acc-b', null, { acceptedAt: yearsAgo(10), vendorRequestId: 'claim-b' });
    await seedAcceptance('acc-c', null, { acceptedAt: yearsAgo(10) });
    await seedVendorDeleted('v-d', yearsAgo(7));
    await seedAcceptance('acc-d', 'v-d', { acceptedAt: yearsAgo(10) });
  }

  it('deletes nothing in any arm', async () => {
    await seedEveryArm();
    await seedHold('global', null);
    const result = await runLegalRetentionPrune(t.db, NOW);
    expect(result).toMatchObject({ status: 'skipped', rowsDeleted: 0 });
    expect(await acceptanceIds()).toEqual(['acc-a', 'acc-b', 'acc-c', 'acc-d']);
  });

  it('without the hold every arm goes, and the ids round-trip through the chain verify parser', async () => {
    await seedEveryArm();
    await runLegalRetentionPrune(t.db, NOW);
    expect(await acceptanceIds()).toEqual([]);
    const [run] = await pruneRows();
    const [raw] = t.raw.prepare('SELECT metadata FROM audit_log WHERE id = ?').all(run!.id) as {
      metadata: string;
    }[];
    expect([...pruneAuditIds([raw!.metadata])].sort()).toEqual([
      'agreement_acceptances:acc-a',
      'agreement_acceptances:acc-b',
      'agreement_acceptances:acc-c',
      'agreement_acceptances:acc-d',
    ]);
  });

  it('a global hold placed after planning aborts the batch for every arm', async () => {
    await seedEveryArm();
    const batch = t.db.batch.bind(t.db);
    const spy = vi.spyOn(t.db, 'batch').mockImplementationOnce(async (stmts) => {
      await seedHold('global', null);
      return batch(stmts);
    });
    const error = await runLegalRetentionPrune(t.db, NOW).catch((e: unknown) => e);
    spy.mockRestore();
    expect(isLegalRetentionRaceError(error)).toBe(true);
    expect(await acceptanceIds()).toEqual(['acc-a', 'acc-b', 'acc-c', 'acc-d']);
    expect((await auditRows()).map((r) => r.id)).toContain('vd-v-d');
  });
});

describe('the audit row', () => {
  it('is one retention.pruned row whose ids round-trip through the chain verify parser', async () => {
    await seedVendor('v-old', { claimEndedAt: yearsAgo(7) });
    await seedGrant('g-old', 'v-old', { status: 'withdrawn', decidedAt: yearsAgo(6) });
    await seedAcceptance('acc-a', 'v-old', { acceptedAt: yearsAgo(10) });
    await seedAcceptance('acc-b', 'v-old', { grantId: 'g-old', acceptedAt: yearsAgo(9) });
    await seedAudit('vendor.updated', shift(CUT.audit, -1));

    const result = await runLegalRetentionPrune(t.db, NOW);

    const rows = await pruneRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({ actorType: 'system', entityType: 'retention' });
    expect(row.id).toBe(result.status === 'pruned' ? result.auditEntry?.id : undefined);
    expect(row.metadata).toMatchObject({
      rowsDeleted: 4,
      tables: [
        { table: 'audit_log', cutoff: CUT.audit, rowsDeleted: 1 },
        {
          table: 'agreement_acceptances',
          cutoff: CUT.acceptance,
          rowsDeleted: 2,
          ids: ['acc-a', 'acc-b'],
        },
        { table: 'license_grants', cutoff: CUT.grant, rowsDeleted: 1, ids: ['g-old'] },
      ],
    });
    // AECI-1680's verify reads the stored JSON text, so feed it the raw column.
    const [raw] = t.raw.prepare('SELECT metadata FROM audit_log WHERE id = ?').all(row.id) as {
      metadata: string;
    }[];
    expect([...pruneAuditIds([raw!.metadata])].sort()).toEqual([
      'agreement_acceptances:acc-a',
      'agreement_acceptances:acc-b',
      'license_grants:g-old',
    ]);
  });
});

describe('the audit row holds no personal data', () => {
  it('carries exactly the allowed keys at every level, no actor and no vendor', async () => {
    await seedVendor('v-old', { claimEndedAt: yearsAgo(7) });
    await seedGrant('g-old', 'v-old', { status: 'withdrawn', decidedAt: yearsAgo(6) });
    await seedAcceptance('acc-a', 'v-old', { acceptedAt: yearsAgo(10) });
    await t.db.insert(auditLog).values({
      id: 'au-companion',
      actorType: 'user',
      action: 'agreement.accepted',
      entityType: 'agreement_acceptance',
      entityId: 'acc-a',
      createdAt: yearsAgo(10),
    });
    await seedAudit('vendor.updated', shift(CUT.audit, -1));
    // A hold released more than four years ago, whose reason names a person.
    await t.db.insert(litigationHolds).values({
      id: 'h-released',
      scope: 'global',
      reason: 'Jane Doe v. Example Corp',
      placedBy: 'admin-1',
      placedAt: '2025-01-01T00:00:00.000Z',
      releasedAt: shift(CUT.audit, -2),
      releasedBy: 'admin-1',
      releaseReason: 'Settled with Jane Doe',
    });
    await t.db.insert(auditLog).values({
      id: 'au-hold',
      actorId: null,
      actorType: 'admin',
      action: 'litigation_hold.placed',
      entityType: 'litigation_hold',
      entityId: 'h-released',
      metadata: { reason: 'Jane Doe v. Example Corp' },
      createdAt: '2025-01-01T00:00:00.000Z',
    });

    const result = await runLegalRetentionPrune(t.db, NOW);
    const entry = result.status === 'pruned' ? result.auditEntry : undefined;
    expect(entry).toBeDefined();

    // A key added to the run record must be added here on purpose, after asking whether it
    // is personal. The record outlives every row it names.
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(entry!)).toEqual(['action', 'actorType', 'entityType', 'id', 'metadata']);
    expect(entry!.actorId ?? null).toBeNull();
    expect(entry!).not.toHaveProperty('vendorId');
    const metadata = entry!.metadata as Record<string, unknown>;
    expect(keys(metadata)).toEqual(['rowsDeleted', 'source', 'tables']);
    const allowed: Record<string, string[]> = {
      audit_log: ['companionRowsDeleted', 'cutoff', 'holdAuditRowsDeleted', 'rowsDeleted', 'table'],
      agreement_acceptances: ['cutoff', 'ids', 'rowsDeleted', 'table'],
      license_grants: ['cutoff', 'ids', 'rowsDeleted', 'table'],
      // Not chained, so no ids: the hold's free-text reason never reaches the run record.
      litigation_holds: ['cutoff', 'rowsDeleted', 'table'],
    };
    const tables = metadata.tables as Record<string, unknown>[];
    expect(tables.map((x) => x.table)).toEqual(Object.keys(allowed));
    for (const table of tables) {
      expect(keys(table)).toEqual(allowed[table.table as string]);
      if ('ids' in table) {
        for (const id of table.ids as unknown[]) expect(typeof id).toBe('string');
      }
    }

    // The stored row matches the entry: no actor, no vendor, no plan stamps.
    const [row] = await t.db.select().from(auditLog).where(eq(auditLog.id, entry!.id!));
    expect(row).toMatchObject({
      actorId: null,
      entityId: null,
      vendorId: null,
      productId: null,
      vendorTier: null,
      vendorEntitlementStatus: null,
      beforeState: null,
      afterState: null,
    });
    const text = JSON.stringify(row?.metadata);
    // No address and no personal key anywhere in the stored JSON.
    expect(text).not.toMatch(/@|"(ip|email|name|signer_\w+|user_agent|profile_id|reason)"/i);
    expect(text).not.toContain('Jane Doe');
  });
});

describe('the agreement.* rows that list acceptance ids', () => {
  /** A vendor whose claim acceptance is due and whose grant acceptance is held by the grant
   *  floor (expired four years ago). */
  async function seedTwoAcceptances() {
    await seedVendor('v-two', { claimEndedAt: yearsAgo(8) });
    await seedGrant('g-floor', 'v-two', { status: 'expired', decidedAt: yearsAgo(4) });
    await seedAcceptance('acc-claim', 'v-two', { acceptedAt: yearsAgo(10) });
    await seedAcceptance('acc-grant', 'v-two', { grantId: 'g-floor', acceptedAt: yearsAgo(9) });
  }
  const ancient = yearsAgo(10);
  const linkedRow = (id: string, acceptanceIds: unknown) => ({
    id,
    actorId: null,
    actorType: 'admin',
    action: 'agreement.linked',
    entityType: 'vendor_request',
    entityId: 'claim-1',
    vendorId: 'v-two',
    afterState: { acceptance_ids: acceptanceIds, profile_id: 'p-1', vendor_id: 'v-two' },
    createdAt: ancient,
  });
  const evidenceRow = (id: string, acceptanceIds: unknown) => ({
    id,
    actorType: 'system',
    action: 'agreement.evidence_removed',
    entityType: 'agreement_acceptance',
    entityId: null,
    metadata: { acceptance_ids: acceptanceIds, count: 1 },
    createdAt: ancient,
  });

  it('keeps agreement.linked while one of its acceptances remains, and deletes it with the last', async () => {
    await seedTwoAcceptances();
    await t.db
      .insert(auditLog)
      .values([
        linkedRow('au-linked-both', ['acc-claim', 'acc-grant']),
        linkedRow('au-linked-claim', ['acc-claim']),
      ]);

    // Run 1: the claim acceptance goes, the grant acceptance is under the five-year floor.
    await runLegalRetentionPrune(t.db, NOW);
    expect(await acceptanceIds()).toEqual(['acc-grant']);
    let ids = (await auditRows()).map((r) => r.id);
    expect(ids).toContain('au-linked-both');
    expect(ids).not.toContain('au-linked-claim');

    // Run 2, two years on: the grant floor has passed, the last acceptance goes, and the
    // linked row goes in the same batch.
    const later = new Date('2036-06-15T03:00:00.000Z');
    const result = await runLegalRetentionPrune(t.db, later);
    expect(await acceptanceIds()).toEqual([]);
    ids = (await auditRows()).map((r) => r.id);
    expect(ids).not.toContain('au-linked-both');
    expect(result.tables.find((x) => x.table === 'audit_log')).toMatchObject({
      companionRowsDeleted: 1,
    });
  });

  it('keeps agreement.evidence_removed while one of its acceptances remains, and deletes it with the last', async () => {
    await seedTwoAcceptances();
    await t.db
      .insert(auditLog)
      .values([
        evidenceRow('au-ev-both', ['acc-claim', 'acc-grant']),
        evidenceRow('au-ev-claim', ['acc-claim']),
      ]);

    await runLegalRetentionPrune(t.db, NOW);
    let ids = (await auditRows()).map((r) => r.id);
    expect(ids).toContain('au-ev-both');
    expect(ids).not.toContain('au-ev-claim');

    await runLegalRetentionPrune(t.db, new Date('2036-06-15T03:00:00.000Z'));
    ids = (await auditRows()).map((r) => r.id);
    expect(ids).not.toContain('au-ev-both');
  });

  it('never matches a row whose acceptance list is missing, empty, not an array or malformed', async () => {
    await seedVendor('v-two', { claimEndedAt: yearsAgo(8) });
    await seedAcceptance('acc-claim', 'v-two', { acceptedAt: yearsAgo(10) });
    await t.db
      .insert(auditLog)
      .values([
        linkedRow('au-l-empty', []),
        linkedRow('au-l-string', 'acc-claim'),
        evidenceRow('au-e-empty', []),
      ]);
    // A malformed JSON value, written raw: the guard must keep it and not abort the batch.
    t.raw
      .prepare(
        `INSERT INTO audit_log (id, actor_type, action, vendor_id, after_state, created_at)
         VALUES ('au-l-bad', 'admin', 'agreement.linked', 'v-two', '{not json', ?)`,
      )
      .run(ancient);

    await runLegalRetentionPrune(t.db, NOW);

    expect(await acceptanceIds()).toEqual([]);
    // Read raw: Drizzle's JSON column would refuse to parse the malformed row.
    const left = (t.raw.prepare('SELECT id FROM audit_log').all() as { id: string }[]).map(
      (r) => r.id,
    );
    expect(left).toEqual(
      expect.arrayContaining(['au-l-empty', 'au-l-string', 'au-e-empty', 'au-l-bad']),
    );
  });
});

describe('released litigation holds', () => {
  const DAY = 86_400_000;
  /** The UTC midnight four years (1,461 days) before NOW, the audit cutoff. */
  const releasedDaysBeforeCutoff = (days: number) =>
    new Date(Date.parse(CUT.audit) - days * DAY).toISOString();

  async function seedReleasedHold(id: string, releasedAt: string | null) {
    await t.db.insert(litigationHolds).values({
      id,
      scope: 'vendor',
      vendorId: `v-${id}`,
      reason: 'A person named in the matter',
      placedBy: 'admin-1',
      placedAt: '2025-01-01T00:00:00.000Z',
      releasedAt,
      releasedBy: releasedAt ? 'admin-1' : null,
      releaseReason: releasedAt ? 'Matter closed' : null,
    });
    for (const action of ['litigation_hold.placed', 'litigation_hold.released']) {
      await t.db.insert(auditLog).values({
        id: `${id}-${action}`,
        actorType: 'admin',
        action,
        entityType: 'litigation_hold',
        entityId: id,
        createdAt: '2025-01-01T00:00:00.000Z',
      });
    }
  }
  const holdIds = async () =>
    (await t.db.select({ id: litigationHolds.id }).from(litigationHolds)).map((r) => r.id).sort();
  const holdAuditFor = async (id: string) =>
    (await auditRows()).filter((r) => r.entityId === id).length;

  it('keeps an open hold and its audit rows', async () => {
    await seedReleasedHold('h-open', null);
    await runLegalRetentionPrune(t.db, NOW);
    expect(await holdIds()).toEqual(['h-open']);
    expect(await holdAuditFor('h-open')).toBe(2);
  });

  it('keeps a hold released 3 years 364 days ago, and deletes one released 4 years and a day ago', async () => {
    // 1,460 days before NOW's midnight is one day inside the cutoff.
    await seedReleasedHold('h-young', releasedDaysBeforeCutoff(-1));
    await seedReleasedHold('h-old', releasedDaysBeforeCutoff(1));

    const result = await runLegalRetentionPrune(t.db, NOW);

    expect(await holdIds()).toEqual(['h-young']);
    expect(await holdAuditFor('h-young')).toBe(2);
    expect(await holdAuditFor('h-old')).toBe(0);
    expect(result.tables.find((x) => x.table === 'litigation_holds')).toMatchObject({
      rowsDeleted: 1,
    });
    expect(result.tables.find((x) => x.table === 'audit_log')).toMatchObject({
      rowsDeleted: 2,
      holdAuditRowsDeleted: 2,
    });
    const [run] = await pruneRows();
    expect((run!.metadata as { tables: { table: string }[] }).tables).toContainEqual({
      table: 'litigation_holds',
      cutoff: CUT.audit,
      rowsDeleted: 1,
    });
  });

  it('an open hold on the same company keeps a released hold; one on another company does not (ruling 55)', async () => {
    await seedReleasedHold('h-same', releasedDaysBeforeCutoff(1));
    await seedReleasedHold('h-other', releasedDaysBeforeCutoff(1));
    // `seedReleasedHold` holds `v-<id>`. A new hold on `v-h-same` covers the first only.
    await seedHold('vendor', 'v-h-same');
    const result = await runLegalRetentionPrune(t.db, NOW);
    expect(await holdIds()).toContain('h-same');
    expect(await holdIds()).not.toContain('h-other');
    expect(await holdAuditFor('h-same')).toBe(2);
    expect(await holdAuditFor('h-other')).toBe(0);
    expect(result.tables.find((x) => x.table === 'litigation_holds')).toMatchObject({
      rowsDeleted: 1,
    });
    expect(result.tables.find((x) => x.table === 'litigation_holds')).not.toHaveProperty('paused');
  });

  it('any open hold keeps a released global hold, whose matter may concern anyone', async () => {
    await t.db.insert(litigationHolds).values({
      id: 'h-global-old',
      scope: 'global',
      reason: 'Old matter',
      placedBy: 'admin-1',
      placedAt: '2025-01-01T00:00:00.000Z',
      releasedAt: releasedDaysBeforeCutoff(1),
      releasedBy: 'admin-1',
      releaseReason: 'Closed',
    });
    await seedHold('vendor', 'v-new');
    await runLegalRetentionPrune(t.db, NOW);
    expect(await holdIds()).toContain('h-global-old');
  });
});

describe('litigation holds', () => {
  async function seedDue() {
    await seedVendor('v-held', { claimEndedAt: yearsAgo(7) });
    await seedVendor('v-free', { claimEndedAt: yearsAgo(7) });
    await seedAcceptance('acc-held', 'v-held', { acceptedAt: yearsAgo(10) });
    await seedAcceptance('acc-free', 'v-free', { acceptedAt: yearsAgo(10) });
    await seedGrant('g-held', 'v-held', { status: 'expired', decidedAt: yearsAgo(6) });
    return seedAudit('vendor.updated', shift(CUT.audit, -1));
  }

  it('a global hold deletes nothing and reports skipped', async () => {
    const old = await seedDue();
    await seedHold('global', null);

    const result = await runLegalRetentionPrune(t.db, NOW);

    expect(result).toMatchObject({ status: 'skipped', reason: 'litigation_hold', rowsDeleted: 0 });
    expect(await acceptanceIds()).toEqual(['acc-free', 'acc-held']);
    expect(await grantIds()).toEqual(['g-held']);
    expect((await auditRows()).map((r) => r.id)).toEqual([old]);
  });

  it('a vendor hold keeps that vendor; others and unrelated audit rows are pruned (ruling 55)', async () => {
    const old = await seedDue();
    await seedHold('vendor', 'v-held');

    const result = await runLegalRetentionPrune(t.db, NOW);

    expect(await acceptanceIds()).toEqual(['acc-held']);
    expect(await grantIds()).toEqual(['g-held']);
    // `old` names no company, so the hold on `v-held` does not keep it.
    expect((await auditRows()).map((r) => r.id)).not.toContain(old);
    expect(result).toMatchObject({ status: 'pruned', vendorHolds: 1 });
    expect(result.tables.find((x) => x.table === 'audit_log')).toMatchObject({
      rowsDeleted: 1,
    });
    expect(result.tables.find((x) => x.table === 'audit_log')).not.toHaveProperty('paused');
    const [run] = await pruneRows();
    expect(run!.metadata).toMatchObject({ vendorHolds: 1 });
  });

  it('a released hold no longer stops anything', async () => {
    const old = await seedDue();
    await seedHold('global', null, true);
    await seedHold('vendor', 'v-held', true);

    await runLegalRetentionPrune(t.db, NOW);

    expect(await acceptanceIds()).toEqual([]);
    expect(await grantIds()).toEqual([]);
    expect((await auditRows()).map((r) => r.id)).not.toContain(old);
  });

  it('a hold placed after planning aborts the batch, and nothing is deleted', async () => {
    const old = await seedDue();
    // Place the hold between the reads and the batch, as a concurrent admin would.
    const batch = t.db.batch.bind(t.db);
    const spy = vi.spyOn(t.db, 'batch').mockImplementationOnce(async (stmts) => {
      await t.db.insert(litigationHolds).values({
        scope: 'global',
        reason: 'Late hold',
        placedBy: 'admin-1',
        placedAt: '2034-06-15T02:59:00.000Z',
      });
      return batch(stmts);
    });

    const error = await runLegalRetentionPrune(t.db, NOW).catch((e: unknown) => e);

    expect(isLegalRetentionRaceError(error)).toBe(true);
    spy.mockRestore();
    expect(await acceptanceIds()).toEqual(['acc-free', 'acc-held']);
    expect((await auditRows()).map((r) => r.id)).toEqual([old]);
  });

  it('a vendor hold placed after planning aborts the batch, and nothing is deleted', async () => {
    await seedVendor('v-late', { claimEndedAt: null });
    const free = await seedAudit('vendor.updated', shift(CUT.audit, -1));
    await t.db.insert(auditLog).values({
      id: 'au-late',
      actorType: 'admin',
      action: 'vendor.updated',
      entityType: 'vendor',
      entityId: 'v-late',
      createdAt: shift(CUT.audit, -1),
    });
    const batch = t.db.batch.bind(t.db);
    const spy = vi.spyOn(t.db, 'batch').mockImplementationOnce(async (stmts) => {
      await seedHold('vendor', 'v-late');
      return batch(stmts);
    });

    const error = await runLegalRetentionPrune(t.db, NOW).catch((e: unknown) => e);

    expect(isLegalRetentionRaceError(error)).toBe(true);
    spy.mockRestore();
    expect((await auditRows()).map((r) => r.id).sort()).toEqual(['au-late', free].sort());
    // The replan reads the hold, keeps the held company's row and deletes the other.
    await runLegalRetentionPruneWithReplan(t.db, NOW);
    expect((await auditRows()).map((r) => r.id)).toContain('au-late');
    expect((await auditRows()).map((r) => r.id)).not.toContain(free);
  });

  it('a reclaim after planning aborts the batch too', async () => {
    await seedVendor('v-race', { claimEndedAt: yearsAgo(7) });
    await seedAcceptance('acc-race', 'v-race', { acceptedAt: yearsAgo(10) });
    const batch = t.db.batch.bind(t.db);
    const spy = vi.spyOn(t.db, 'batch').mockImplementationOnce(async (stmts) => {
      await t.db.update(vendors).set({ claimEndedAt: null }).where(eq(vendors.id, 'v-race'));
      return batch(stmts);
    });

    const error = await runLegalRetentionPrune(t.db, NOW).catch((e: unknown) => e);

    expect(isLegalRetentionRaceError(error)).toBe(true);
    spy.mockRestore();
    expect(await acceptanceIds()).toEqual(['acc-race']);
    expect(await pruneRows()).toEqual([]);
  });
});

describe('a vendor hold keeps only its company’s audit rows (ruling 55, AECI-1970)', () => {
  const OLD = shift(CUT.audit, -1);

  /**
   * Two companies, A (held) and B, a product each, two products with no company, a seat
   * of A, a reader, and every kind of tie `auditRowOfVendor` reads. Every audit row is past
   * the four-year cutoff. Returns the ids that belong to A and the ids that do not.
   */
  async function seedTwoCompanies() {
    for (const v of ['v-a', 'v-b']) await seedVendor(v, { claimEndedAt: null });
    for (const [p, v] of [
      ['p-a', 'v-a'],
      ['p-b', 'v-b'],
      ['p-c', null],
      ['p-d', null],
      ['p-e', null],
    ] as const) {
      await t.db.insert(products).values({ id: p, slug: p, name: p });
      if (v) await t.db.insert(productVendors).values({ productId: p, vendorId: v });
    }
    await t.db.insert(profiles).values({ id: 'seat-a', vendorId: 'v-a', role: 'vendor_admin' });
    await t.db.insert(profiles).values({ id: 'reader-1' });
    await t.db.insert(taxonomyDataObjects).values({ id: 'do-1', slug: 'do-1', name: 'Data' });
    // i-a has A's product at one end; i-b joins B's product to the unowned one.
    await t.db.insert(integrations).values([
      { id: 'i-a', sourceProductId: 'p-c', targetProductId: 'p-a' },
      { id: 'i-b', sourceProductId: 'p-b', targetProductId: 'p-c' },
      { id: 'i-via-a', sourceProductId: 'p-c', targetProductId: 'p-d', poweredByProductId: 'p-a' },
    ]);
    await t.db.insert(claims).values([
      { id: 'c-a', integrationId: 'i-a', dataObjectId: 'do-1', direction: 'a_to_b' },
      { id: 'c-b', integrationId: 'i-b', dataObjectId: 'do-1', direction: 'a_to_b' },
    ]);
    // A built i-built between two products it owns neither of.
    await t.db.insert(integrations).values({
      id: 'i-built',
      sourceProductId: 'p-d',
      targetProductId: 'p-e',
      builtByVendorId: 'v-a',
    });
    // Connector-backed relationships (Addenda B and C). ep-a has A's product at one end,
    // ep-built was built by A between unowned products, ep-b is B's.
    await t.db.insert(connectorEvidencedPairs).values([
      { id: 'ep-a', connectorProductId: 'p-c', productAId: 'p-a', productBId: 'p-d' },
      {
        id: 'ep-built',
        connectorProductId: 'p-c',
        productAId: 'p-d',
        productBId: 'p-e',
        builtByVendorId: 'v-a',
      },
      { id: 'ep-b', connectorProductId: 'p-c', productAId: 'p-b', productBId: 'p-d' },
    ]);
    // cat-a is A's connector's catalog. cat-x is an unowned connector's, with one stub
    // mapped to A's product.
    const stamps = {
      firstSeenAt: '2025-01-01T00:00:00.000Z',
      lastSeenAt: '2025-01-01T00:00:00.000Z',
    };
    await t.db.insert(connectorCatalogs).values([
      { id: 'cat-a', connectorProductId: 'p-a' },
      { id: 'cat-x', connectorProductId: 'p-c' },
    ]);
    await t.db.insert(connectorStubs).values([
      { id: 's-a1', catalogId: 'cat-a', slug: 's1', ...stamps },
      { id: 's-a2', catalogId: 'cat-a', slug: 's2', ...stamps },
      { id: 's-x1', catalogId: 'cat-x', slug: 's1', ...stamps },
      { id: 's-x2', catalogId: 'cat-x', slug: 's2', ...stamps },
      { id: 's-x3', catalogId: 'cat-x', slug: 's3', ...stamps },
    ]);
    await t.db.insert(connectorStubMappings).values({
      id: 'm-x1',
      stubId: 's-x1',
      catalogId: 'cat-x',
      productId: 'p-a',
      status: 'mapped',
      decidedBy: 'chris',
    });
    await t.db.insert(connectorPairs).values([
      { id: 'cp-a', catalogId: 'cat-a', stubAId: 's-a1', stubBId: 's-a2', ...stamps },
      { id: 'cp-map', catalogId: 'cat-x', stubAId: 's-x1', stubBId: 's-x2', ...stamps },
      { id: 'cp-x', catalogId: 'cat-x', stubAId: 's-x2', stubBId: 's-x3', ...stamps },
    ]);
    await t.db.insert(claims).values([
      { id: 'c-ep', connectorEvidencedPairId: 'ep-a', dataObjectId: 'do-1', direction: 'a_to_b' },
      { id: 'c-ep-b', connectorEvidencedPairId: 'ep-b', dataObjectId: 'do-1', direction: 'a_to_b' },
      { id: 'c-cp', connectorPairId: 'cp-a', dataObjectId: 'do-1', direction: 'a_to_b' },
      { id: 'c-map', connectorPairId: 'cp-map', dataObjectId: 'do-1', direction: 'a_to_b' },
      { id: 'c-cp-x', connectorPairId: 'cp-x', dataObjectId: 'do-1', direction: 'a_to_b' },
    ]);
    await t.db.insert(attestations).values([
      { id: 'at-a', claimId: 'c-a', source: 'vendor_a' },
      { id: 'at-b', claimId: 'c-b', source: 'vendor_a' },
      { id: 'at-ep', claimId: 'c-ep', source: 'vendor_a' },
      { id: 'at-cp', claimId: 'c-map', source: 'vendor_a' },
    ]);
    for (const [id, product] of [
      ['r-a', 'p-a'],
      ['r-b', 'p-b'],
    ] as const) {
      await t.db.insert(reviews).values({
        id,
        productId: product,
        reviewerId: 'reader-1',
        ratingOverall: 4,
        ratingOnboarding: 4,
        title: 'Review',
        body: 'Body',
      });
    }
    await seedClaim('q-a', { status: 'rejected', targetType: 'vendor', targetId: 'v-a' });
    await seedClaim('q-pa', { status: 'rejected', targetType: 'product', targetId: 'p-a' });
    await seedClaim('q-b', { status: 'rejected', targetType: 'vendor', targetId: 'v-b' });

    const row = async (
      id: string,
      fields: Partial<typeof auditLog.$inferInsert> = {},
    ): Promise<string> => {
      await t.db.insert(auditLog).values({
        id,
        actorType: 'admin',
        action: 'test.action',
        createdAt: OLD,
        ...fields,
      });
      return id;
    };
    const kept = [
      // 1. The vendor_id column, even on a row filed under a product no company holds.
      await row('a-column', { vendorId: 'v-a', entityType: 'product', entityId: 'p-c' }),
      // 2. Filed under the company.
      await row('a-vendor', { entityType: 'vendor', entityId: 'v-a' }),
      await row('a-entitlement', { entityType: 'vendor_entitlement', entityId: 'v-a' }),
      // 3. Legacy metadata, both spellings.
      await row('a-meta-snake', {
        action: 'vendor_seat.invited',
        entityType: 'vendor_seat_invite',
        entityId: 'inv-1',
        metadata: { vendor_id: 'v-a' },
      }),
      await row('a-meta-camel', { entityType: 'value', metadata: { vendorId: 'v-a' } }),
      // 4. About one of A's products, its integrations, their claims and attestations, and
      //    its reviews: a reader's review of A's product is A's record too.
      await row('a-product-col', {
        entityType: 'product_version',
        entityId: 'pv-1',
        productId: 'p-a',
      }),
      await row('a-product', { actorType: 'system', entityType: 'product', entityId: 'p-a' }),
      await row('a-integration', { entityType: 'integration', entityId: 'i-a' }),
      await row('a-powered-by', { entityType: 'integration', entityId: 'i-via-a' }),
      await row('a-claim', { entityType: 'claim', entityId: 'c-a' }),
      await row('a-attestation', { entityType: 'attestation', entityId: 'at-a' }),
      await row('a-review', {
        actorId: 'reader-1',
        actorType: 'user',
        entityType: 'review',
        entityId: 'r-a',
      }),
      // 5. A claim on A, by the company or by its product.
      await row('a-request', { entityType: 'vendor_request', entityId: 'q-a' }),
      await row('a-request-product', { entityType: 'vendor_request', entityId: 'q-pa' }),
      // 4b. Relationships A built, and connector-backed ones: the pair, its claims and their
      //     attestations, A's connector's catalog, and a pair whose stub maps to A.
      await row('a-built-integration', { entityType: 'integration', entityId: 'i-built' }),
      await row('a-evpair', { entityType: 'connector_evidenced_pair', entityId: 'ep-a' }),
      await row('a-evpair-built', { entityType: 'connector_evidenced_pair', entityId: 'ep-built' }),
      await row('a-ep-claim', { entityType: 'claim', entityId: 'c-ep' }),
      await row('a-ep-attestation', { entityType: 'attestation', entityId: 'at-ep' }),
      await row('a-catalog', { entityType: 'connector_catalog', entityId: 'cat-a' }),
      await row('a-cp-claim', { entityType: 'claim', entityId: 'c-cp' }),
      await row('a-mapped-pair', { entityType: 'connector_pair', entityId: 'cp-map' }),
      await row('a-mapped-claim', { entityType: 'claim', entityId: 'c-map' }),
      await row('a-mapped-attestation', { entityType: 'attestation', entityId: 'at-cp' }),
      // 6. Written by A's seat, whatever it is about.
      await row('a-seat', {
        actorId: 'seat-a',
        actorType: 'user',
        action: 'profile.updated',
        entityType: 'profile',
        entityId: 'seat-a',
      }),
    ];
    const deleted = [
      await row('b-column', { vendorId: 'v-b', entityType: 'vendor', entityId: 'v-b' }),
      await row('b-meta', { action: 'vendor_seat.invited', metadata: { vendor_id: 'v-b' } }),
      await row('b-product', { entityType: 'product', entityId: 'p-b', productId: 'p-b' }),
      await row('b-integration', { entityType: 'integration', entityId: 'i-b' }),
      await row('b-claim', { entityType: 'claim', entityId: 'c-b' }),
      await row('b-attestation', { entityType: 'attestation', entityId: 'at-b' }),
      await row('b-review', {
        actorId: 'reader-1',
        actorType: 'user',
        entityType: 'review',
        entityId: 'r-b',
      }),
      await row('b-request', { entityType: 'vendor_request', entityId: 'q-b' }),
      await row('b-evpair', { entityType: 'connector_evidenced_pair', entityId: 'ep-b' }),
      await row('b-ep-claim', { entityType: 'claim', entityId: 'c-ep-b' }),
      // A connector catalog, pair and claim no company holds.
      await row('unowned-catalog', { entityType: 'connector_catalog', entityId: 'cat-x' }),
      await row('unowned-pair', { entityType: 'connector_pair', entityId: 'cp-x' }),
      await row('unowned-pair-claim', { entityType: 'claim', entityId: 'c-cp-x' }),
      // A reader's own account row, and a system row about nothing.
      await row('reader-profile', {
        actorId: 'reader-1',
        actorType: 'user',
        action: 'profile.updated',
        entityType: 'profile',
        entityId: 'reader-1',
      }),
      await row('system-row', { actorType: 'system' }),
      // An unowned product, and A's id only as free text a tie does not read.
      await row('unowned-product', { entityType: 'product', entityId: 'p-c' }),
      await row('a-in-free-text', { afterState: { note: 'v-a' } }),
    ];
    // Metadata that is not JSON: never parsed, never matched, and no "malformed JSON" abort.
    await t.db.run(
      sql`INSERT INTO "audit_log" ("id", "actor_type", "action", "metadata", "created_at") VALUES ('bad-json', 'system', 'test.action', 'not json {', ${OLD})`,
    );
    deleted.push('bad-json');
    return { kept, deleted };
  }

  // Ids only: reading `metadata` would make Drizzle parse the malformed row.
  const remaining = async () =>
    new Set((await t.db.select({ id: auditLog.id }).from(auditLog)).map((r) => r.id));

  it('deletes other companies’ and readers’ expired rows, and keeps every row of the held company', async () => {
    const { kept, deleted } = await seedTwoCompanies();
    await seedHold('vendor', 'v-a');

    const result = await runLegalRetentionPrune(t.db, NOW);

    const left = await remaining();
    for (const id of kept) expect(left.has(id), `kept ${id}`).toBe(true);
    for (const id of deleted) expect(left.has(id), `deleted ${id}`).toBe(false);
    expect(result).toMatchObject({ status: 'pruned', vendorHolds: 1 });
    expect(result.tables.find((x) => x.table === 'audit_log')).toMatchObject({
      rowsDeleted: deleted.length,
      truncated: false,
    });
    // One run record, in the same batch, counting exactly the deletes.
    const runs = await pruneRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.metadata).toMatchObject({
      rowsDeleted: deleted.length,
      vendorHolds: 1,
      tables: [{ table: 'audit_log', rowsDeleted: deleted.length }],
    });
  });

  it('a hold on B instead keeps B’s rows and deletes A’s', async () => {
    const { kept, deleted } = await seedTwoCompanies();
    await seedHold('vendor', 'v-b');
    await runLegalRetentionPrune(t.db, NOW);
    const left = await remaining();
    for (const id of kept) expect(left.has(id), `deleted ${id}`).toBe(false);
    for (const id of [
      'b-column',
      'b-meta',
      'b-product',
      'b-integration',
      'b-claim',
      'b-attestation',
      'b-review',
      'b-request',
      'b-evpair',
      'b-ep-claim',
    ]) {
      expect(left.has(id), `kept ${id}`).toBe(true);
    }
    expect(left.has('reader-profile')).toBe(false);
    expect(deleted).toContain('reader-profile');
  });

  it('holds on both companies keep both, and still delete the reader’s and the system rows', async () => {
    await seedTwoCompanies();
    await seedHold('vendor', 'v-a');
    await seedHold('vendor', 'v-b');
    await runLegalRetentionPrune(t.db, NOW);
    const left = await remaining();
    expect(left.has('a-seat')).toBe(true);
    expect(left.has('b-review')).toBe(true);
    for (const id of ['reader-profile', 'system-row', 'unowned-product', 'bad-json']) {
      expect(left.has(id), `deleted ${id}`).toBe(false);
    }
  });

  it('a global hold still keeps every row', async () => {
    const { kept, deleted } = await seedTwoCompanies();
    await seedHold('global', null);
    const result = await runLegalRetentionPrune(t.db, NOW);
    expect(result).toMatchObject({ status: 'skipped', reason: 'litigation_hold' });
    const left = await remaining();
    for (const id of [...kept, ...deleted]) expect(left.has(id), `kept ${id}`).toBe(true);
  });

  it('once the hold is released, the held rows go on the next run', async () => {
    const { kept, deleted } = await seedTwoCompanies();
    await seedHold('vendor', 'v-a');
    await runLegalRetentionPrune(t.db, NOW);
    await t.db.update(litigationHolds).set({ releasedAt: '2034-06-01T00:00:00.000Z' });
    await runLegalRetentionPrune(t.db, NOW);
    const left = await remaining();
    for (const id of [...kept, ...deleted]) expect(left.has(id), `deleted ${id}`).toBe(false);
  });
});

describe('two runs at once (a queued run beside an inline fallback)', () => {
  /** An old audit row, and a hold released four years and a day ago with its audit row. */
  async function seedDueAuditAndHold() {
    const old = await seedAudit('vendor.updated', shift(CUT.audit, -1));
    await t.db.insert(litigationHolds).values({
      id: 'h-old',
      scope: 'global',
      reason: 'Old matter',
      placedBy: 'admin-1',
      placedAt: '2025-01-01T00:00:00.000Z',
      releasedAt: shift(CUT.audit, -1),
      releasedBy: 'admin-1',
      releaseReason: 'Closed',
    });
    await t.db.insert(auditLog).values({
      id: 'au-h-old',
      actorType: 'admin',
      action: 'litigation_hold.released',
      entityType: 'litigation_hold',
      entityId: 'h-old',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    return old;
  }

  /**
   * Hold the first batch until the second run reaches its own batch, then commit the first,
   * then let the second commit. Both plans are read before either commit, which is the
   * interleaving a duplicate delivery produces.
   */
  function interleave() {
    const realBatch = t.db.batch.bind(t.db);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first: Promise<unknown> | null = null;
    let calls = 0;
    return vi.spyOn(t.db, 'batch').mockImplementation((async (stmts: never) => {
      calls += 1;
      if (calls === 1) {
        first = gate.then(() => realBatch(stmts));
        return first;
      }
      if (calls === 2) {
        release();
        await first;
      }
      return realBatch(stmts);
    }) as never);
  }

  it('commits once: the loser aborts, replans, finds nothing and writes no audit row', async () => {
    const old = await seedDueAuditAndHold();
    const spy = interleave();

    const [winner, loser] = await Promise.all([
      runLegalRetentionPruneWithReplan(t.db, NOW),
      runLegalRetentionPruneWithReplan(t.db, NOW),
    ]);
    spy.mockRestore();

    const runs = await pruneRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.metadata).toMatchObject({
      rowsDeleted: 3,
      tables: [
        { table: 'audit_log', rowsDeleted: 2, holdAuditRowsDeleted: 1 },
        { table: 'litigation_holds', rowsDeleted: 1 },
      ],
    });
    expect((await auditRows()).map((r) => r.id)).not.toContain(old);
    expect(await t.db.select().from(litigationHolds)).toEqual([]);

    expect(winner).toMatchObject({ status: 'pruned', rowsDeleted: 3 });
    expect(winner.status === 'pruned' && winner.replanned).toBeFalsy();
    // The loser's first batch aborted on a sentinel. Its replan read the state the winner
    // left, found nothing due, and wrote nothing.
    expect(loser).toMatchObject({ status: 'pruned', rowsDeleted: 0, replanned: true });
    expect(loser.status === 'pruned' && loser.auditEntry).toBeFalsy();
  });

  it('without the replan, the losing batch throws a race error and deletes nothing', async () => {
    await seedDueAuditAndHold();
    const spy = interleave();
    const results = await Promise.allSettled([
      runLegalRetentionPrune(t.db, NOW),
      runLegalRetentionPrune(t.db, NOW),
    ]);
    spy.mockRestore();
    expect(results[0].status).toBe('fulfilled');
    expect(results[1].status).toBe('rejected');
    expect(isLegalRetentionRaceError((results[1] as PromiseRejectedResult).reason)).toBe(true);
    expect(await pruneRows()).toHaveLength(1);
  });

  it('the four-year sentinel alone stops a second claim of the same audit rows', async () => {
    // No hold and no acceptance: the four-year chunks are the only deletes, which had no
    // sentinel before this fix.
    await seedAudit('vendor.updated', shift(CUT.audit, -1));
    const spy = interleave();
    await Promise.allSettled([
      runLegalRetentionPrune(t.db, NOW),
      runLegalRetentionPrune(t.db, NOW),
    ]);
    spy.mockRestore();
    const runs = await pruneRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.metadata).toMatchObject({ rowsDeleted: 1 });
  });

  it('a second race in a row is reported as skipped: concurrent_run, not thrown', async () => {
    await seedDueAuditAndHold();
    const spy = vi
      .spyOn(t.db, 'batch')
      .mockRejectedValue(new Error('D1_ERROR: malformed JSON') as never);
    const result = await runLegalRetentionPruneWithReplan(t.db, NOW);
    spy.mockRestore();
    expect(result).toMatchObject({ status: 'skipped', reason: 'concurrent_run', rowsDeleted: 0 });
    expect(await pruneRows()).toEqual([]);
  });

  it('any other error still throws', async () => {
    await seedDueAuditAndHold();
    const spy = vi.spyOn(t.db, 'batch').mockRejectedValue(new Error('D1_ERROR: network') as never);
    await expect(runLegalRetentionPruneWithReplan(t.db, NOW)).rejects.toThrow('network');
    spy.mockRestore();
  });
});

describe('the Terms acceptance part (AECI-1718)', () => {
  const termsIds = async () =>
    (await t.db.select({ id: termsAcceptances.id }).from(termsAcceptances)).map((r) => r.id).sort();

  async function seedTerms(id: string, profileId: string, acceptedAt = yearsAgo(10)) {
    await t.db.insert(termsAcceptances).values({
      id,
      document: 'terms',
      version: id,
      profileId,
      email: 'reader@example.test',
      acceptedAt,
      checkboxLabel: 'By signing in, you agree to our Terms of Service and Privacy Policy.',
      checkboxLabelSha256: 'a'.repeat(64),
      checkboxDefaultUnticked: false,
    });
  }

  /** The `account.deleted` row `DELETE /api/account` writes in the batch that deletes the
   *  profile (`routes/account.ts`). */
  async function seedAccountDeleted(profileId: string, createdAt: string, id = `ad-${profileId}`) {
    await t.db.insert(auditLog).values({
      id,
      actorType: 'user',
      action: 'account.deleted',
      entityType: 'profile',
      entityId: profileId,
      createdAt,
    });
    return id;
  }

  async function seedTermsAccepted(acceptanceId: string, createdAt = yearsAgo(10)) {
    const id = `ta-${acceptanceId}`;
    await t.db.insert(auditLog).values({
      id,
      actorType: 'user',
      action: 'terms.accepted',
      entityType: 'terms_acceptance',
      entityId: acceptanceId,
      createdAt,
    });
    return id;
  }

  async function seedTermsEvidenceRemoved(id: string, acceptanceIds: string[], createdAt: string) {
    await t.db.insert(auditLog).values({
      id,
      actorType: 'system',
      action: 'terms.evidence_removed',
      entityType: 'terms_acceptance',
      metadata: { source: 'acceptance-evidence-removal', acceptance_ids: acceptanceIds },
      createdAt,
    });
    return id;
  }

  it('deletes a row six years and a day after the account ended, and keeps one a day short', async () => {
    await seedTerms('t-old', 'p-old');
    await seedAccountDeleted('p-old', yearsAgo(6, 1));
    await seedTerms('t-young', 'p-young');
    await seedAccountDeleted('p-young', yearsAgo(6, -1));

    const result = await runLegalRetentionPrune(t.db, NOW);

    expect(await termsIds()).toEqual(['t-young']);
    expect(result.tables.find((x) => x.table === 'terms_acceptances')).toEqual({
      table: 'terms_acceptances',
      cutoff: CUT.acceptance,
      rowsDeleted: 1,
      truncated: false,
    });
  });

  it('keeps the row of a live account, and of a gone profile with no account.deleted row', async () => {
    await seedTerms('t-live', 'p-live');
    await t.db.insert(profiles).values({ id: 'p-live' });
    // The shared staging login signing in again after a deletion: the profile is back.
    await seedAccountDeleted('p-live', yearsAgo(8));
    // Ruling 2 of 2026-11-19: no date, so the row is kept and the data-quality check counts it.
    await seedTerms('t-undated', 'p-undated');

    await runLegalRetentionPrune(t.db, NOW);

    expect(await termsIds()).toEqual(['t-live', 't-undated']);
  });

  it('keeps every Terms row under a global hold', async () => {
    await seedTerms('t-old', 'p-old');
    await seedAccountDeleted('p-old', yearsAgo(8));
    await seedHold('global', null);

    const result = await runLegalRetentionPrune(t.db, NOW);

    expect(result).toMatchObject({ status: 'skipped', reason: 'litigation_hold' });
    expect(await termsIds()).toEqual(['t-old']);
  });

  it('deletes terms.accepted, terms.evidence_removed and account.deleted with the last row', async () => {
    await seedTerms('t-a', 'p-old');
    await seedTerms('t-b', 'p-old');
    const deleted = await seedAccountDeleted('p-old', yearsAgo(7));
    const acceptedA = await seedTermsAccepted('t-a');
    const acceptedB = await seedTermsAccepted('t-b');
    const evidenceGone = await seedTermsEvidenceRemoved('ev-gone', ['t-a', 't-b'], yearsAgo(9));
    // Lists one kept row too, so it stays.
    await seedTerms('t-kept', 'p-young');
    const youngDeleted = await seedAccountDeleted('p-young', yearsAgo(5));
    const evidenceMixed = await seedTermsEvidenceRemoved(
      'ev-mixed',
      ['t-a', 't-kept'],
      yearsAgo(9),
    );
    const acceptedKept = await seedTermsAccepted('t-kept');

    const result = await runLegalRetentionPrune(t.db, NOW);

    expect(await termsIds()).toEqual(['t-kept']);
    const ids = (await auditRows()).map((r) => r.id);
    for (const id of [deleted, acceptedA, acceptedB, evidenceGone]) expect(ids).not.toContain(id);
    for (const id of [evidenceMixed, youngDeleted, acceptedKept]) expect(ids).toContain(id);
    expect(result.tables.find((x) => x.table === 'audit_log')).toMatchObject({
      rowsDeleted: 4,
      companionRowsDeleted: 4,
    });
  });

  it('in the four-year part, keeps account.deleted while a Terms row names the profile', async () => {
    // Deleted five years ago: past the four-year audit cutoff, inside the six-year period.
    await seedTerms('t-a', 'p-terms', yearsAgo(7));
    const withTerms = await seedAccountDeleted('p-terms', yearsAgo(5));
    // A deleted account that never accepted a Terms version: an ordinary four-year row.
    const withoutTerms = await seedAccountDeleted('p-none', yearsAgo(5));
    const young = await seedAccountDeleted('p-young', shift(CUT.audit, 1));

    await runLegalRetentionPrune(t.db, NOW);

    const ids = (await auditRows()).map((r) => r.id);
    expect(ids).toContain(withTerms);
    expect(ids).not.toContain(withoutTerms);
    expect(ids).toContain(young);
    expect(await termsIds()).toEqual(['t-a']);
  });

  it('reports the table in the retention.pruned row, with no ids and no email', async () => {
    await seedTerms('t-old', 'p-old');
    await seedAccountDeleted('p-old', yearsAgo(7));

    await runLegalRetentionPrune(t.db, NOW);

    const rows = await pruneRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({
      rowsDeleted: 2,
      tables: [
        { table: 'audit_log', rowsDeleted: 1, companionRowsDeleted: 1 },
        { table: 'terms_acceptances', cutoff: CUT.acceptance, rowsDeleted: 1 },
      ],
    });
    const terms = (rows[0]!.metadata as { tables: { table: string }[] }).tables.find(
      (x) => x.table === 'terms_acceptances',
    );
    expect(terms).not.toHaveProperty('ids');
    expect(JSON.stringify(rows[0]!.metadata)).not.toContain('reader@example.test');
  });

  it('stops at the per-table cap, reports truncated, and keeps account.deleted until the last row', async () => {
    const n = LEGAL_RETENTION_IDS_PER_TABLE + 1;
    t.raw
      .prepare(
        `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ?)
         INSERT INTO terms_acceptances (id, document, version, profile_id, email, accepted_at,
           checkbox_label, checkbox_label_sha256, checkbox_default_unticked, created_at)
         SELECT printf('t-%06d', i), 'terms', printf('v%06d', i), 'p-many', 'reader@example.test',
           ?, 'line', 'hash', 0, ? FROM s`,
      )
      .run(n, yearsAgo(10), yearsAgo(10));
    const deleted = await seedAccountDeleted('p-many', yearsAgo(7));

    const first = await runLegalRetentionPrune(t.db, NOW);

    expect(first.tables.find((x) => x.table === 'terms_acceptances')).toMatchObject({
      rowsDeleted: LEGAL_RETENTION_IDS_PER_TABLE,
      truncated: true,
    });
    expect(await termsIds()).toEqual(['t-000201']);
    expect((await auditRows()).map((r) => r.id)).toContain(deleted);

    await runLegalRetentionPrune(t.db, NOW);

    expect(await termsIds()).toEqual([]);
    expect((await auditRows()).map((r) => r.id)).not.toContain(deleted);
  });

  it('aborts when the profile comes back after planning', async () => {
    await seedTerms('t-old', 'p-old');
    await seedAccountDeleted('p-old', yearsAgo(7));
    const batch = t.db.batch.bind(t.db);
    const spy = vi.spyOn(t.db, 'batch').mockImplementationOnce(async (stmts) => {
      await t.db.insert(profiles).values({ id: 'p-old' });
      return batch(stmts);
    });

    const error = await runLegalRetentionPrune(t.db, NOW).catch((e: unknown) => e);

    expect(isLegalRetentionRaceError(error)).toBe(true);
    spy.mockRestore();
    expect(await termsIds()).toEqual(['t-old']);
  });
});

describe('metrics', () => {
  it('emits rows_deleted for every table, zeros included, and tags a skip and a scoped run', async () => {
    const counts: { metric: string; value: number; tags: string[] }[] = [];
    const sink = {
      count: (metric: string, value: number, tags: string[]) =>
        counts.push({ metric, value, tags }),
      distribution: () => undefined,
    };
    await seedHold('vendor', 'v-x');
    const scoped = await runLegalRetentionPrune(t.db, NOW);
    emitLegalRetentionPruneMetrics(sink, scoped, 5);
    expect(counts.filter((c) => c.metric === LEGAL_RETENTION_ROWS_METRIC)).toHaveLength(
      LEGAL_PRUNABLE.length,
    );
    expect(counts.find((c) => c.metric === LEGAL_RETENTION_RUN_METRIC)?.tags).toEqual([
      'trigger:cron',
      'outcome:ok',
      'audit:scoped',
    ]);

    counts.length = 0;
    await t.db.run(sql`DELETE FROM litigation_holds`);
    await seedHold('global', null);
    emitLegalRetentionPruneMetrics(sink, await runLegalRetentionPrune(t.db, NOW), 5);
    expect(counts.find((c) => c.metric === LEGAL_RETENTION_RUN_METRIC)?.tags).toEqual([
      'trigger:cron',
      'outcome:skipped',
      'reason:litigation_hold',
    ]);
  });
});

describe('the workflow tables, four years after the action (AECI-1913)', () => {
  const OLD = shift(CUT.audit, -1);
  const YOUNG = shift(CUT.audit, 1);

  async function seedInstance(
    id: string,
    opts: {
      type?: 'vendor_claim' | 'review_moderation' | 'correction_request' | 'reviewer_ban';
      entityId?: string;
      initiatedAt?: string;
      completedAt?: string | null;
      initiatedBy?: string | null;
      transitions?: { id: string; createdAt: string; actorId?: string }[];
    } = {},
  ) {
    await t.db.insert(workflowInstances).values({
      id,
      workflowType: opts.type ?? 'review_moderation',
      entityId: opts.entityId ?? `e-${id}`,
      currentState: 'submitted',
      initiatedBy: opts.initiatedBy ?? null,
      initiatedAt: opts.initiatedAt ?? OLD,
      completedAt: opts.completedAt ?? null,
    });
    for (const tr of opts.transitions ?? []) {
      await t.db.insert(workflowTransitions).values({
        id: tr.id,
        workflowId: id,
        toState: 'next',
        actorId: tr.actorId ?? null,
        createdAt: tr.createdAt,
      });
    }
  }
  const instanceIds = async () =>
    (await t.db.select({ id: workflowInstances.id }).from(workflowInstances))
      .map((r) => r.id)
      .sort();
  const transitionIds = async () =>
    (await t.db.select({ id: workflowTransitions.id }).from(workflowTransitions))
      .map((r) => r.id)
      .sort();
  const table = (result: Awaited<ReturnType<typeof runLegalRetentionPrune>>, name: string) =>
    result.tables.find((x) => x.table === name);

  it('deletes an instance whose last action is past the cutoff, and its transitions cascade', async () => {
    await seedInstance('wf-old', {
      initiatedAt: shift(OLD, -30),
      completedAt: OLD,
      transitions: [
        { id: 'tr-1', createdAt: shift(OLD, -30) },
        { id: 'tr-2', createdAt: OLD },
      ],
    });

    const result = await runLegalRetentionPrune(t.db, NOW);

    expect(await instanceIds()).toEqual([]);
    expect(await transitionIds()).toEqual([]);
    expect(table(result, 'workflow_instances')).toEqual({
      table: 'workflow_instances',
      cutoff: CUT.audit,
      rowsDeleted: 1,
      truncated: false,
    });
    expect(table(result, 'workflow_transitions')).toEqual({
      table: 'workflow_transitions',
      cutoff: CUT.audit,
      rowsDeleted: 2,
      truncated: false,
      cascadeRowsDeleted: 2,
    });
    const [run] = await pruneRows();
    expect(run!.metadata).toMatchObject({
      rowsDeleted: 3,
      tables: [
        { table: 'workflow_instances', cutoff: CUT.audit, rowsDeleted: 1 },
        {
          table: 'workflow_transitions',
          cutoff: CUT.audit,
          rowsDeleted: 2,
          cascadeRowsDeleted: 2,
        },
      ],
    });
    // Not chained: no ids in the run record.
    expect(JSON.stringify(run!.metadata)).not.toContain('wf-old');
  });

  it('deletes an open reviewer_ban instance whose only actions are old (it never completes)', async () => {
    await seedInstance('wf-ban', {
      type: 'reviewer_ban',
      entityId: 'reader-x',
      transitions: [{ id: 'tr-ban', createdAt: OLD }],
    });

    await runLegalRetentionPrune(t.db, NOW);

    expect(await instanceIds()).toEqual([]);
    expect(await transitionIds()).toEqual([]);
  });

  it('keeps an instance with a recent action, and deletes only its old transitions', async () => {
    await seedInstance('wf-live', {
      initiatedAt: shift(OLD, -10),
      transitions: [
        { id: 'tr-old', createdAt: shift(OLD, -10) },
        { id: 'tr-edge', createdAt: CUT.audit },
        { id: 'tr-young', createdAt: YOUNG },
      ],
    });
    // A young instance by its completion alone stays whole.
    await seedInstance('wf-completed-late', {
      initiatedAt: OLD,
      completedAt: YOUNG,
      transitions: [{ id: 'tr-c-old', createdAt: OLD }],
    });

    const result = await runLegalRetentionPrune(t.db, NOW);

    expect(await instanceIds()).toEqual(['wf-completed-late', 'wf-live']);
    expect(await transitionIds()).toEqual(['tr-edge', 'tr-young']);
    expect(table(result, 'workflow_instances')).toMatchObject({ rowsDeleted: 0 });
    expect(table(result, 'workflow_transitions')).toEqual({
      table: 'workflow_transitions',
      cutoff: CUT.audit,
      rowsDeleted: 2,
      truncated: false,
    });
  });

  it('keeps the instance of a request still open or in review while it names no actor', async () => {
    await seedClaim('q-open', { status: 'open' });
    await seedClaim('q-review', { status: 'in_review' });
    await seedClaim('q-done', { status: 'rejected', resolvedAt: OLD });
    for (const [id, entityId] of [
      ['wf-open', 'q-open'],
      ['wf-review', 'q-review'],
      ['wf-done', 'q-done'],
    ] as const) {
      await seedInstance(id, {
        type: 'vendor_claim',
        entityId,
        transitions: [{ id: `tr-${id}`, createdAt: OLD }],
      });
    }
    // An open request's instance that names an actor is not kept.
    await t.db.insert(profiles).values({ id: 'actor-1' });
    await seedClaim('q-named', { status: 'open' });
    await seedInstance('wf-named', {
      type: 'vendor_claim',
      entityId: 'q-named',
      initiatedBy: 'actor-1',
    });

    await runLegalRetentionPrune(t.db, NOW);

    // The reconciliation sweep retries an open request through its instance.
    expect(await instanceIds()).toEqual(['wf-open', 'wf-review']);
    expect(await transitionIds()).toEqual([]);
  });

  it('sets a contest’s workflow links to NULL and counts them', async () => {
    await seedVendor('v-s', { claimEndedAt: null });
    await t.db.insert(products).values([
      { id: 'p-x', slug: 'p-x', name: 'p-x' },
      { id: 'p-y', slug: 'p-y', name: 'p-y' },
    ]);
    await t.db.insert(integrations).values({
      id: 'i-x',
      sourceProductId: 'p-x',
      targetProductId: 'p-y',
    });
    await seedInstance('wf-contest', { type: 'correction_request', entityId: 'fc-1' });
    await seedInstance('wf-protest', { type: 'correction_request', entityId: 'fc-1' });
    await seedInstance('wf-keep', {
      type: 'correction_request',
      entityId: 'fc-2',
      initiatedAt: YOUNG,
    });
    await t.db.insert(integrationFieldChallenges).values([
      {
        id: 'fc-1',
        integrationId: 'i-x',
        field: 'name',
        reason: 'Old contest',
        submitterVendorId: 'v-s',
        routedTo: 'aeci',
        status: 'declined',
        workflowId: 'wf-contest',
        protestWorkflowId: 'wf-protest',
      },
      {
        id: 'fc-2',
        integrationId: 'i-x',
        field: 'docs_url',
        reason: 'New contest',
        submitterVendorId: 'v-s',
        routedTo: 'aeci',
        status: 'open',
        workflowId: 'wf-keep',
      },
    ]);

    const result = await runLegalRetentionPrune(t.db, NOW);

    const contests = await t.db
      .select({
        id: integrationFieldChallenges.id,
        workflowId: integrationFieldChallenges.workflowId,
        protestWorkflowId: integrationFieldChallenges.protestWorkflowId,
      })
      .from(integrationFieldChallenges)
      .orderBy(integrationFieldChallenges.id);
    expect(contests).toEqual([
      { id: 'fc-1', workflowId: null, protestWorkflowId: null },
      { id: 'fc-2', workflowId: 'wf-keep', protestWorkflowId: null },
    ]);
    expect(await instanceIds()).toEqual(['wf-keep']);
    expect(table(result, 'workflow_instances')).toMatchObject({
      rowsDeleted: 2,
      contestLinksCleared: 1,
    });
    const [run] = await pruneRows();
    expect(run!.metadata).toMatchObject({
      tables: [{ table: 'workflow_instances', rowsDeleted: 2, contestLinksCleared: 1 }],
    });
  });

  it('prunes the instance of an open contest and protest too: their writers re-create it', async () => {
    await seedVendor('v-s', { claimEndedAt: null });
    await t.db.insert(products).values([
      { id: 'p-x', slug: 'p-x', name: 'p-x' },
      { id: 'p-y', slug: 'p-y', name: 'p-y' },
    ]);
    await t.db
      .insert(integrations)
      .values({ id: 'i-x', sourceProductId: 'p-x', targetProductId: 'p-y' });
    for (const id of ['wf-open-contest', 'wf-declined', 'wf-open-protest']) {
      await seedInstance(id, {
        type: 'correction_request',
        entityId: 'fc',
        transitions: [{ id: `tr-${id}`, createdAt: OLD }],
      });
    }
    await t.db.insert(integrationFieldChallenges).values([
      {
        id: 'fc-open',
        integrationId: 'i-x',
        field: 'name',
        reason: 'Still open',
        submitterVendorId: 'v-s',
        routedTo: 'owner',
        status: 'open',
        workflowId: 'wf-open-contest',
      },
      {
        id: 'fc-protested',
        integrationId: 'i-x',
        field: 'docs_url',
        reason: 'Declined, protest open',
        submitterVendorId: 'v-s',
        routedTo: 'owner',
        status: 'declined',
        workflowId: 'wf-declined',
        protestStatus: 'open',
        protestWorkflowId: 'wf-open-protest',
      },
    ]);

    await runLegalRetentionPrune(t.db, NOW);

    // Kept, they would hold the filer past four years. Every contest writer re-creates the
    // instance instead (`lib/workflow-restore.ts`).
    expect(await instanceIds()).toEqual([]);
    expect(await transitionIds()).toEqual([]);
    const links = await t.db
      .select({
        workflowId: integrationFieldChallenges.workflowId,
        protestWorkflowId: integrationFieldChallenges.protestWorkflowId,
      })
      .from(integrationFieldChallenges);
    expect(links).toEqual([
      { workflowId: null, protestWorkflowId: null },
      { workflowId: null, protestWorkflowId: null },
    ]);
  });

  it('a global hold keeps every workflow row and reports the tables paused', async () => {
    await seedInstance('wf-g', { transitions: [{ id: 'tr-g', createdAt: OLD }] });
    await seedHold('global', null);

    const result = await runLegalRetentionPrune(t.db, NOW);

    expect(result).toMatchObject({ status: 'skipped', reason: 'litigation_hold' });
    expect(result.tables.map((x) => x.table)).toEqual([...LEGAL_PRUNABLE]);
    expect(table(result, 'workflow_instances')).toMatchObject({ paused: true });
    expect(table(result, 'workflow_transitions')).toMatchObject({ paused: true });
    expect(await instanceIds()).toEqual(['wf-g']);
    expect(await transitionIds()).toEqual(['tr-g']);
  });

  it('a vendor hold keeps the held company’s workflows by every tie, and deletes the rest', async () => {
    for (const v of ['v-a', 'v-b']) await seedVendor(v, { claimEndedAt: null });
    for (const [p, v] of [
      ['p-a', 'v-a'],
      ['p-b', 'v-b'],
      ['p-c', null],
    ] as const) {
      await t.db.insert(products).values({ id: p, slug: p, name: p });
      if (v) await t.db.insert(productVendors).values({ productId: p, vendorId: v });
    }
    await t.db
      .insert(profiles)
      .values([
        { id: 'seat-a', vendorId: 'v-a', role: 'vendor_admin' },
        { id: 'seat-b', vendorId: 'v-b', role: 'vendor_admin' },
        { id: 'reader-1' },
      ]);
    await t.db.insert(integrations).values([
      { id: 'i-a', sourceProductId: 'p-c', targetProductId: 'p-a' },
      { id: 'i-b', sourceProductId: 'p-b', targetProductId: 'p-c' },
    ]);
    for (const [id, product] of [
      ['r-a', 'p-a'],
      ['r-b', 'p-b'],
    ] as const) {
      await t.db.insert(reviews).values({
        id,
        productId: product,
        reviewerId: 'reader-1',
        ratingOverall: 4,
        ratingOnboarding: 4,
        title: 'Review',
        body: 'Body',
      });
    }
    await seedClaim('q-a', { status: 'rejected', targetType: 'vendor', targetId: 'v-a' });
    await seedClaim('q-pa', { status: 'rejected', targetType: 'product', targetId: 'p-a' });
    await seedClaim('q-b', { status: 'rejected', targetType: 'vendor', targetId: 'v-b' });
    await t.db.insert(integrationFieldChallenges).values([
      // About A's integration, submitted by B.
      {
        id: 'fc-a',
        integrationId: 'i-a',
        field: 'name',
        reason: 'r',
        submitterVendorId: 'v-b',
        routedTo: 'aeci',
        status: 'declined',
      },
      // Submitted by A about B's integration.
      {
        id: 'fc-sub-a',
        integrationId: 'i-b',
        field: 'name',
        reason: 'r',
        submitterVendorId: 'v-a',
        routedTo: 'aeci',
        status: 'declined',
      },
      {
        id: 'fc-b',
        integrationId: 'i-b',
        field: 'docs_url',
        reason: 'r',
        submitterVendorId: 'v-b',
        routedTo: 'aeci',
        status: 'declined',
      },
    ]);
    const held = [
      ['wf-claim-a', 'vendor_claim', 'q-a'],
      ['wf-claim-pa', 'vendor_claim', 'q-pa'],
      ['wf-contest-a', 'correction_request', 'fc-a'],
      ['wf-contest-sub-a', 'correction_request', 'fc-sub-a'],
      ['wf-review-a', 'review_moderation', 'r-a'],
      ['wf-ban-a', 'reviewer_ban', 'seat-a'],
    ] as const;
    const free = [
      ['wf-claim-b', 'vendor_claim', 'q-b'],
      ['wf-contest-b', 'correction_request', 'fc-b'],
      ['wf-review-b', 'review_moderation', 'r-b'],
      ['wf-ban-b', 'reviewer_ban', 'seat-b'],
      ['wf-ban-reader', 'reviewer_ban', 'reader-1'],
    ] as const;
    for (const [id, type, entityId] of [...held, ...free]) {
      await seedInstance(id, { type, entityId, transitions: [{ id: `tr-${id}`, createdAt: OLD }] });
    }
    // Started by A's seat, and moved by A's seat, about nothing of A's.
    await seedInstance('wf-init-a', { entityId: 'r-b', initiatedBy: 'seat-a' });
    await seedInstance('wf-actor-a', {
      entityId: 'r-b',
      transitions: [{ id: 'tr-actor-a', createdAt: OLD, actorId: 'seat-a' }],
    });
    await seedHold('vendor', 'v-a');

    const result = await runLegalRetentionPrune(t.db, NOW);

    const keptIds = [...held.map(([id]) => id), 'wf-init-a', 'wf-actor-a'].sort();
    expect(await instanceIds()).toEqual(keptIds);
    expect(await transitionIds()).toEqual([...held.map(([id]) => `tr-${id}`), 'tr-actor-a'].sort());
    expect(table(result, 'workflow_instances')).toMatchObject({ rowsDeleted: free.length });
    expect(result).toMatchObject({ status: 'pruned', vendorHolds: 1 });
  });

  it('a transition written after planning on a planned instance aborts the batch; the replan keeps it', async () => {
    await seedInstance('wf-race', { transitions: [{ id: 'tr-race-old', createdAt: OLD }] });
    const batch = t.db.batch.bind(t.db);
    const spy = vi.spyOn(t.db, 'batch').mockImplementationOnce(async (stmts) => {
      await t.db.insert(workflowTransitions).values({
        id: 'tr-race-new',
        workflowId: 'wf-race',
        toState: 'approved',
        createdAt: '2034-06-15T02:59:00.000Z',
      });
      return batch(stmts);
    });

    const error = await runLegalRetentionPrune(t.db, NOW).catch((e: unknown) => e);

    expect(isLegalRetentionRaceError(error)).toBe(true);
    spy.mockRestore();
    expect(await instanceIds()).toEqual(['wf-race']);
    expect(await pruneRows()).toEqual([]);

    // The replan sees the new action: the instance stays, its old transition goes.
    await runLegalRetentionPruneWithReplan(t.db, NOW);
    expect(await instanceIds()).toEqual(['wf-race']);
    expect(await transitionIds()).toEqual(['tr-race-new']);
  });

  it('caps instances per run and reports truncated; the next run continues', async () => {
    for (let i = 0; i <= LEGAL_RETENTION_IDS_PER_TABLE; i += 1) {
      await seedInstance(`wf-${String(i).padStart(3, '0')}`);
    }

    const first = await runLegalRetentionPrune(t.db, NOW);
    expect(table(first, 'workflow_instances')).toMatchObject({
      rowsDeleted: LEGAL_RETENTION_IDS_PER_TABLE,
      truncated: true,
    });
    const second = await runLegalRetentionPrune(t.db, NOW);
    expect(table(second, 'workflow_instances')).toMatchObject({ rowsDeleted: 1, truncated: false });
    expect(await instanceIds()).toEqual([]);
  });
});
