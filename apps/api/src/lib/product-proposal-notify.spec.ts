/**
 * The owner email for a new product proposal (AECI-1417): sent post-commit from the
 * promote hooks, once per proposal the promote STORED, to every unbanned owner seat,
 * keyed per proposal per owner so a replay sends nothing twice.
 *
 * The dedupe case runs the real sender down to a stubbed global `fetch`, with the send
 * ledger on the in-memory D1 harness, as `notifications/double-send.spec.ts` does.
 */

import { PromotePayloadSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/client';
import { notificationSends, productProposals, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { dispatchPromoteHooks, runPromoteIngest, type PromoteRunCtx } from '../routes/promote';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import { ledgerDb } from './notifications/send-ledger';
import { emailOwnersOfProposal, proposalOwnerReviewKey } from './product-proposal-notify';

vi.mock('./notifications/send-ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./notifications/send-ledger')>();
  return { ...actual, ledgerDb: vi.fn(() => null) };
});
vi.mock('../posthog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../posthog')>()),
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = u(1);
const OWNER_A = u(100);
const OWNER_B = u(101);
const MEMBER = u(102);
const BANNED = u(103);

const ENV: Env = {
  ENV: 'production',
  RESEND_API_KEY: 'rk_test',
  EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
  PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
};

let t: TestDb;

const fetchSeatEmails = vi.fn(
  async (_env: unknown, ids: readonly string[]) =>
    new Map(ids.map((id) => [id, `${id.slice(-3)}@bentley.example`])),
);

const ctx = () => ({
  env: ENV,
  executionCtx: fakeExecutionContext(),
  req: { raw: new Request('https://api.test/api/promote') },
});

const rc = (): PromoteRunCtx => ({
  env: { ENV: 'staging' } as Env,
  request: new Request('http://localhost/api/promote'),
  waitUntil: () => {},
  bookmark: () => null,
});

async function ingest(ref: string, notify = vi.fn(async () => {})) {
  const deps = {
    dbFor: t.factory,
    syncAlgolia: async () => {},
    notifyIndexNow: async () => {},
    refreshHomeStats: async () => {},
    notifyProposalOwners: notify,
  };
  const result = await runPromoteIngest(
    rc(),
    PromotePayloadSchema.parse({
      vendors: [{ ref: 'v1', supabaseId: VENDOR, companyName: 'Bentley' }],
      product: { ref, name: 'OpenRoads' },
    }),
    deps,
  );
  const tasks: Promise<unknown>[] = [];
  dispatchPromoteHooks({ ...rc(), waitUntil: (p) => void tasks.push(p) }, result, deps);
  await Promise.all(tasks);
  return { result, notify };
}

beforeEach(async () => {
  t = await makeTestDb();
  vi.clearAllMocks();
  await t.db.insert(vendors).values({
    id: VENDOR,
    slug: 'bentley',
    companyName: 'Bentley',
    ownedAt: '2026-10-01T00:00:00.000Z',
  });
  await t.db.insert(profiles).values([
    { id: OWNER_A, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
    { id: OWNER_B, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
    { id: MEMBER, role: 'vendor_admin', vendorId: VENDOR },
    {
      id: BANNED,
      role: 'vendor_admin',
      vendorId: VENDOR,
      seatOwner: true,
      bannedAt: '2026-10-02T00:00:00.000Z',
    },
  ]);
});
afterEach(() => {
  t.dispose();
  vi.restoreAllMocks();
});

describe('the promote hook', () => {
  it('asks the owners once per proposal the promote stored, after commit', async () => {
    const { result, notify } = await ingest('p:recOpenRoads');
    const id = result.response.skipped.find((s) => s.proposalId)!.proposalId!;
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]).toEqual([expect.anything(), id]);
  });

  it('does not ask again for a refused re-send of the same ref', async () => {
    await ingest('p:recOpenRoads');
    const { result, notify } = await ingest('p:recOpenRoads');
    // The refusal carries the first proposal's id, and its owners were asked then.
    expect(result.response.skipped.some((s) => s.proposalId)).toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('emailOwnersOfProposal', () => {
  it('emails every unbanned owner seat, keyed per proposal and owner', async () => {
    const { result } = await ingest('p:recOpenRoads');
    const id = result.response.skipped.find((s) => s.proposalId)!.proposalId!;
    const sendEmail = vi.fn(async () => 'sent' as const);

    const out = await emailOwnersOfProposal(ctx(), t.db, id, {
      fetchSeatEmails,
      sendEmail: sendEmail as never,
    });

    expect(out).toEqual({ status: 'sent', emails: { sent: 2 } });
    const calls = sendEmail.mock.calls as unknown as Array<
      [unknown, { dedupeKey: string; productName: string; vendorSlug: string }]
    >;
    expect(calls.map((c) => c[1].dedupeKey).sort()).toEqual(
      [proposalOwnerReviewKey(id, OWNER_A), proposalOwnerReviewKey(id, OWNER_B)].sort(),
    );
    expect(calls[0]![1]).toMatchObject({ productName: 'OpenRoads', vendorSlug: 'bentley' });
  });

  it('sends nothing for a proposal decided before the hook ran', async () => {
    const { result } = await ingest('p:recOpenRoads');
    const id = result.response.skipped.find((s) => s.proposalId)!.proposalId!;
    await t.db
      .update(productProposals)
      .set({ decision: 'declined', decidedAt: '2026-10-19T00:00:00.000Z' })
      .where(eq(productProposals.id, id));
    const sendEmail = vi.fn(async () => 'sent' as const);
    const out = await emailOwnersOfProposal(ctx(), t.db, id, {
      fetchSeatEmails,
      sendEmail: sendEmail as never,
    });
    expect(out.status).toBe('not_open');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a replay sends one Resend call per owner, not two', async () => {
    const { result } = await ingest('p:recOpenRoads');
    const id = result.response.skipped.find((s) => s.proposalId)!.proposalId!;
    vi.mocked(ledgerDb).mockReturnValue(t.db as Db);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{"id":"re_1"}', { status: 200 }));

    await emailOwnersOfProposal(ctx(), t.db, id, { fetchSeatEmails });
    const second = await emailOwnersOfProposal(ctx(), t.db, id, { fetchSeatEmails });

    const resend = fetchSpy.mock.calls.filter(([url]) => String(url).includes('api.resend.com'));
    expect(resend).toHaveLength(2);
    expect(second.emails).toEqual({ duplicate: 2 });
    // The two duplicates are ledgered too, without a key; the keyed rows are the sends.
    const ledger = await t.db.select().from(notificationSends);
    expect(ledger.every((r) => r.entityType === 'product_proposal' && r.entityId === id)).toBe(
      true,
    );
    const keyed = ledger.filter((r) => r.dedupeKey !== null);
    expect(keyed.map((r) => r.dedupeKey).sort()).toEqual(
      [proposalOwnerReviewKey(id, OWNER_A), proposalOwnerReviewKey(id, OWNER_B)].sort(),
    );
  });
});
