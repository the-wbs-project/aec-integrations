/**
 * Unit tests for the claim-ticket staleness check (AECI-862 / Phase 6 §6.2),
 * against the in-memory D1 harness. Real `vendor_requests` / `products` /
 * `vendors` rows are seeded so the eligibility query runs over real SQL; the
 * Linear read (`fetchLinearIssueStates`) and the digest email
 * (`sendStaleClaimTicketAlert`) are injected so the tests drive verdicts without a
 * transport.
 *
 * The behaviours worth protecting are the ones that decide whether this channel is
 * trusted or ignored:
 *
 *   - A ticket someone HAS started is never warned about, even while the local row
 *     still says `open` — that is the whole reason it reads Linear.
 *   - A failed Linear read sends NOTHING. Silence beats a false alarm.
 *   - An issue Linear does not return is "cannot tell", not "stale".
 *   - The email is band-throttled; the metric and the log are not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeExecutionContext, TEST_ENV } from '../test/helpers';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitGauge: vi.fn(),
  submitDistribution: vi.fn(),
}));

import { products, vendorRequests, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { logToPosthog, submitCount, submitGauge } from '../posthog';
import {
  runClaimStaleCheck,
  STALE_BATCH_CAP,
  STALE_CHECK_INTERVAL_MINUTES,
  STALE_THRESHOLD_HOURS,
} from './claim-stale-check';
import { CLAIM_STALE_CRON } from './cron-schedules';
import type { LinearIssueSnapshot } from './linear';

const NOW = new Date('2026-09-11T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  vi.clearAllMocks();
});
afterEach(() => t.dispose());

function makeCtx(over: Record<string, unknown> = {}) {
  return {
    env: {
      ...TEST_ENV,
      PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
      FOUNDER_ALERT_EMAIL: 'founders@thewbsproject.com',
      ...over,
    },
    executionCtx: fakeExecutionContext(),
    req: { raw: new Request('https://api.test/cron/claim-stale-check') },
  };
}

async function seedClaim(over: Partial<typeof vendorRequests.$inferInsert> & { id: string }) {
  await t.db.insert(vendorRequests).values({
    kind: 'claim',
    targetType: 'product',
    targetId: 'tgt-1',
    submitterEmail: 'vendor@example.com',
    domainMatch: 'match',
    body: 'We own this listing.',
    status: 'open',
    linearIssueId: `iss-${over.id}`,
    linearIssueUrl: `https://linear.app/aec/issue/AECI-1/${over.id}`,
    // Comfortably past the 24h threshold, and past the 24h alert band.
    createdAt: hoursAgo(25),
    ...over,
  });
}

function snapshot(id: string, stateType: string, stateName: string): LinearIssueSnapshot {
  return {
    id,
    identifier: 'AECI-900',
    url: `https://linear.app/aec/issue/AECI-900/${id}`,
    title: 'Claim: Procore (product)',
    stateType,
    stateName,
  };
}

/** A Linear read that reports each seeded issue in the given state category. */
function statesFor(entries: Array<[string, string, string]>) {
  const issues = new Map(entries.map(([id, type, name]) => [id, snapshot(id, type, name)]));
  return vi.fn(async () => ({ ok: true as const, issues }));
}

describe('runClaimStaleCheck', () => {
  it('warns about a claim ticket still sitting in Backlog after 24h', async () => {
    await t.db.insert(products).values({ id: 'tgt-1', slug: 'procore', name: 'Procore' });
    await seedClaim({ id: 'req-1' });
    const sendAlert = vi.fn(async () => 'sent' as const);

    const result = await runClaimStaleCheck(makeCtx(), t.db, {
      fetchStates: statesFor([['iss-req-1', 'backlog', 'Backlog']]) as never,
      sendAlert: sendAlert as never,
      now: NOW,
    });

    expect(result).toMatchObject({ checked: 1, stale: 1, drifted: 0, alerted: true });
    expect(sendAlert).toHaveBeenCalledOnce();
    const [, payload] = sendAlert.mock.calls[0] as unknown as [
      unknown,
      { to: string; rows: unknown[] },
    ];
    expect(payload.to).toBe('founders@thewbsproject.com');
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]).toMatchObject({
      requestId: 'req-1',
      identifier: 'AECI-900',
      stateName: 'Backlog',
      targetName: 'Procore',
      adminUrl: 'https://www.aecintegrations.com/admin/claims/req-1',
    });
  });

  it.each([
    ['started', 'In Progress'],
    ['completed', 'Done'],
    ['canceled', 'Canceled'],
  ])('never warns about a ticket in a %s state', async (stateType, stateName) => {
    // The reason this job reads Linear at all. The local row still says `open`
    // because the §6.3 webhook may not be delivering; Linear is the truth.
    await t.db.insert(products).values({ id: 'tgt-1', slug: 'procore', name: 'Procore' });
    await seedClaim({ id: 'req-1' });
    const sendAlert = vi.fn(async () => 'sent' as const);

    const result = await runClaimStaleCheck(makeCtx(), t.db, {
      fetchStates: statesFor([['iss-req-1', stateType, stateName]]) as never,
      sendAlert: sendAlert as never,
      now: NOW,
    });

    expect(result.stale).toBe(0);
    expect(result.drifted).toBe(1);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('counts and logs webhook drift when Linear has moved on but the row has not', async () => {
    await t.db.insert(products).values({ id: 'tgt-1', slug: 'procore', name: 'Procore' });
    await seedClaim({ id: 'req-1' });

    const result = await runClaimStaleCheck(makeCtx(), t.db, {
      fetchStates: statesFor([['iss-req-1', 'started', 'In Progress']]) as never,
      sendAlert: vi.fn(async () => 'sent' as const) as never,
      now: NOW,
    });

    expect(result.drifted).toBe(1);
    expect(submitCount).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'aeci.linear.claim_stale.webhook_drift',
      1,
      [],
    );
    const messages = vi.mocked(logToPosthog).mock.calls.map((c) => String(c[3]?.message ?? ''));
    expect(messages.some((m) => m.includes('webhook_drift'))).toBe(true);
  });

  it('sends nothing when the Linear read fails, and reports the reason', async () => {
    // A board we could not read is not evidence that anybody is ignoring anything.
    await t.db.insert(products).values({ id: 'tgt-1', slug: 'procore', name: 'Procore' });
    await seedClaim({ id: 'req-1' });
    const sendAlert = vi.fn(async () => 'sent' as const);

    const result = await runClaimStaleCheck(makeCtx(), t.db, {
      fetchStates: vi.fn(async () => ({ ok: false as const, reason: 'http_error' })) as never,
      sendAlert: sendAlert as never,
      now: NOW,
    });

    expect(result).toMatchObject({
      checked: 1,
      stale: 0,
      alerted: false,
      failedReason: 'http_error',
    });
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('treats an issue Linear did not return as "cannot tell", not stale', async () => {
    await t.db.insert(products).values({ id: 'tgt-1', slug: 'procore', name: 'Procore' });
    await seedClaim({ id: 'req-1' });
    const sendAlert = vi.fn(async () => 'sent' as const);

    const result = await runClaimStaleCheck(makeCtx(), t.db, {
      fetchStates: statesFor([]) as never, // empty map: issue absent
      sendAlert: sendAlert as never,
      now: NOW,
    });

    expect(result).toMatchObject({ checked: 1, stale: 0, alerted: false });
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('ignores claims younger than the threshold, and rows with no Linear issue', async () => {
    await t.db.insert(products).values({ id: 'tgt-1', slug: 'procore', name: 'Procore' });
    await seedClaim({ id: 'young', createdAt: hoursAgo(STALE_THRESHOLD_HOURS - 1) });
    await seedClaim({ id: 'unlinked', linearIssueId: null, linearIssueUrl: null });
    // The unlinked one belongs to the §6.7 reconciliation sweep, not here. The two
    // jobs must not both claim the same row.
    await seedClaim({ id: 'resolved', status: 'resolved' });
    const fetchStates = statesFor([]);

    const result = await runClaimStaleCheck(makeCtx(), t.db, {
      fetchStates: fetchStates as never,
      sendAlert: vi.fn(async () => 'sent' as const) as never,
      now: NOW,
    });

    expect(result.checked).toBe(0);
    expect(fetchStates).not.toHaveBeenCalled();
  });

  it('ignores corrections, because NOTIFIED_REQUEST_KINDS is claims only', async () => {
    await t.db.insert(products).values({ id: 'tgt-1', slug: 'procore', name: 'Procore' });
    await seedClaim({ id: 'req-1', kind: 'correction' });

    const result = await runClaimStaleCheck(makeCtx(), t.db, {
      fetchStates: statesFor([['iss-req-1', 'backlog', 'Backlog']]) as never,
      sendAlert: vi.fn(async () => 'sent' as const) as never,
      now: NOW,
    });

    expect(result.checked).toBe(0);
  });

  it('suppresses the email between bands but still logs and meters', async () => {
    // 30h old: past the 24h band, but the run covering it is not a band crossing.
    await t.db.insert(products).values({ id: 'tgt-1', slug: 'procore', name: 'Procore' });
    await seedClaim({ id: 'req-1', createdAt: hoursAgo(30) });
    const sendAlert = vi.fn(async () => 'sent' as const);

    const result = await runClaimStaleCheck(makeCtx(), t.db, {
      fetchStates: statesFor([['iss-req-1', 'backlog', 'Backlog']]) as never,
      sendAlert: sendAlert as never,
      now: NOW,
    });

    expect(result.stale).toBe(1);
    expect(result.alerted).toBe(false);
    expect(sendAlert).not.toHaveBeenCalled();
    // The metric is the record, not the email — it must fire regardless.
    expect(submitGauge).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'aeci.linear.claim_stale.stale',
      1,
      [],
    );
  });

  it('resolves a vendor target by company_name', async () => {
    await t.db.insert(vendors).values({ id: 'v-1', slug: 'acme', companyName: 'Acme Build' });
    await seedClaim({ id: 'req-1', targetType: 'vendor', targetId: 'v-1' });
    const sendAlert = vi.fn(async () => 'sent' as const);

    await runClaimStaleCheck(makeCtx(), t.db, {
      fetchStates: statesFor([['iss-req-1', 'backlog', 'Backlog']]) as never,
      sendAlert: sendAlert as never,
      now: NOW,
    });

    const [, payload] = sendAlert.mock.calls[0] as unknown as [
      unknown,
      { rows: Array<{ targetName: string }> },
    ];
    expect(payload.rows[0]?.targetName).toBe('Acme Build');
  });

  it('emits a zero gauge on a clean run so absence is distinguishable from silence', async () => {
    const result = await runClaimStaleCheck(makeCtx(), t.db, {
      fetchStates: statesFor([]) as never,
      sendAlert: vi.fn(async () => 'sent' as const) as never,
      now: NOW,
    });

    expect(result).toMatchObject({ checked: 0, stale: 0, alerted: false });
    expect(submitGauge).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'aeci.linear.claim_stale.checked',
      0,
      [],
    );
  });

  it('skips the send when FOUNDER_ALERT_EMAIL is unset, without throwing', async () => {
    await t.db.insert(products).values({ id: 'tgt-1', slug: 'procore', name: 'Procore' });
    await seedClaim({ id: 'req-1' });
    const sendAlert = vi.fn(async () => 'skipped' as const);

    const result = await runClaimStaleCheck(makeCtx({ FOUNDER_ALERT_EMAIL: undefined }), t.db, {
      fetchStates: statesFor([['iss-req-1', 'backlog', 'Backlog']]) as never,
      sendAlert: sendAlert as never,
      now: NOW,
    });

    // The seam is still invoked; `lib/email.ts` is what turns an absent recipient
    // into `'skipped'`, so the job stays fail-open either way.
    expect(result.alerted).toBe(true);
    const [, payload] = sendAlert.mock.calls[0] as unknown as [unknown, { to: string | undefined }];
    expect(payload.to).toBeUndefined();
  });
});

describe('cadence lockstep', () => {
  it('STALE_CHECK_INTERVAL_MINUTES matches CLAIM_STALE_CRON', () => {
    // The email throttle is computed from this constant. If the cron moves and the
    // constant does not, the bands silently double-send or skip — with nothing
    // failing. This test is the only thing that catches it.
    const [minute, hour] = CLAIM_STALE_CRON.split(' ');
    expect(minute).toBe('25');
    expect(hour).toBe('*/6');
    expect(STALE_CHECK_INTERVAL_MINUTES).toBe(6 * 60);
  });

  it('keeps the batch cap inside the batched Linear query ceiling', () => {
    // `ISSUE_STATES_QUERY` asks for `first: 250`. A cap above that would silently
    // truncate the read.
    expect(STALE_BATCH_CAP).toBeLessThanOrEqual(250);
  });
});
