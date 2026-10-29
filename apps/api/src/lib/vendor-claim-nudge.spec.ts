/**
 * The vendor claim nudge (AECI-1305 / `ACCOUNT_ONBOARDING_SPEC.md` §1.1), against the
 * in-memory D1 harness. Real `profiles`, `profile_details`, claim, listing, invite,
 * mailing-list and `notification_sends` rows. The sender is a fake that keeps the
 * ledger's dedupe rule, and the address lookup is a fake map.
 *
 * What it must hold:
 *   - A `software_vendor` reviewer account, 3 to 365 days old, with no claim, gets one
 *     email, once, with a marketing token minted beforehand.
 *   - Every SQL exclusion and every address exclusion sends nothing.
 *   - At most NUDGE_SEND_CAP sends a run, oldest account first.
 *   - The token and its audit row commit in one batch.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeExecutionContext, TEST_ENV } from '../test/helpers';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
}));

import {
  auditLog,
  listingRequests,
  mailingList,
  notificationPreferences,
  notificationSends,
  profileDetails,
  profiles,
  requestConfirmations,
  vendorRequests,
  vendorSeatInvites,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import type { EmailOutcome } from './email';
import { PREFERENCES_CREATED_ACTION, PREFERENCES_UPDATED_ACTION } from './notification-preferences';
import {
  NUDGE_SEND_CAP,
  runVendorClaimNudgeSweep,
  vendorClaimNudgeKey,
} from './vendor-claim-nudge';

const NOW = new Date('2026-10-29T15:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString();
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = uuid(9999);

/** Every profile's address is `{last 3 of id}@co.example`. */
const addressOf = (id: string) => `${id.slice(-3)}@co.example`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  vi.clearAllMocks();
  await t.db.insert(vendors).values({ id: VENDOR, slug: 'acme', companyName: 'Acme' });
});
afterEach(() => t.dispose());

const ctx = () => ({
  env: { ...TEST_ENV, PUBLIC_SITE_URL: 'https://www.aecintegrations.com' },
  executionCtx: fakeExecutionContext(),
  req: { raw: new Request('https://api.test/cron/vendor-claim-nudge') },
});

async function seedAccount(
  n: number,
  over: {
    createdAt?: string;
    companyType?: string | null;
    role?: string;
    vendorId?: string | null;
    bannedAt?: string | null;
  } = {},
): Promise<string> {
  const id = uuid(n);
  await t.db.insert(profiles).values({
    id,
    role: over.role ?? 'reviewer',
    vendorId: over.vendorId ?? null,
    bannedAt: over.bannedAt ?? null,
    createdAt: over.createdAt ?? daysAgo(5),
  });
  if (over.companyType !== null) {
    await t.db
      .insert(profileDetails)
      .values({ profileId: id, companyType: over.companyType ?? 'software_vendor' });
  }
  return id;
}

const fetchEmails = vi.fn(
  async (_env: unknown, ids: readonly string[]) => new Map(ids.map((id) => [id, addressOf(id)])),
);

function ledgerSender() {
  return vi.fn(async (_c: unknown, opts: { dedupeKey: string }) => {
    const held = await t.db.query.notificationSends.findFirst({
      where: (n, { eq: eqOp }) => eqOp(n.dedupeKey, opts.dedupeKey),
    });
    if (held) return 'duplicate' as EmailOutcome;
    await t.db.insert(notificationSends).values({
      notificationId: 'vendor-claim-nudge',
      recipientHash: 'h',
      tier: 'production',
      outcome: 'sent',
      dedupeKey: opts.dedupeKey,
    });
    return 'sent' as EmailOutcome;
  });
}

type Payload = {
  to: string;
  profileId: string;
  marketingMuteToken: string | null;
  dedupeKey: string;
};
const payloads = (send: ReturnType<typeof ledgerSender>) =>
  send.mock.calls.map(([, o]) => o as unknown as Payload);

const run = (send = ledgerSender(), now = NOW) =>
  runVendorClaimNudgeSweep(ctx(), t.db, { fetchEmails, sendEmail: send as never, now });

describe('runVendorClaimNudgeSweep', () => {
  it('sends a software_vendor account one email, with a freshly minted marketing token', async () => {
    const id = await seedAccount(1);
    const send = ledgerSender();

    const result = await run(send);

    expect(result).toMatchObject({ candidates: 1, scanned: 1 });
    expect(result.emails.sent).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    const [pref] = await t.db.select().from(notificationPreferences);
    expect(pref).toMatchObject({ profileId: id, nudgesMutedAt: null, marketingMutedAt: null });
    expect(pref!.marketingMuteToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(payloads(send)[0]).toEqual({
      to: addressOf(id),
      profileId: id,
      marketingMuteToken: pref!.marketingMuteToken,
      dedupeKey: vendorClaimNudgeKey(id),
    });
  });

  it('sends once across daily runs: the held key stops the second', async () => {
    await seedAccount(1);
    const send = ledgerSender();

    await run(send);
    const second = await run(send, new Date(NOW.getTime() + 86_400_000));

    expect(send).toHaveBeenCalledOnce();
    expect(second.candidates).toBe(0);
  });

  it('a held key sends nothing, even before the SQL read sees it', async () => {
    const id = await seedAccount(1);
    await t.db.insert(notificationSends).values({
      notificationId: 'vendor-claim-nudge',
      recipientHash: 'h',
      tier: 'production',
      outcome: 'unknown',
      dedupeKey: vendorClaimNudgeKey(id),
    });
    const send = ledgerSender();
    const result = await run(send);
    expect(result.candidates).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['2.9 days old: not on the day of sign-up', { createdAt: daysAgo(2.9) }],
    ['365 days old: past the window', { createdAt: daysAgo(365) }],
    ['a different company type', { companyType: 'architect' }],
    ['another software type', { companyType: 'backoffice_software' }],
    ['never answered About you', { companyType: null }],
    ['a seat', { role: 'vendor_admin', vendorId: VENDOR }],
    ['a reviewer row that still names a vendor', { vendorId: VENDOR }],
    ['an admin', { role: 'admin' }],
    ['a banned account', { bannedAt: daysAgo(1) }],
  ] as const)('skips %s', async (_label, over) => {
    await seedAccount(1, over);
    const send = ledgerSender();
    const result = await run(send);
    expect(result.candidates).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['exactly 3 days old', 3],
    ['364.9 days old', 364.9],
  ])('sends at the window edge: %s', async (_label, days) => {
    await seedAccount(1, { createdAt: daysAgo(days) });
    const result = await run();
    expect(result.emails.sent).toBe(1);
  });

  it('skips an account that opted out of marketing email', async () => {
    const id = await seedAccount(1);
    await t.db.insert(notificationPreferences).values({
      profileId: id,
      marketingMutedAt: daysAgo(1),
      marketingMuteToken: 'mkt',
    });
    const send = ledgerSender();
    expect((await run(send)).candidates).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('still sends to a seat-muted nudge row: the two opt-outs are separate', async () => {
    const id = await seedAccount(1);
    await t.db
      .insert(notificationPreferences)
      .values({ profileId: id, nudgesMutedAt: daysAgo(1), muteToken: 'nudge-tok' });
    const send = ledgerSender();
    expect((await run(send)).emails.sent).toBe(1);
    const [pref] = await t.db.select().from(notificationPreferences);
    expect(pref).toMatchObject({ muteToken: 'nudge-tok', nudgesMutedAt: daysAgo(1) });
    expect(pref!.marketingMuteToken).toMatch(/^[0-9a-f-]{36}$/);
  });

  describe('address exclusions', () => {
    const blockers: Array<[string, (email: string) => Promise<unknown>, string]> = [
      [
        'a claim, whatever its status',
        (email) =>
          t.db.insert(vendorRequests).values({
            kind: 'claim',
            targetType: 'vendor',
            targetId: VENDOR,
            submitterEmail: email,
            body: 'b',
            status: 'rejected',
          }),
        'claim',
      ],
      [
        'an open listing request',
        (email) =>
          t.db
            .insert(listingRequests)
            .values({ listingName: 'L', website: 'https://l.example', submitterEmail: email }),
        'listing_request',
      ],
      [
        'an unconfirmed, unexpired confirmation',
        (email) =>
          t.db.insert(requestConfirmations).values({
            kind: 'claim',
            tokenHash: 'h1',
            submitterEmail: email,
            termsVersion: '1',
            expiresAt: inDays(3),
          }),
        'pending_confirmation',
      ],
      [
        'a pending seat invite',
        (email) =>
          t.db.insert(vendorSeatInvites).values({ vendorId: VENDOR, email, expiresAt: inDays(3) }),
        'pending_invite',
      ],
      [
        'a mailing-list unsubscribe',
        (email) => t.db.insert(mailingList).values({ email, unsubscribedAt: daysAgo(10) }),
        'mailing_list_unsubscribed',
      ],
    ];

    it.each(blockers)('skips %s', async (_label, seed, reason) => {
      const id = await seedAccount(1);
      // Stored mixed case: the comparison lowercases both sides.
      await seed(addressOf(id).toUpperCase());
      const send = ledgerSender();
      const result = await run(send);
      expect(send).not.toHaveBeenCalled();
      expect(result.skipped[reason as keyof typeof result.skipped]).toBe(1);
      // A skip writes nothing, so the account is a candidate again tomorrow.
      expect(await t.db.select().from(notificationPreferences)).toHaveLength(0);
    });

    it.each([
      [
        'a closed listing request',
        (email: string) =>
          t.db.insert(listingRequests).values({
            listingName: 'L',
            website: 'https://l.example',
            submitterEmail: email,
            status: 'resolved',
          }),
      ],
      [
        'an expired confirmation',
        (email: string) =>
          t.db.insert(requestConfirmations).values({
            kind: 'listing',
            tokenHash: 'h2',
            submitterEmail: email,
            termsVersion: '1',
            expiresAt: daysAgo(1),
          }),
      ],
      [
        'a confirmed confirmation (its request row is checked on its own)',
        (email: string) =>
          t.db.insert(requestConfirmations).values({
            kind: 'listing',
            tokenHash: 'h3',
            submitterEmail: email,
            termsVersion: '1',
            expiresAt: inDays(3),
            confirmedAt: daysAgo(1),
          }),
      ],
      [
        'an expired invite',
        (email: string) =>
          t.db.insert(vendorSeatInvites).values({ vendorId: VENDOR, email, expiresAt: daysAgo(1) }),
      ],
      [
        'a revoked invite',
        (email: string) =>
          t.db.insert(vendorSeatInvites).values({
            vendorId: VENDOR,
            email,
            expiresAt: inDays(3),
            revokedAt: daysAgo(1),
          }),
      ],
      [
        'a subscribed mailing-list row',
        (email: string) => t.db.insert(mailingList).values({ email }),
      ],
      [
        'a correction request (not a claim)',
        (email: string) =>
          t.db.insert(vendorRequests).values({
            kind: 'correction',
            targetType: 'vendor',
            targetId: VENDOR,
            submitterEmail: email,
            body: 'b',
          }),
      ],
    ])('still sends with %s', async (_label, seed) => {
      const id = await seedAccount(1);
      await seed(addressOf(id));
      expect((await run()).emails.sent).toBe(1);
    });

    it('skips an account with no address on file', async () => {
      await seedAccount(1);
      const send = ledgerSender();
      const result = await runVendorClaimNudgeSweep(ctx(), t.db, {
        fetchEmails: async () => new Map(),
        sendEmail: send as never,
        now: NOW,
      });
      expect(send).not.toHaveBeenCalled();
      expect(result.skipped.no_address).toBe(1);
    });
  });

  it(`sends at most ${NUDGE_SEND_CAP} a run, oldest account first, and stops looking up addresses`, async () => {
    const total = NUDGE_SEND_CAP + 60;
    for (let n = 1; n <= total; n++) {
      // n = 1 is the oldest.
      await seedAccount(n, { createdAt: daysAgo(200 - n) });
    }
    fetchEmails.mockClear();
    const send = ledgerSender();

    const result = await run(send);

    expect(result.candidates).toBe(total);
    expect(result.emails.sent).toBe(NUDGE_SEND_CAP);
    expect(payloads(send).map((p) => p.profileId)).toEqual(
      Array.from({ length: NUDGE_SEND_CAP }, (_, i) => uuid(i + 1)),
    );
    // One lookup chunk covered the cap: the other 60 were never looked up.
    expect(result.scanned).toBe(NUDGE_SEND_CAP);
    expect(fetchEmails).toHaveBeenCalledOnce();

    // The backlog drains over the next runs, at the same cap.
    const next = await run(send, new Date(NOW.getTime() + 86_400_000));
    expect(next.emails.sent).toBe(NUDGE_SEND_CAP);
    const last = await run(send, new Date(NOW.getTime() + 2 * 86_400_000));
    expect(last.emails.sent).toBe(total - 2 * NUDGE_SEND_CAP);
  });

  it('mints the row and its audit row in one batch, and returns the entries', async () => {
    const id = await seedAccount(1);
    const batch = vi.spyOn(t.db, 'batch');

    const result = await run();

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toHaveLength(2);
    const audit = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, PREFERENCES_CREATED_ACTION));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      entityId: id,
      actorType: 'system',
      metadata: { source: 'vendor-claim-nudge', nudgesMuted: false, marketingMuted: false },
    });
    expect(result.auditEntries).toHaveLength(1);
    const [pref] = await t.db.select().from(notificationPreferences);
    expect(JSON.stringify(audit)).not.toContain(pref!.marketingMuteToken!);
  });

  it('mints a token on an existing nudge row with an updated audit row, in one batch', async () => {
    const id = await seedAccount(1);
    await t.db.insert(notificationPreferences).values({ profileId: id, muteToken: 'nudge-tok' });
    const batch = vi.spyOn(t.db, 'batch');

    await run();

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toHaveLength(2);
    const audit = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, PREFERENCES_UPDATED_ACTION));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      entityId: id,
      metadata: { source: 'vendor-claim-nudge', marketingTokenMinted: true },
    });
  });

  it('keeps an existing marketing token and writes no audit row for it', async () => {
    const id = await seedAccount(1);
    await t.db
      .insert(notificationPreferences)
      .values({ profileId: id, muteToken: 'nudge-tok', marketingMuteToken: 'mkt-tok' });
    const send = ledgerSender();

    const result = await run(send);

    expect(payloads(send)[0]!.marketingMuteToken).toBe('mkt-tok');
    expect(result.auditEntries).toHaveLength(0);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('counts a failed send and holds no key, so the next run retries it', async () => {
    await seedAccount(1);
    const failing = vi.fn(async () => 'failed' as EmailOutcome);
    const result = await runVendorClaimNudgeSweep(ctx(), t.db, {
      fetchEmails,
      sendEmail: failing as never,
      now: NOW,
    });
    expect(result.emails.failed).toBe(1);
    expect((await run()).emails.sent).toBe(1);
  });
});
