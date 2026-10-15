/**
 * The owner fan-out for a routed claim (AECI-1368 / §11a.10): one
 * `claim-owner-review` per unbanned owner seat, keyed per claim and owner, and the
 * per-vendor per-day bound that keeps an anonymous route from flooding a company.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeExecutionContext, TEST_ENV } from '../test/helpers';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
}));

import { profiles, vendorRequests, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  emailOwnersOfRoutedClaim,
  OWNER_REVIEW_DAILY_LIMIT,
  ownerReviewKey,
  utcDayStart,
} from './claim-owner-routing';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = uuid(1);
const OWNER_A = uuid(100);
const OWNER_B = uuid(101);
const MEMBER = uuid(102);
const BANNED = uuid(103);
const ROUTED_AT = '2026-10-15T09:00:00.000Z';

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
  req: { raw: new Request('https://api.test/api/requests/claim') },
});

/** Every profile has an address, so the result shows which ones were asked for. */
const fetchSeatEmails = vi.fn(
  async (_env: unknown, ids: readonly string[]) =>
    new Map(ids.map((id) => [id, `${id.slice(-3)}@acme.com`])),
);

async function seedRouted(id: string, routedAt = ROUTED_AT) {
  await t.db.insert(vendorRequests).values({
    id,
    kind: 'claim',
    status: 'open',
    targetType: 'vendor',
    targetId: VENDOR,
    submitterEmail: 'casey@acme.com',
    domainMatch: 'match',
    body: 'Please add me.',
    routedToOwnersAt: routedAt,
  });
}

const claim = (requestId: string) => ({
  requestId,
  vendorId: VENDOR,
  routedToOwnersAt: ROUTED_AT,
  submitterEmail: 'casey@acme.com',
  submitterName: 'Casey',
  submitterRole: null,
  submitterLinkedinUrl: null,
  body: 'Please add me.',
  contextProductName: null,
});

describe('emailOwnersOfRoutedClaim', () => {
  it('emails every unbanned owner seat once, keyed per claim and owner', async () => {
    await seedRouted(uuid(500));
    const sendEmail = vi.fn(async () => 'sent' as const);

    const result = await emailOwnersOfRoutedClaim(ctx(), t.db, claim(uuid(500)), {
      fetchSeatEmails,
      sendEmail: sendEmail as never,
    });

    expect(result).toEqual({ status: 'sent', emails: { sent: 2 } });
    expect(fetchSeatEmails.mock.calls[0]![1]).toEqual(expect.arrayContaining([OWNER_A, OWNER_B]));
    expect(fetchSeatEmails.mock.calls[0]![1]).toHaveLength(2);
    const keys = sendEmail.mock.calls.map(
      (c) => (c as unknown as [unknown, { dedupeKey: string }])[1].dedupeKey,
    );
    expect(keys.sort()).toEqual(
      [ownerReviewKey(uuid(500), OWNER_A), ownerReviewKey(uuid(500), OWNER_B)].sort(),
    );
    expect(
      (sendEmail.mock.calls[0] as unknown as [unknown, { decideBy: string }])[1].decideBy,
    ).toBe('2026-10-22T09:00:00.000Z');
  });

  it(`stops emailing once ${OWNER_REVIEW_DAILY_LIMIT} claims on one vendor were routed that UTC day`, async () => {
    for (let i = 0; i <= OWNER_REVIEW_DAILY_LIMIT; i++) await seedRouted(uuid(600 + i));
    const sendEmail = vi.fn(async () => 'sent' as const);

    const result = await emailOwnersOfRoutedClaim(
      ctx(),
      t.db,
      claim(uuid(600 + OWNER_REVIEW_DAILY_LIMIT)),
      { fetchSeatEmails, sendEmail: sendEmail as never },
    );

    expect(result.status).toBe('bounded');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('does not count claims routed on an earlier day', async () => {
    for (let i = 0; i < OWNER_REVIEW_DAILY_LIMIT; i++) {
      await seedRouted(uuid(700 + i), '2026-10-14T23:00:00.000Z');
    }
    await seedRouted(uuid(800));
    const sendEmail = vi.fn(async () => 'sent' as const);

    const result = await emailOwnersOfRoutedClaim(ctx(), t.db, claim(uuid(800)), {
      fetchSeatEmails,
      sendEmail: sendEmail as never,
    });
    expect(result.status).toBe('sent');
  });

  it('sends nothing when no owner has an address on file', async () => {
    await seedRouted(uuid(500));
    const sendEmail = vi.fn(async () => 'sent' as const);
    const result = await emailOwnersOfRoutedClaim(ctx(), t.db, claim(uuid(500)), {
      fetchSeatEmails: async () => new Map(),
      sendEmail: sendEmail as never,
    });
    expect(result.status).toBe('no_owners');
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('utcDayStart', () => {
  it('is midnight UTC of the same day', () => {
    expect(utcDayStart('2026-10-15T23:59:59.999Z')).toBe('2026-10-15T00:00:00.000Z');
  });
});
