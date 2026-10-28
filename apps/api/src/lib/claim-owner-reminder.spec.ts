/**
 * The claim owner reminder (AECI-1513 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §11a.10),
 * against the in-memory D1 harness. Real `vendor_requests`, `profiles` and
 * `notification_sends` rows are seeded, so the window read and the held-key read run
 * over real SQL. The sender is a fake that keeps the ledger's dedupe rule.
 *
 * What it must hold:
 *   - A routed, undecided claim whose deadline is at most 2 days away reminds each
 *     owner whose first `claim-owner-review` key is held. Once per owner across runs.
 *   - Outside the window, decided, fallen back: nothing.
 *   - An owner with no held key (the daily bound skipped them, or their first email
 *     failed) gets nothing. A banned owner gets nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeExecutionContext, TEST_ENV } from '../test/helpers';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
}));

import { notificationSends, profiles, vendorRequests, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  OWNER_REMINDER_BATCH_CAP,
  ownerReminderKey,
  runClaimOwnerReviewReminderSweep,
} from './claim-owner-reminder';
import { ownerReviewKey } from './claim-owner-routing';
import type { EmailOutcome } from './email';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = uuid(1);
const OWNER_A = uuid(100);
const OWNER_B = uuid(101);
const MEMBER = uuid(102);
const BANNED = uuid(103);
const NOW = new Date('2026-10-20T14:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  vi.clearAllMocks();
  await t.db.insert(vendors).values({ id: VENDOR, slug: 'acme', companyName: 'Acme' });
  await t.db.insert(profiles).values([
    { id: OWNER_A, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
    { id: OWNER_B, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
    { id: MEMBER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: false },
    {
      id: BANNED,
      role: 'vendor_admin',
      vendorId: VENDOR,
      seatOwner: true,
      bannedAt: '2026-10-01T00:00:00.000Z',
    },
  ]);
});
afterEach(() => t.dispose());

const ctx = () => ({
  env: { ...TEST_ENV, PUBLIC_SITE_URL: 'https://www.aecintegrations.com' },
  executionCtx: fakeExecutionContext(),
  req: { raw: new Request('https://api.test/cron/claim-owner-fallback') },
});

const fetchSeatEmails = vi.fn(
  async (_env: unknown, ids: readonly string[]) =>
    new Map(ids.map((id) => [id, `${id.slice(-3)}@acme.com`])),
);

/** Holds a ledger key the way a `sent` send does. */
async function holdKey(key: string, notificationId = 'claim-owner-review') {
  await t.db.insert(notificationSends).values({
    notificationId,
    recipientHash: 'h',
    tier: 'production',
    outcome: 'sent',
    dedupeKey: key,
  });
}

/** A fake sender with the ledger's rule: a held key is a `duplicate`. */
function ledgerSender() {
  return vi.fn(async (_c: unknown, opts: { dedupeKey: string; to: string }) => {
    const held = await t.db.query.notificationSends.findFirst({
      where: (n, { eq }) => eq(n.dedupeKey, opts.dedupeKey),
    });
    if (held) return 'duplicate' as EmailOutcome;
    await holdKey(opts.dedupeKey, 'claim-owner-review-reminder');
    return 'sent' as EmailOutcome;
  });
}

async function seedRouted(
  id: string,
  routedAt: string,
  over: Partial<typeof vendorRequests.$inferInsert> = {},
) {
  await t.db.insert(vendorRequests).values({
    id,
    kind: 'claim',
    status: 'open',
    targetType: 'vendor',
    targetId: VENDOR,
    submitterEmail: 'casey@acme.com',
    submitterName: 'Casey',
    domainMatch: 'match',
    body: 'Please add me.',
    routedToOwnersAt: routedAt,
    ...over,
  });
}

async function seedWithKeys(id: string, routedAt: string, owners = [OWNER_A, OWNER_B]) {
  await seedRouted(id, routedAt);
  for (const owner of owners) await holdKey(ownerReviewKey(id, owner));
}

const run = (sendEmail = ledgerSender(), now = NOW) =>
  runClaimOwnerReviewReminderSweep(ctx(), t.db, {
    fetchSeatEmails,
    sendEmail: sendEmail as never,
    now,
  });

describe('runClaimOwnerReviewReminderSweep', () => {
  it('reminds each owner who got the first email, with the deadline and the reminder key', async () => {
    const id = uuid(500);
    await seedWithKeys(id, daysAgo(5.5));
    const sendEmail = ledgerSender();

    const result = await run(sendEmail);

    expect(result.due).toBe(1);
    expect(result.emails.sent).toBe(2);
    const sent = sendEmail.mock.calls.map(([, o]) => o as unknown as Record<string, unknown>);
    expect(sent.map((o) => o.dedupeKey).sort()).toEqual(
      [ownerReminderKey(id, OWNER_A), ownerReminderKey(id, OWNER_B)].sort(),
    );
    expect(sent[0]).toMatchObject({
      requestId: id,
      vendorName: 'Acme',
      vendorSlug: 'acme',
      submitterName: 'Casey',
      decideBy: new Date(Date.parse(daysAgo(5.5)) + 7 * 86_400_000).toISOString(),
    });
  });

  it('sends once per owner across the daily runs inside the window', async () => {
    const id = uuid(500);
    await seedWithKeys(id, daysAgo(5.5));
    const sendEmail = ledgerSender();

    await run(sendEmail);
    const second = await run(sendEmail, new Date(NOW.getTime() + 86_400_000));

    expect(second.emails.sent).toBe(0);
    expect(second.emails.duplicate).toBe(2);
  });

  it.each([
    ['routed 4.9 days ago, deadline more than 2 days away', 4.9],
    ['routed exactly 7 days ago, deadline reached (the fallback takes it)', 7],
    ['routed 8 days ago, past the deadline', 8],
  ])('skips a claim %s', async (_label, days) => {
    await seedWithKeys(uuid(500), daysAgo(days));
    const sendEmail = ledgerSender();

    const result = await run(sendEmail);

    expect(result.due).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('includes a claim routed exactly 5 days ago, the window edge', async () => {
    await seedWithKeys(uuid(500), daysAgo(5));
    const result = await run();
    expect(result.emails.sent).toBe(2);
  });

  it('skips a decided claim and one that already fell back to AECi', async () => {
    await seedRouted(uuid(500), daysAgo(6), { status: 'resolved' });
    await seedRouted(uuid(501), daysAgo(6), { status: 'rejected' });
    await seedRouted(uuid(502), daysAgo(6), {
      routedToOwnersAt: null,
      ownerFallbackAt: daysAgo(1),
    });
    const sendEmail = ledgerSender();

    const result = await run(sendEmail);

    expect(result.due).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('reminds an in_review claim too', async () => {
    await seedRouted(uuid(500), daysAgo(6), { status: 'in_review' });
    await holdKey(ownerReviewKey(uuid(500), OWNER_A));
    const result = await run();
    expect(result.emails.sent).toBe(1);
  });

  it('sends nothing for a claim the daily bound kept from the owners (no key held)', async () => {
    await seedRouted(uuid(500), daysAgo(6));
    const sendEmail = ledgerSender();

    const result = await run(sendEmail);

    expect(result.due).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('reminds only the owner whose first email went out, not one whose first email failed', async () => {
    // A failed send releases its key, so only OWNER_A's is held.
    await seedWithKeys(uuid(500), daysAgo(6), [OWNER_A]);
    const sendEmail = ledgerSender();

    await run(sendEmail);

    expect(sendEmail).toHaveBeenCalledOnce();
    expect((sendEmail.mock.calls[0]![1] as { dedupeKey: string }).dedupeKey).toBe(
      ownerReminderKey(uuid(500), OWNER_A),
    );
  });

  it('never mails a banned owner or a member seat, even with a held key', async () => {
    await seedWithKeys(uuid(500), daysAgo(6), [BANNED, MEMBER]);
    const sendEmail = ledgerSender();

    await run(sendEmail);

    expect(sendEmail).not.toHaveBeenCalled();
    expect(fetchSeatEmails.mock.calls[0]![1]).toEqual(expect.arrayContaining([OWNER_A, OWNER_B]));
    expect(fetchSeatEmails.mock.calls[0]![1]).toHaveLength(2);
  });

  it('exposes a batch cap', () => {
    expect(OWNER_REMINDER_BATCH_CAP).toBe(100);
  });
});
