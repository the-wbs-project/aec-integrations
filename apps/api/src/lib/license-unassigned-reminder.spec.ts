/**
 * The unassigned-license reminder (AECI-1512 / `STAGE_2_PAID_TIERS_SPEC.md` §7.7),
 * against the in-memory D1 harness. Real `licenses`, `product_vendors` and
 * `notification_sends` rows; the sender is a fake that keeps the ledger's dedupe rule.
 *
 * What it must hold:
 *   - A live license on no product, 7 to 10 days after its grant, reminds the owner
 *     seats once, with the products still on Free.
 *   - Assigned, ended, set to end at term end, too young, too old: nothing.
 *   - One email per account per grant day; two grant days are two emails.
 *   - Every owned product already licensed: nothing to assign, nothing sent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeExecutionContext, TEST_ENV } from '../test/helpers';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
}));

import { notificationSends, productVendors, products, profiles, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { seedBillingAccount, seedLicense } from '../test/licenses';
import type { EmailOutcome } from './email';
import {
  runLicenseUnassignedReminderSweep,
  unassignedReminderKey,
} from './license-unassigned-reminder';

const VENDOR = '11111111-1111-4111-8111-111111111111';
const OWNER = '00000000-0000-4000-8000-000000000100';
const MEMBER = '00000000-0000-4000-8000-000000000101';
const NOW = new Date('2026-10-20T11:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  vi.clearAllMocks();
  await t.db.insert(vendors).values({ id: VENDOR, slug: 'acme', companyName: 'Acme' });
  await t.db.insert(profiles).values([
    { id: OWNER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
    { id: MEMBER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: false },
  ]);
  await t.db.insert(products).values([
    { id: 'p-1', slug: 'acme-one', name: 'Acme One', promotionStatus: 'promoted' },
    { id: 'p-2', slug: 'acme-two', name: 'acme Two', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: 'p-1', vendorId: VENDOR },
    { productId: 'p-2', vendorId: VENDOR },
  ]);
});
afterEach(() => t.dispose());

const ctx = () => ({
  env: { ...TEST_ENV, PUBLIC_SITE_URL: 'https://www.aecintegrations.com' },
  executionCtx: fakeExecutionContext(),
  req: { raw: new Request('https://api.test/cron/entitlement-expiry') },
});

const fetchSeatEmails = vi.fn(
  async (_env: unknown, ids: readonly string[]) =>
    new Map(ids.map((id) => [id, `${id.slice(-3)}@acme.com`])),
);

function ledgerSender() {
  return vi.fn(async (_c: unknown, opts: { dedupeKey: string }) => {
    const held = await t.db.query.notificationSends.findFirst({
      where: (n, { eq }) => eq(n.dedupeKey, opts.dedupeKey),
    });
    if (held) return 'duplicate' as EmailOutcome;
    await t.db.insert(notificationSends).values({
      notificationId: 'license-unassigned-reminder',
      recipientHash: 'h',
      tier: 'production',
      outcome: 'sent',
      dedupeKey: opts.dedupeKey,
    });
    return 'sent' as EmailOutcome;
  });
}

const run = (sendEmail = ledgerSender(), now = NOW) =>
  runLicenseUnassignedReminderSweep(ctx(), t.db, {
    fetchSeatEmails,
    sendEmail: sendEmail as never,
    now,
  });

type Payload = {
  to: string;
  dedupeKey: string;
  unassignedCount: number;
  freeProductNames: string[];
  endsAt: string | null;
  vendorSlug: string;
};
const payloads = (send: ReturnType<typeof ledgerSender>) =>
  send.mock.calls.map(([, o]) => o as unknown as Payload);

describe('runLicenseUnassignedReminderSweep', () => {
  it('reminds the owner seat a week after a grant, naming the count and the Free products', async () => {
    const created = daysAgo(8);
    await seedLicense(t.db, VENDOR, { createdAt: created, endsAt: '2027-01-31T00:00:00.000Z' });
    await seedLicense(t.db, VENDOR, { createdAt: created, endsAt: '2027-01-31T00:00:00.000Z' });
    const account = await seedBillingAccount(t.db, VENDOR);
    const send = ledgerSender();

    const result = await run(send);

    expect(result).toMatchObject({ due: 1, capped: 0, nothingToAssign: 0 });
    expect(send).toHaveBeenCalledOnce();
    expect(payloads(send)[0]).toMatchObject({
      to: '100@acme.com',
      dedupeKey: unassignedReminderKey(account, created.slice(0, 10), OWNER),
      unassignedCount: 2,
      // compareText: case never decides the order.
      freeProductNames: ['Acme One', 'acme Two'],
      endsAt: '2027-01-31T00:00:00.000Z',
      vendorSlug: 'acme',
    });
  });

  it('sends once across the daily runs inside the window', async () => {
    await seedLicense(t.db, VENDOR, { createdAt: daysAgo(7.5) });
    const send = ledgerSender();

    await run(send);
    const second = await run(send, new Date(NOW.getTime() + 86_400_000));

    expect(second.emails.sent).toBe(0);
    expect(second.emails.duplicate).toBe(1);
  });

  it.each([
    ['6.9 days old', 6.9],
    ['10.1 days old', 10.1],
  ])('skips a license %s', async (_label, days) => {
    await seedLicense(t.db, VENDOR, { createdAt: daysAgo(days) });
    const send = ledgerSender();
    const result = await run(send);
    expect(result.due).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('skips an assigned, an ended and a cancel-at-term-end license', async () => {
    const created = daysAgo(8);
    await seedLicense(t.db, VENDOR, { createdAt: created, productId: 'p-1' });
    await seedLicense(t.db, VENDOR, {
      createdAt: created,
      endedAt: daysAgo(1),
      endReason: 'revoked',
    });
    await seedLicense(t.db, VENDOR, { createdAt: created, cancelAtTermEnd: true });
    const send = ledgerSender();

    const result = await run(send);

    expect(result.due).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('names only the products with no live license', async () => {
    await seedLicense(t.db, VENDOR, { createdAt: daysAgo(30), productId: 'p-1' });
    await seedLicense(t.db, VENDOR, { createdAt: daysAgo(8) });
    const send = ledgerSender();

    await run(send);

    expect(payloads(send)[0]!.freeProductNames).toEqual(['acme Two']);
  });

  it('sends nothing when every owned product already holds a live license', async () => {
    await seedLicense(t.db, VENDOR, { createdAt: daysAgo(30), productId: 'p-1' });
    await seedLicense(t.db, VENDOR, { createdAt: daysAgo(30), productId: 'p-2' });
    await seedLicense(t.db, VENDOR, { createdAt: daysAgo(8) });
    const send = ledgerSender();

    const result = await run(send);

    expect(result).toMatchObject({ due: 1, nothingToAssign: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends one email per grant day, each on the same run', async () => {
    await seedLicense(t.db, VENDOR, { createdAt: daysAgo(9) });
    await seedLicense(t.db, VENDOR, { createdAt: daysAgo(7.5) });
    const send = ledgerSender();

    const result = await run(send);

    expect(result.due).toBe(2);
    expect(result.emails.sent).toBe(2);
    const keys = payloads(send).map((p) => p.dedupeKey);
    expect(new Set(keys).size).toBe(2);
    expect(payloads(send).map((p) => p.unassignedCount)).toEqual([1, 1]);
  });

  it('mails owner seats only, never a member seat', async () => {
    await seedLicense(t.db, VENDOR, { createdAt: daysAgo(8) });
    const send = ledgerSender();

    await run(send);

    expect(fetchSeatEmails.mock.calls[0]![1]).toEqual([OWNER]);
  });
});
