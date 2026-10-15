/**
 * The claim owner fallback (AECI-1368 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §11a.10),
 * against the in-memory D1 harness. Real `vendor_requests` rows are seeded so the
 * eligibility read and the guarded UPDATE run over real SQL. The digest is injected.
 *
 * What it must hold:
 *   - A routed claim undecided for 7 days moves to AECi, with an audit row per claim
 *     in the same batch, and ONE digest naming it.
 *   - A second run is a no-op: nothing read, nothing written, nothing sent.
 *   - A claim inside the window, a decided claim and an unrouted claim are left alone.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeExecutionContext, TEST_ENV } from '../test/helpers';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitGauge: vi.fn(),
  submitDistribution: vi.fn(),
}));

import { auditLog, vendorRequests, vendors } from '../db/schema';
import { logBatchToPosthog } from '../posthog';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  OWNER_FALLBACK_ACTION,
  OWNER_REVIEW_DAYS,
  ownerFallbackDigestKey,
  ownerReviewDeadline,
  runClaimOwnerFallback,
} from './claim-owner-fallback';

const NOW = new Date('2026-10-20T14:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const VENDOR_ID = '11111111-1111-4111-8111-111111111111';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  vi.clearAllMocks();
  await t.db.insert(vendors).values({ id: VENDOR_ID, slug: 'acme', companyName: 'Acme' });
});
afterEach(() => t.dispose());

function makeCtx() {
  return {
    env: {
      ...TEST_ENV,
      PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
      SUPPORT_EMAIL: 'support@aecintegrations.com',
    },
    executionCtx: fakeExecutionContext(),
    req: { raw: new Request('https://api.test/cron/claim-owner-fallback') },
  };
}

async function seedClaim(over: Partial<typeof vendorRequests.$inferInsert> & { id: string }) {
  await t.db.insert(vendorRequests).values({
    kind: 'claim',
    targetType: 'vendor',
    targetId: VENDOR_ID,
    submitterEmail: 'claimant@acme.example',
    submitterName: 'Casey',
    domainMatch: 'match',
    body: 'I run product at Acme.',
    status: 'open',
    createdAt: daysAgo(8),
    routedToOwnersAt: daysAgo(8),
    ...over,
  });
}

const row = (id: string) =>
  t.db.query.vendorRequests.findFirst({ where: eq(vendorRequests.id, id) });

describe('runClaimOwnerFallback', () => {
  it('moves a routed claim undecided for 7 days to AECi, audits it and sends one digest', async () => {
    await seedClaim({ id: 'req-1' });
    const sendAlert = vi.fn(async () => 'sent' as const);

    const result = await runClaimOwnerFallback(makeCtx(), t.db, {
      sendAlert: sendAlert as never,
      now: NOW,
    });

    expect(result).toEqual({ moved: 1, capped: 0, alert: 'sent' });
    const after = await row('req-1');
    expect(after).toMatchObject({
      status: 'open',
      routedToOwnersAt: null,
      ownerFallbackAt: NOW.toISOString(),
    });
    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: 'system',
      actorId: null,
      action: OWNER_FALLBACK_ACTION,
      entityType: 'vendor_request',
      entityId: 'req-1',
    });

    expect(sendAlert).toHaveBeenCalledOnce();
    const [, payload] = sendAlert.mock.calls[0] as unknown as [
      unknown,
      { to: string; rows: Array<{ requestId: string; vendorName: string }>; dedupeKey: string },
    ];
    expect(payload.to).toBe('support@aecintegrations.com');
    expect(payload.rows).toEqual([
      expect.objectContaining({
        requestId: 'req-1',
        vendorName: 'Acme',
        adminUrl: 'https://www.aecintegrations.com/admin/claims/req-1',
      }),
    ]);
    expect(payload.dedupeKey).toBe('claim-owner-fallback-alert:req-1');
  });

  it('audits, forwards and lists only the claims this run moved, when an owner decides one mid-run (AECI-1333)', async () => {
    await seedClaim({ id: 'req-1' });
    await seedClaim({ id: 'req-2' });
    const sendAlert = vi.fn(async () => 'sent' as const);
    // The owner accepts req-2 after the eligibility read and before the batch.
    const batch = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: Parameters<typeof batch>[0]) => {
      await t.db
        .update(vendorRequests)
        .set({ status: 'resolved' })
        .where(eq(vendorRequests.id, 'req-2'));
      return batch(stmts);
    }) as unknown as typeof batch);

    const result = await runClaimOwnerFallback(makeCtx(), t.db, {
      sendAlert: sendAlert as never,
      now: NOW,
    });

    expect(result).toEqual({ moved: 1, capped: 0, alert: 'sent' });
    expect((await row('req-2'))?.ownerFallbackAt).toBeNull();
    const audits = await t.db.select().from(auditLog);
    expect(audits.map((a) => a.entityId)).toEqual(['req-1']);
    // The INSERT … SELECT writes the same row shape `auditInsert` does.
    expect(audits[0]).toMatchObject({
      action: OWNER_FALLBACK_ACTION,
      vendorId: VENDOR_ID,
      afterState: { routed_to_owners_at: null, owner_fallback_at: NOW.toISOString() },
      metadata: expect.objectContaining({ status_unchanged: true }),
    });
    const [, payload] = sendAlert.mock.calls[0] as unknown as [
      unknown,
      { rows: Array<{ requestId: string }>; dedupeKey: string },
    ];
    expect(payload.rows.map((r) => r.requestId)).toEqual(['req-1']);
    expect(payload.dedupeKey).toBe('claim-owner-fallback-alert:req-1');
    const forwarded = vi
      .mocked(logBatchToPosthog)
      .mock.calls.flatMap((call) => call[3] as Array<{ message: string }>)
      .map((e) => e.message);
    expect(forwarded).toEqual([`audit ${OWNER_FALLBACK_ACTION} req-1`]);
  });

  it('sends nothing when every claim it read was decided before the batch (AECI-1333)', async () => {
    await seedClaim({ id: 'req-1' });
    const sendAlert = vi.fn(async () => 'sent' as const);
    const batch = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: Parameters<typeof batch>[0]) => {
      await t.db
        .update(vendorRequests)
        .set({ status: 'rejected' })
        .where(eq(vendorRequests.id, 'req-1'));
      return batch(stmts);
    }) as unknown as typeof batch);

    const result = await runClaimOwnerFallback(makeCtx(), t.db, {
      sendAlert: sendAlert as never,
      now: NOW,
    });

    expect(result).toEqual({ moved: 0, capped: 0, alert: null });
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('is a no-op on a second run', async () => {
    await seedClaim({ id: 'req-1' });
    const sendAlert = vi.fn(async () => 'sent' as const);
    await runClaimOwnerFallback(makeCtx(), t.db, { sendAlert: sendAlert as never, now: NOW });

    const second = await runClaimOwnerFallback(makeCtx(), t.db, {
      sendAlert: sendAlert as never,
      now: new Date(NOW.getTime() + 86_400_000),
    });

    expect(second).toEqual({ moved: 0, capped: 0, alert: null });
    expect(sendAlert).toHaveBeenCalledOnce();
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
  });

  it('leaves a claim still inside the 7-day window with the owners', async () => {
    await seedClaim({ id: 'req-1', routedToOwnersAt: daysAgo(OWNER_REVIEW_DAYS - 1) });
    const sendAlert = vi.fn(async () => 'sent' as const);

    const result = await runClaimOwnerFallback(makeCtx(), t.db, {
      sendAlert: sendAlert as never,
      now: NOW,
    });

    expect(result.moved).toBe(0);
    expect((await row('req-1'))?.routedToOwnersAt).not.toBeNull();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('ignores a decided claim and a claim that was never routed', async () => {
    await seedClaim({ id: 'req-decided', status: 'resolved' });
    await seedClaim({ id: 'req-unrouted', routedToOwnersAt: null });
    const sendAlert = vi.fn(async () => 'sent' as const);

    const result = await runClaimOwnerFallback(makeCtx(), t.db, {
      sendAlert: sendAlert as never,
      now: NOW,
    });

    expect(result.moved).toBe(0);
    expect((await row('req-decided'))?.ownerFallbackAt).toBeNull();
    expect((await row('req-unrouted'))?.ownerFallbackAt).toBeNull();
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('names every moved claim in one digest, keyed in id order', async () => {
    await seedClaim({ id: 'req-b' });
    await seedClaim({ id: 'req-a', routedToOwnersAt: daysAgo(9) });
    const sendAlert = vi.fn(async () => 'sent' as const);

    const result = await runClaimOwnerFallback(makeCtx(), t.db, {
      sendAlert: sendAlert as never,
      now: NOW,
    });

    expect(result.moved).toBe(2);
    expect(sendAlert).toHaveBeenCalledOnce();
    const [, payload] = sendAlert.mock.calls[0] as unknown as [unknown, { dedupeKey: string }];
    expect(payload.dedupeKey).toBe(ownerFallbackDigestKey(['req-b', 'req-a']));
    expect(payload.dedupeKey).toBe('claim-owner-fallback-alert:req-a,req-b');
    expect(await t.db.select().from(auditLog)).toHaveLength(2);
  });
});

describe('ownerReviewDeadline', () => {
  it('is the routing instant plus 7 days', () => {
    expect(ownerReviewDeadline('2026-10-01T10:00:00.000Z')).toBe('2026-10-08T10:00:00.000Z');
  });
});
