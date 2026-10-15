/**
 * The agreement-acceptance writer (AECI-1362, E2.4 of `docs/VENDOR_SIGNUP_PROCESS.md`
 * §4) on the in-memory D1 harness.
 *
 * The matrix: a current version returns the INSERT plus its `agreement.accepted` audit
 * row and never runs a batch itself; a stale or unknown version, document or source
 * throws `VALIDATION_FAILED` before any statement exists; a claim records IP and a
 * truncated user agent, a checkout records neither; a repeated Stripe session id fails
 * the second batch whole.
 */

import { ApiErrorCode, LEGAL_AGREEMENT_CURRENT_VERSIONS } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agreementAcceptances,
  auditLog,
  billingAccounts,
  profiles,
  vendorRequests,
  vendors,
} from '../db/schema';
import { ApiError } from '../errors';
import { makeTestDb, type TestDb } from '../test/d1';
import type { BatchTuple } from './audit';
import {
  AGREEMENT_ACCEPTANCE_ENTITY_TYPE,
  AGREEMENT_ACCEPTED_ACTION,
  AGREEMENT_LINKED_ACTION,
  USER_AGENT_MAX_LENGTH,
  acceptanceRequestEvidence,
  agreementAcceptanceStatements,
  linkClaimAcceptanceStatements,
  listVendorAcceptances,
  loadClaimAcceptanceIds,
  truncateUserAgent,
  type AgreementAcceptanceParams,
} from './agreement-acceptances';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = u(1);
const OTHER_VENDOR = u(2);
const ACCOUNT = u(10);
const NOW = '2026-10-15T09:00:00.000Z';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'procore', companyName: 'Procore' },
    { id: OTHER_VENDOR, slug: 'bentley', companyName: 'Bentley' },
  ]);
  await t.db.insert(billingAccounts).values({ id: ACCOUNT, vendorId: VENDOR, name: 'Procore' });
});
afterEach(() => t.dispose());

const claimHeaders = (ua = 'Mozilla/5.0 (Macintosh)') =>
  new Headers({ 'cf-connecting-ip': '203.0.113.7', 'user-agent': ua });

const claim = (over: Partial<AgreementAcceptanceParams> = {}): AgreementAcceptanceParams => ({
  document: 'vendor_terms',
  version: LEGAL_AGREEMENT_CURRENT_VERSIONS.vendor_terms,
  source: 'claim',
  email: 'ada@procore.com',
  vendorId: VENDOR,
  acceptedAt: NOW,
  requestHeaders: claimHeaders(),
  actorType: 'user',
  ...over,
});

const checkout = (over: Partial<AgreementAcceptanceParams> = {}): AgreementAcceptanceParams => ({
  document: 'managed_plan',
  version: LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan,
  source: 'checkout',
  email: 'billing@procore.com',
  vendorId: VENDOR,
  billingAccountId: ACCOUNT,
  stripeCheckoutSessionId: 'cs_test_123',
  acceptedAt: NOW,
  actorType: 'system',
  ...over,
});

function expectValidationFailed(fn: () => unknown, field: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).code).toBe(ApiErrorCode.VALIDATION_FAILED);
    expect((error as ApiError).field).toBe(field);
    return;
  }
  throw new Error('expected VALIDATION_FAILED');
}

describe('agreementAcceptanceStatements', () => {
  it('returns the INSERT plus its audit row and never runs a batch itself', async () => {
    const batchSpy = vi.spyOn(t.db, 'batch');
    const out = agreementAcceptanceStatements(t.db, claim());
    expect(out.stmts).toHaveLength(2);
    expect(batchSpy).not.toHaveBeenCalled();
    expect(await t.db.select().from(agreementAcceptances)).toEqual([]);

    await t.db.batch(out.stmts as BatchTuple);
    const [row] = await t.db.select().from(agreementAcceptances);
    expect(row).toMatchObject({
      id: out.acceptanceId,
      document: 'vendor_terms',
      version: '1.0',
      source: 'claim',
      email: 'ada@procore.com',
      profileId: null,
      vendorId: VENDOR,
      billingAccountId: null,
      vendorRequestId: null,
      stripeCheckoutSessionId: null,
      acceptedAt: NOW,
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (Macintosh)',
    });

    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      id: out.auditEntry.id,
      action: AGREEMENT_ACCEPTED_ACTION,
      actorType: 'user',
      actorId: null,
      entityType: AGREEMENT_ACCEPTANCE_ENTITY_TYPE,
      entityId: out.acceptanceId,
      vendorId: VENDOR,
    });
  });

  it('keeps email, IP and user agent out of the forwarded audit entry', () => {
    const { auditEntry } = agreementAcceptanceStatements(t.db, claim());
    const serialized = JSON.stringify(auditEntry);
    expect(serialized).not.toContain('ada@procore.com');
    expect(serialized).not.toContain('203.0.113.7');
    expect(serialized).not.toContain('Mozilla');
    expect(auditEntry.afterState).toMatchObject({ document: 'vendor_terms', version: '1.0' });
  });

  it.each([
    ['a stale version', { version: '0.9' }, 'version'],
    ['an unknown version', { version: '2.0' }, 'version'],
    ['a blank version', { version: '' }, 'version'],
    ['an unknown document', { document: 'privacy_policy' }, 'document'],
    ['an unknown source', { source: 'email' }, 'source'],
    ['a blank email', { email: '   ' }, 'email'],
    ['an unparseable time', { acceptedAt: 'yesterday' }, 'accepted_at'],
  ] as const)('refuses %s with VALIDATION_FAILED', (_label, over, field) => {
    expectValidationFailed(() => agreementAcceptanceStatements(t.db, claim(over)), field);
  });

  it('checks the version against the document it names', () => {
    // Both are '1.0' today. A bump to one must not let the other's version through.
    expect(() => agreementAcceptanceStatements(t.db, checkout())).not.toThrow();
    expectValidationFailed(
      () => agreementAcceptanceStatements(t.db, checkout({ version: '1.1' })),
      'version',
    );
  });

  it('stores no IP or user agent on a checkout, even when headers are passed', async () => {
    const out = agreementAcceptanceStatements(
      t.db,
      checkout({ requestHeaders: claimHeaders('Stripe/1.0') }),
    );
    await t.db.batch(out.stmts as BatchTuple);
    const [row] = await t.db.select().from(agreementAcceptances);
    expect(row).toMatchObject({ ip: null, userAgent: null, billingAccountId: ACCOUNT });
  });

  it('allows the request context to be absent', async () => {
    const out = agreementAcceptanceStatements(t.db, claim({ requestHeaders: undefined }));
    await t.db.batch(out.stmts as BatchTuple);
    const [row] = await t.db.select().from(agreementAcceptances);
    expect(row).toMatchObject({ ip: null, userAgent: null });
  });

  it('truncates a long user agent to 512 characters', async () => {
    const out = agreementAcceptanceStatements(
      t.db,
      claim({ requestHeaders: claimHeaders('x'.repeat(2000)) }),
    );
    await t.db.batch(out.stmts as BatchTuple);
    const [row] = await t.db.select().from(agreementAcceptances);
    expect(row!.userAgent).toHaveLength(USER_AGENT_MAX_LENGTH);
  });

  it('fails the whole batch on a repeated Stripe session id rather than writing twice', async () => {
    const first = agreementAcceptanceStatements(t.db, checkout());
    await t.db.batch(first.stmts as BatchTuple);
    const replay = agreementAcceptanceStatements(t.db, checkout());
    await expect(t.db.batch(replay.stmts as BatchTuple)).rejects.toThrow(/UNIQUE/);

    expect(await t.db.select().from(agreementAcceptances)).toHaveLength(1);
    // The replay's audit row rolled back with it.
    expect(
      await t.db.select().from(auditLog).where(eq(auditLog.entityId, replay.acceptanceId)),
    ).toEqual([]);
  });

  it('lets many acceptances carry no Stripe session id', async () => {
    for (let i = 0; i < 2; i++) {
      const out = agreementAcceptanceStatements(t.db, claim());
      await t.db.batch(out.stmts as BatchTuple);
    }
    expect(await t.db.select().from(agreementAcceptances)).toHaveLength(2);
  });
});

describe('listVendorAcceptances', () => {
  it('finds rows by vendor id or by the vendor’s billing account, newest first', async () => {
    const byVendor = agreementAcceptanceStatements(
      t.db,
      claim({ acceptedAt: '2026-10-01T00:00:00.000Z' }),
    );
    const byAccountOnly = agreementAcceptanceStatements(t.db, checkout({ vendorId: null }));
    const foreign = agreementAcceptanceStatements(t.db, claim({ vendorId: OTHER_VENDOR }));
    await t.db.batch([...byVendor.stmts, ...byAccountOnly.stmts, ...foreign.stmts] as BatchTuple);

    const rows = await listVendorAcceptances(t.db, VENDOR);
    expect(rows.map((r) => r.id)).toEqual([byAccountOnly.acceptanceId, byVendor.acceptanceId]);
    expect((await listVendorAcceptances(t.db, OTHER_VENDOR)).map((r) => r.id)).toEqual([
      foreign.acceptanceId,
    ]);
  });
});

describe('request evidence helpers', () => {
  it('reads CF-Connecting-IP and the user agent', () => {
    expect(acceptanceRequestEvidence(claimHeaders())).toEqual({
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (Macintosh)',
    });
    expect(acceptanceRequestEvidence(null)).toEqual({ ip: null, userAgent: null });
    expect(acceptanceRequestEvidence(new Headers())).toEqual({ ip: null, userAgent: null });
  });

  it('maps a blank user agent to null', () => {
    expect(truncateUserAgent('   ')).toBeNull();
    expect(truncateUserAgent(undefined)).toBeNull();
    expect(truncateUserAgent(' curl/8 ')).toBe('curl/8');
  });
});

// ─── AECI-1367: the approval links the claim's acceptances ───────────────────

describe('linkClaimAcceptanceStatements', () => {
  const CLAIM = u(20);
  const OTHER_CLAIM = u(21);
  const SEAT = u(30);
  const ADMIN = u(31);

  beforeEach(async () => {
    // `audit_log.actor_id` references `profiles`.
    await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
    await t.db.insert(vendorRequests).values(
      [CLAIM, OTHER_CLAIM].map((id) => ({
        id,
        kind: 'claim',
        status: 'open',
        targetType: 'vendor',
        targetId: VENDOR,
        submitterEmail: 'ada@procore.com',
        body: 'We build this.',
      })),
    );
  });

  const linkArgs = (acceptanceIds: readonly string[]) => ({
    vendorRequestId: CLAIM,
    acceptanceIds,
    profileId: SEAT,
    vendorId: VENDOR,
    billingAccountId: ACCOUNT,
    actorId: ADMIN,
    actorType: 'admin' as const,
    vendorPlan: { tier: 'none', status: 'none' as const },
    source: 'admin-moderation',
  });

  /** A claim-time acceptance: the email and the claim, nothing else. */
  async function acceptOn(vendorRequestId: string): Promise<string> {
    const batch = agreementAcceptanceStatements(t.db, claim({ vendorId: null, vendorRequestId }));
    await t.db.batch(batch.stmts as BatchTuple);
    return batch.acceptanceId;
  }

  it('loads the claim’s acceptance ids and nothing else', async () => {
    const mine = await acceptOn(CLAIM);
    await acceptOn(OTHER_CLAIM);
    expect(await loadClaimAcceptanceIds(t.db, CLAIM)).toEqual([mine]);
    expect(await loadClaimAcceptanceIds(t.db, u(99))).toEqual([]);
  });

  it('is a no-op with no statement and no audit row when the claim has no acceptances', () => {
    const link = linkClaimAcceptanceStatements(t.db, linkArgs([]));
    expect(link.stmts).toEqual([]);
    expect(link.auditEntry).toBeNull();
  });

  it('fills profile, vendor and billing account on this claim’s rows only, with one audit row', async () => {
    const mine = await acceptOn(CLAIM);
    const theirs = await acceptOn(OTHER_CLAIM);

    const link = linkClaimAcceptanceStatements(t.db, linkArgs([mine]));
    expect(link.stmts).toHaveLength(2);
    await t.db.batch(link.stmts as BatchTuple);

    const rows = await t.db.select().from(agreementAcceptances);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(mine)).toMatchObject({
      profileId: SEAT,
      vendorId: VENDOR,
      billingAccountId: ACCOUNT,
      // The evidence is untouched.
      email: 'ada@procore.com',
      ip: '203.0.113.7',
    });
    expect(byId.get(theirs)).toMatchObject({
      profileId: null,
      vendorId: null,
      billingAccountId: null,
    });

    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, AGREEMENT_LINKED_ACTION));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityType: 'vendor_request',
      entityId: CLAIM,
      vendorId: VENDOR,
    });
    expect(link.auditEntry!.afterState).toMatchObject({
      acceptance_ids: [mine],
      profile_id: SEAT,
      billing_account_id: ACCOUNT,
    });
  });
});
