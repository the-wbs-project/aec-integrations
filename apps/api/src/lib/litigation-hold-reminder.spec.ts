/**
 * The reminder for a litigation hold left open too long (AECI-1638). Time travel goes
 * through `now`. The 30-day memory is the send ledger, so earlier sends are seeded as
 * `notification_sends` rows. The last test drives the real transport against the ledger.
 */

import {
  LITIGATION_HOLD_REMINDER_AFTER_DAYS,
  LITIGATION_HOLD_REMINDER_EVERY_DAYS,
} from '@aeci/shared';
import type { Context } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/client';
import { litigationHolds, notificationSends, vendors } from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import type { EmailContext } from './email';
import {
  findDueHoldReminders,
  litigationHoldReminderKey,
  runLitigationHoldReminders,
  type SendHoldReminder,
} from './litigation-hold-reminder';
import { ledgerDb } from './notifications/send-ledger';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

vi.mock('./notifications/send-ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./notifications/send-ledger')>();
  return { ...actual, ledgerDb: vi.fn(() => null) };
});

const DAY = 86_400_000;
const NOW = new Date();
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY).toISOString();

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  vi.mocked(ledgerDb).mockReturnValue(t.db as Db);
  await t.db.insert(vendors).values({ id: 'v-1', slug: 'acme', companyName: 'Acme' });
});
afterEach(() => {
  vi.restoreAllMocks();
  t.dispose();
});

function ctx(env: Partial<Env> = {}): EmailContext {
  return {
    env: {
      ENV: 'production',
      SUPPORT_EMAIL: 'support@aecintegrations.com',
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
      ...env,
    } as Env,
    executionCtx: { waitUntil: () => {}, passThroughOnException: () => {} },
    req: { raw: new Request('https://aeci-api/cron/legal-retention-prune') },
  } as unknown as Context<{ Bindings: Env }>;
}

async function hold(id: string, placedDaysAgo: number, released = false, vendorId = 'v-1') {
  await t.db.insert(litigationHolds).values({
    id,
    scope: 'vendor',
    vendorId,
    reason: 'Demand letter',
    matterReference: 'AECI-9999',
    placedBy: 'admin-1',
    placedAt: daysAgo(placedDaysAgo),
    releasedAt: released ? daysAgo(1) : null,
    releasedBy: released ? 'admin-1' : null,
    releaseReason: released ? 'Settled' : null,
  });
}

/** A reminder sent `daysAgo` days ago, as the ledger records it. */
async function sentReminder(holdId: string, ago: number, outcome = 'sent') {
  await t.db.insert(notificationSends).values({
    notificationId: 'litigation-hold-reminder',
    recipientHash: 'h',
    tier: 'production',
    outcome: outcome as never,
    dedupeKey: `litigation-hold-reminder:${holdId}:${daysAgo(ago).slice(0, 10)}`,
    entityType: 'litigation_hold',
    entityId: holdId,
    createdAt: daysAgo(ago),
  });
}

function fakeSend() {
  return vi.fn<SendHoldReminder>(async () => 'sent');
}

describe('the thresholds', () => {
  it('are 90 days open and 30 days between reminders', () => {
    expect(LITIGATION_HOLD_REMINDER_AFTER_DAYS).toBe(90);
    expect(LITIGATION_HOLD_REMINDER_EVERY_DAYS).toBe(30);
  });
});

describe('runLitigationHoldReminders', () => {
  it('sends no reminder for a hold open 89 days', async () => {
    await hold('h-89', 89);
    const send = fakeSend();
    const report = await runLitigationHoldReminders(ctx(), t.db, NOW, { send });
    expect(send).not.toHaveBeenCalled();
    expect(report).toEqual({ due: 0, outcomes: {} });
  });

  it('sends one reminder for a hold open 91 days, naming scope, vendor, reason, matter and age', async () => {
    await hold('h-91', 91);
    const send = fakeSend();
    const report = await runLitigationHoldReminders(ctx(), t.db, NOW, { send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toEqual({
      to: 'support@aecintegrations.com',
      holdId: 'h-91',
      scope: 'vendor',
      vendorId: 'v-1',
      vendorName: 'Acme',
      reason: 'Demand letter',
      matterReference: 'AECI-9999',
      placedAt: daysAgo(91),
      ageDays: 91,
      dedupeKey: litigationHoldReminderKey('h-91', NOW),
    });
    expect(report).toEqual({ due: 1, outcomes: { sent: 1 } });
  });

  it('sends no second reminder within 30 days', async () => {
    await hold('h-1', 110);
    await sentReminder('h-1', 20);
    const send = fakeSend();
    await runLitigationHoldReminders(ctx(), t.db, NOW, { send });
    expect(send).not.toHaveBeenCalled();
  });

  it('counts an unknown send as sent, and retries after a failed one', async () => {
    await hold('h-unknown', 110);
    await hold('h-failed', 110, false, 'v-2');
    await sentReminder('h-unknown', 5, 'unknown');
    await sentReminder('h-failed', 5, 'failed');
    const send = fakeSend();
    await runLitigationHoldReminders(ctx(), t.db, NOW, { send });
    expect(send.mock.calls.map((call) => call[1].holdId)).toEqual(['h-failed']);
  });

  it('sends again once the last reminder is more than 30 days old', async () => {
    await hold('h-1', 130);
    await sentReminder('h-1', 31);
    const send = fakeSend();
    await runLitigationHoldReminders(ctx(), t.db, NOW, { send });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends nothing for a released hold, however old', async () => {
    await hold('h-released', 400, true);
    const send = fakeSend();
    expect(await findDueHoldReminders(t.db, NOW)).toEqual([]);
    await runLitigationHoldReminders(ctx(), t.db, NOW, { send });
    expect(send).not.toHaveBeenCalled();
  });

  it('never throws: a throwing send is counted as failed', async () => {
    await hold('h-1', 100);
    const send = vi.fn<SendHoldReminder>(async () => {
      throw new Error('resend down');
    });
    await expect(runLitigationHoldReminders(ctx(), t.db, NOW, { send })).resolves.toEqual({
      due: 1,
      outcomes: { failed: 1 },
    });
  });

  it('through the real transport, the ledger stops a second reminder the same day', async () => {
    await hold('h-real', 95);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ id: 'msg_1' })));

    const first = await runLitigationHoldReminders(ctx(), t.db, NOW);
    const second = await runLitigationHoldReminders(ctx(), t.db, NOW);

    expect(first).toEqual({ due: 1, outcomes: { sent: 1 } });
    expect(second).toEqual({ due: 0, outcomes: {} });
    const resendCalls = fetchSpy.mock.calls.filter((call) =>
      String(call[0]).includes('api.resend.com'),
    );
    expect(resendCalls).toHaveLength(1);
    const body = JSON.parse(String((resendCalls[0]![1] as RequestInit).body)) as {
      to: string[];
      subject: string;
      text: string;
    };
    expect(body.subject).toBe('[AECi] Litigation hold open for 95 days');
    expect(body.text).toContain('Vendor: Acme');
    expect(body.text).toContain('AECI-9999');
  });

  it('is suppressed off production, and that does not count as a reminder', async () => {
    await hold('h-staging', 95);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const report = await runLitigationHoldReminders(ctx({ ENV: 'staging' }), t.db, NOW);
    expect(report.outcomes).toEqual({ suppressed: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await findDueHoldReminders(t.db, NOW)).toHaveLength(1);
  });
});
