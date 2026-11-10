/**
 * The license-grant sweep (AECI-1615), against the in-memory D1 harness. Real
 * `license_grants`, `audit_log` and `notification_sends` rows; the senders are fakes that
 * keep the ledger's dedupe rule.
 *
 * What it must hold, each exactly once across the daily runs:
 *   - expire: a pending grant past its end becomes `expired`, with one audit row;
 *   - catch-up: an owner seat with no `license-grant-pending` send yet gets one;
 *   - reminder: a grant still pending 7 days after it was made reminds each owner once.
 * Nothing is sent to a member seat, nor about a grant that is not pending.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeExecutionContext, TEST_ENV } from '../test/helpers';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
}));

import { auditLog, licenseGrants, notificationSends, profiles, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { seedBillingAccount } from '../test/licenses';
import type { EmailOutcome } from './email';
import { runLicenseGrantSweep } from './license-grant-sweep';
import { licenseGrantPendingKey, licenseGrantReminderKey } from './license-grants';

const VENDOR = '11111111-1111-4111-8111-111111111111';
const OWNER = '00000000-0000-4000-8000-000000000100';
const MEMBER = '00000000-0000-4000-8000-000000000101';
const G_PAST = '22222222-2222-4222-8222-000000000001';
const G_YOUNG = '22222222-2222-4222-8222-000000000002';
const G_OLD = '22222222-2222-4222-8222-000000000003';
const NOW = new Date('2026-11-20T11:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

let t: TestDb;
let accountId: string;
beforeEach(async () => {
  t = await makeTestDb();
  vi.clearAllMocks();
  await t.db.insert(vendors).values({ id: VENDOR, slug: 'acme', companyName: 'Acme' });
  await t.db.insert(profiles).values([
    { id: OWNER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
    { id: MEMBER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: false },
  ]);
  accountId = await seedBillingAccount(t.db, VENDOR);
});
afterEach(() => t.dispose());

async function seedGrant(
  id: string,
  createdAt: string,
  endsAt: string,
  status = 'pending_acceptance',
) {
  await t.db.insert(licenseGrants).values({
    id,
    billingAccountId: accountId,
    vendorId: VENDOR,
    kind: 'grant',
    source: 'complimentary',
    quantity: 2,
    endsAt,
    termsVersion: '1.1',
    status,
    createdAt,
    updatedAt: createdAt,
  });
}

const ctx = () => ({
  env: { ...TEST_ENV, PUBLIC_SITE_URL: 'https://www.aecintegrations.com' },
  executionCtx: fakeExecutionContext(),
  req: { raw: new Request('https://api.test/cron/entitlement-expiry') },
});

const fetchSeatEmails = vi.fn(
  async (_env: unknown, ids: readonly string[]) =>
    new Map(ids.map((id) => [id, `${id.slice(-3)}@acme.com`])),
);

function ledgerSender(notificationId: string) {
  return vi.fn(async (_c: unknown, opts: { dedupeKey: string; to: string }) => {
    const held = await t.db.query.notificationSends.findFirst({
      where: (n, { eq: is }) => is(n.dedupeKey, opts.dedupeKey),
    });
    if (held) return 'duplicate' as EmailOutcome;
    await t.db.insert(notificationSends).values({
      notificationId,
      recipientHash: 'h',
      tier: 'production',
      outcome: 'sent',
      dedupeKey: opts.dedupeKey,
    });
    return 'sent' as EmailOutcome;
  });
}

let sendPending: ReturnType<typeof ledgerSender>;
let sendReminder: ReturnType<typeof ledgerSender>;
beforeEach(() => {
  sendPending = ledgerSender('license-grant-pending');
  sendReminder = ledgerSender('license-grant-pending-reminder');
});

const run = (now = NOW) =>
  runLicenseGrantSweep(ctx(), t.db, {
    fetchSeatEmails,
    sendPending: sendPending as never,
    sendReminder: sendReminder as never,
    now,
  });

const readGrant = async (id: string) =>
  (await t.db.select().from(licenseGrants).where(eq(licenseGrants.id, id)))[0]!;
const keysOf = (send: ReturnType<typeof ledgerSender>) =>
  send.mock.calls.map(([, o]) => o.dedupeKey);

describe('runLicenseGrantSweep: expire', () => {
  it('expires a pending grant past its end, with one audit row, exactly once', async () => {
    await seedGrant(G_PAST, daysAgo(40), daysAgo(1));

    const first = await run();
    expect(first.expired).toBe(1);
    expect(await readGrant(G_PAST)).toMatchObject({
      status: 'expired',
      decidedAt: NOW.toISOString(),
      decidedBy: null,
    });
    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'license_grant.expired',
      actorType: 'system',
      entityType: 'license_grant',
      entityId: G_PAST,
      vendorId: VENDOR,
    });

    const second = await run(new Date(NOW.getTime() + DAY));
    expect(second.expired).toBe(0);
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
  });

  it('expires on the end instant itself, and never a grant that is not pending', async () => {
    await seedGrant(G_PAST, daysAgo(40), NOW.toISOString());
    await seedGrant(G_YOUNG, daysAgo(40), daysAgo(1), 'accepted');
    await seedGrant(G_OLD, daysAgo(40), daysAgo(1), 'withdrawn');
    const result = await run();
    expect(result.expired).toBe(1);
    expect((await readGrant(G_YOUNG)).status).toBe('accepted');
    expect((await readGrant(G_OLD)).status).toBe('withdrawn');
  });

  it('sends no prompt about an expired grant', async () => {
    await seedGrant(G_PAST, daysAgo(40), daysAgo(1));
    await run();
    expect(sendPending).not.toHaveBeenCalled();
    expect(sendReminder).not.toHaveBeenCalled();
  });
});

describe('runLicenseGrantSweep: catch-up', () => {
  it('sends license-grant-pending to an owner seat with no send yet, exactly once', async () => {
    await seedGrant(G_YOUNG, daysAgo(2), '2027-06-30T00:00:00.000Z');

    const first = await run();
    expect(first.young).toBe(1);
    expect(first.pending.sent).toBe(1);
    expect(keysOf(sendPending)).toEqual([licenseGrantPendingKey(G_YOUNG, OWNER)]);
    expect(sendPending.mock.calls[0]![1]).toMatchObject({ to: '100@acme.com' });

    const second = await run(new Date(NOW.getTime() + DAY));
    expect(second.pending.sent).toBe(0);
    expect(second.pending.duplicate).toBe(1);
    expect(sendReminder).not.toHaveBeenCalled();
  });

  it('sends nothing more when the create already sent the prompt', async () => {
    await seedGrant(G_YOUNG, daysAgo(1), '2027-06-30T00:00:00.000Z');
    await t.db.insert(notificationSends).values({
      notificationId: 'license-grant-pending',
      recipientHash: 'h',
      tier: 'production',
      outcome: 'sent',
      dedupeKey: licenseGrantPendingKey(G_YOUNG, OWNER),
    });
    const result = await run();
    expect(result.pending).toMatchObject({ sent: 0, duplicate: 1 });
  });
});

describe('runLicenseGrantSweep: the 7-day reminder (ruling R4)', () => {
  it('reminds each owner seat once, 7 days after the grant, and never a member', async () => {
    await seedGrant(G_OLD, daysAgo(7), '2027-06-30T00:00:00.000Z');

    const first = await run();
    expect(first.old).toBe(1);
    expect(first.reminder.sent).toBe(1);
    expect(keysOf(sendReminder)).toEqual([licenseGrantReminderKey(G_OLD, OWNER)]);
    expect(sendReminder.mock.calls[0]![1]).toMatchObject({
      to: '100@acme.com',
      quantity: 2,
      termsVersion: '1.1',
      vendorSlug: 'acme',
    });
    // From day 7 the reminder replaces the catch-up.
    expect(sendPending).not.toHaveBeenCalled();

    const later = await run(new Date(NOW.getTime() + 3 * DAY));
    expect(later.reminder).toMatchObject({ sent: 0, duplicate: 1 });
    expect(await t.db.select().from(notificationSends)).toHaveLength(1);
  });

  it('does not remind before day 7', async () => {
    await seedGrant(G_YOUNG, daysAgo(6.9), '2027-06-30T00:00:00.000Z');
    await run();
    expect(sendReminder).not.toHaveBeenCalled();
  });

  it('does not remind about an accepted or withdrawn grant', async () => {
    await seedGrant(G_YOUNG, daysAgo(10), '2027-06-30T00:00:00.000Z', 'accepted');
    await seedGrant(G_OLD, daysAgo(10), '2027-06-30T00:00:00.000Z', 'withdrawn');
    await run();
    expect(sendReminder).not.toHaveBeenCalled();
    expect(sendPending).not.toHaveBeenCalled();
  });
});
