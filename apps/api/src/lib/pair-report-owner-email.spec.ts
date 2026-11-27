/**
 * The owner email on a Sync Service data flow report (AECI-2229,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.7), end to end: the real submit route and the
 * real sender down to a stubbed global `fetch`, with the send ledger on the in-memory
 * D1 harness, so the `notification_sends` UNIQUE index that turns a replay into a
 * `duplicate` is real SQLite. The seat addresses come from an injected
 * `fetchSeatEmails`.
 */

import { addContestDays, PAIR_PROTEST_WINDOW_DAYS } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/client';
import {
  claims,
  connectorEvidencedPairs,
  notificationSends,
  productVendors,
  products,
  profiles,
  syncServicePairContests,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { createSubmitPairContestHandler } from '../routes/vendor-pair-contests';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import type { AuthzVariables } from './authz';
import {
  emailPairReportSubmittedToOwner,
  pairReportSubmittedOwnerKey,
} from './contest-protest-emails';
import { formatDeadline } from './email';
import { ledgerDb } from './notifications/send-ledger';

vi.mock('./notifications/send-ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./notifications/send-ledger')>();
  return { ...actual, ledgerDb: vi.fn(() => null) };
});

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Acumatica (an endpoint vendor) reports a flow on Rivets' claimed Sync Service pair.
const RIVETS = uuid(1);
const PROCORE = uuid(2);
const ACUMATICA = uuid(3);
const P_PROCORE = uuid(10);
const P_ACUMATICA = uuid(11);
const P_INEIGHT = uuid(12);
const S_SYNC = uuid(20);
const PAIR = uuid(30); // claimed by Rivets: the owner decides its flows
const PAIR_SEEDED = uuid(31); // AECi-held: AECi decides
const DO_RFIS = uuid(40);
const CLAIM = uuid(50); // on PAIR, a_to_b
const CLAIM_SEEDED = uuid(51); // on PAIR_SEEDED
const SEAT_R1 = uuid(100);
const SEAT_R2 = uuid(101);
const SEAT_A1 = uuid(110);
const SEAT_P1 = uuid(120);

const ADDRESS: Record<string, string> = {
  [SEAT_R1]: 'sam@rivets.example',
  [SEAT_R2]: 'kim@rivets.example',
  [SEAT_A1]: 'dana@acumatica.example',
  [SEAT_P1]: 'lee@procore.example',
};
const fetchSeatEmails = vi.fn(
  async (_env: Env, ids: readonly string[]) =>
    new Map(ids.filter((id) => ADDRESS[id]).map((id) => [id, ADDRESS[id]!])),
);

/** Production, so the tier policy delivers to the outside test addresses. */
const ENV: Env = {
  ENV: 'production',
  RESEND_API_KEY: 'rk_test',
  EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
  SUPPORT_EMAIL: 'support@aecintegrations.com',
  PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
};

const seat = (userId: string, vendorId: string | null) =>
  ({
    userId,
    email: `${userId}@example.test`,
    role: 'vendor_admin',
    vendorId,
    entitlementTier: 'unclaimed',
    entitlement: null,
  }) as AuthzVariables['auth'];

let t: TestDb;
function spyFetch() {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response('{"id":"re_1"}', { status: 200 }));
}
let fetchSpy: ReturnType<typeof spyFetch>;

beforeEach(async () => {
  t = await makeTestDb();
  fetchSpy = spyFetch();
  vi.mocked(ledgerDb).mockReturnValue(t.db as Db);
  fetchSeatEmails.mockClear();
  await t.db.insert(vendors).values([
    { id: RIVETS, slug: 'rivets', companyName: 'Rivets' },
    { id: PROCORE, slug: 'procore-inc', companyName: 'Procore Inc' },
    { id: ACUMATICA, slug: 'acumatica-inc', companyName: 'Acumatica Inc' },
  ]);
  const promoted = { promotionStatus: 'promoted' } as const;
  await t.db.insert(products).values([
    { id: P_PROCORE, slug: 'procore', name: 'Procore', ...promoted },
    { id: P_ACUMATICA, slug: 'acumatica', name: 'Acumatica', ...promoted },
    { id: P_INEIGHT, slug: 'ineight', name: 'InEight', ...promoted },
    {
      id: S_SYNC,
      slug: 'rivets-sync',
      name: 'Rivets Sync',
      productRole: 'connector',
      connectorKind: 'sync_service',
      ...promoted,
    },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_PROCORE, vendorId: PROCORE, isPrimary: true },
    { productId: P_ACUMATICA, vendorId: ACUMATICA, isPrimary: true },
    { productId: P_INEIGHT, vendorId: ACUMATICA, isPrimary: true },
    { productId: S_SYNC, vendorId: RIVETS, isPrimary: true },
  ]);
  await t.db.insert(profiles).values([
    { id: SEAT_R1, role: 'vendor_admin', vendorId: RIVETS },
    { id: SEAT_R2, role: 'vendor_admin', vendorId: RIVETS },
    { id: SEAT_A1, role: 'vendor_admin', vendorId: ACUMATICA },
    { id: SEAT_P1, role: 'vendor_admin', vendorId: PROCORE },
  ]);
  await t.db.insert(connectorEvidencedPairs).values([
    {
      id: PAIR,
      name: 'Procore and Acumatica (Rivets Sync)',
      connectorProductId: S_SYNC,
      productAId: P_PROCORE,
      productBId: P_ACUMATICA,
      direction: 'a_to_b',
      builtByVendorId: RIVETS,
      claimedAt: '2026-10-01T00:00:00.000Z',
      origin: 'vendor',
      maintainedBy: 'vendor',
    },
    {
      id: PAIR_SEEDED,
      name: 'Procore and InEight (Rivets Sync)',
      connectorProductId: S_SYNC,
      productAId: P_PROCORE,
      productBId: P_INEIGHT,
      direction: 'both',
    },
  ]);
  await t.db.insert(taxonomyDataObjects).values({
    id: DO_RFIS,
    slug: 'rfis',
    name: 'RFIs',
    displayOrder: 1,
  });
  await t.db.insert(claims).values([
    { id: CLAIM, connectorEvidencedPairId: PAIR, dataObjectId: DO_RFIS, direction: 'a_to_b' },
    {
      id: CLAIM_SEEDED,
      connectorEvidencedPairId: PAIR_SEEDED,
      dataObjectId: DO_RFIS,
      direction: 'a_to_b',
    },
  ]);
});
afterEach(() => {
  t.dispose();
  vi.restoreAllMocks();
});

function app(auth: AuthzVariables['auth']) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post(
    '/api/vendor/integrations/:id/pair-contests',
    createSubmitPairContestHandler(t.factory, (c, db, row) =>
      emailPairReportSubmittedToOwner(c, db, row, { fetchSeatEmails }),
    ),
  );
  return a;
}

async function submit(id: string, body: unknown, auth = seat(SEAT_A1, ACUMATICA)) {
  const env: Env = {
    ...ENV,
    CACHE_PURGE_QUEUE: { send: vi.fn() } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const ctx = fakeExecutionContext();
  const res = await app(auth).request(
    `/api/vendor/integrations/${id}/pair-contests`,
    { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
    env,
    ctx,
  );
  await Promise.all(vi.mocked(ctx.waitUntil).mock.calls.map((c) => c[0]));
  return res.status;
}

interface Sent {
  to: string;
  subject: string;
  text: string;
  html: string;
}

function sent(): Sent[] {
  return fetchSpy.mock.calls
    .filter(([url]) => String(url).includes('api.resend.com'))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Sent);
}
/** Sends to a vendor seat: everything but the AECi alert to the support inbox. */
const toSeats = () => sent().filter((m) => m.to !== ENV.SUPPORT_EMAIL);
const toAeci = () => sent().filter((m) => m.to === ENV.SUPPORT_EMAIL);

const ledger = (notificationId: string) =>
  t.db.select().from(notificationSends).where(eq(notificationSends.notificationId, notificationId));

function cronCtx() {
  return {
    env: ENV,
    executionCtx: fakeExecutionContext(),
    req: { raw: new Request('https://aeci-api/api/vendor/integrations/x/pair-contests') },
  };
}

const REASON = 'We send RFIs back to Procore too.';
const flow = (claimId = CLAIM, proposed: string | null = 'both') => ({
  kind: 'data_flow',
  claim_id: claimId,
  reason: REASON,
  ...(proposed ? { proposed_direction: proposed } : {}),
});
const reportRow = async () => {
  const [row] = await t.db.select().from(syncServicePairContests);
  return row!;
};

describe('a data flow report routed to the owner (AECI-2229)', () => {
  it('emails every owner seat the 30-day answer date', async () => {
    expect(await submit(PAIR, flow())).toBe(201);
    const row = await reportRow();
    expect(row.routedTo).toBe('owner');

    const by = formatDeadline(addContestDays(row.createdAt, PAIR_PROTEST_WINDOW_DAYS));
    const mail = toSeats();
    expect(mail.map((m) => m.to).sort()).toEqual(['kim@rivets.example', 'sam@rivets.example']);
    const first = mail.find((m) => m.to === 'sam@rivets.example')!;
    expect(first.subject).toBe(
      `Answer by ${by}: data flow report on Procore and Acumatica (Rivets Sync)`,
    );
    expect(first.text).toContain(
      'Acumatica Inc says the RFIs data flow on Procore and Acumatica (Rivets Sync) is wrong.',
    );
    expect(first.text).toContain(`If you have not answered by ${by}, Acumatica Inc may ask`);
    expect(first.text).toContain('Direction on record: From Procore to Acumatica');
    expect(first.text).toContain('What they say is right: Both ways');
    expect(first.text).toContain(`Their reason: ${REASON}`);
    expect(first.text).toContain('https://www.aecintegrations.com/vendor/rivets/messages');
    // The owner decides, so AECi is not alerted.
    expect(toAeci()).toEqual([]);

    const rows = await ledger('pair-report-submitted-owner');
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual(
      [
        pairReportSubmittedOwnerKey(row.id, SEAT_R1),
        pairReportSubmittedOwnerKey(row.id, SEAT_R2),
      ].sort(),
    );
    expect(rows.every((r) => r.outcome === 'sent')).toBe(true);
  });

  it('names "should not be listed" when no direction is proposed', async () => {
    expect(await submit(PAIR, flow(CLAIM, null))).toBe(201);
    expect(toSeats()[0]!.text).toContain('What they say is right: It should not be listed');
  });

  it('a replay of the same report sends nothing and records duplicates', async () => {
    await submit(PAIR, flow());
    expect(toSeats()).toHaveLength(2);
    await emailPairReportSubmittedToOwner(cronCtx(), t.db as Db, await reportRow(), {
      fetchSeatEmails,
    });
    expect(toSeats()).toHaveLength(2);
    const outcomes = (await ledger('pair-report-submitted-owner')).map((r) => r.outcome);
    expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(2);
  });
});

describe('a report that does not reach the owner sends no seat email (AECI-2229)', () => {
  it('an existence report goes to AECi only', async () => {
    expect(await submit(PAIR, { kind: 'existence', reason: 'Rivets stopped offering it.' })).toBe(
      201,
    );
    expect((await reportRow()).routedTo).toBe('aeci');
    expect(toAeci()).toHaveLength(1);
    expect(toSeats()).toEqual([]);
    expect(await ledger('pair-report-submitted-owner')).toEqual([]);
  });

  it('a data flow report on an unclaimed pair goes to AECi only', async () => {
    expect(await submit(PAIR_SEEDED, flow(CLAIM_SEEDED))).toBe(201);
    expect((await reportRow()).routedTo).toBe('aeci');
    expect(toAeci()).toHaveLength(1);
    expect(toSeats()).toEqual([]);
  });

  it('a refused report sends nothing', async () => {
    // The direction on record: 422 CONTEST_NO_CHANGE, nothing written.
    expect(await submit(PAIR, flow(CLAIM, 'a_to_b'))).toBe(422);
    expect(sent()).toEqual([]);
  });

  it('a duplicate report sends nothing more', async () => {
    await submit(PAIR, flow());
    expect(toSeats()).toHaveLength(2);
    expect(await submit(PAIR, flow())).toBe(409);
    expect(toSeats()).toHaveLength(2);
  });

  it('the sender ignores a row that is not routed to an owner', async () => {
    await submit(PAIR, { kind: 'existence', reason: 'Rivets stopped offering it.' });
    fetchSpy.mockClear();
    await emailPairReportSubmittedToOwner(cronCtx(), t.db as Db, await reportRow(), {
      fetchSeatEmails,
    });
    expect(sent()).toEqual([]);
    expect(fetchSeatEmails).not.toHaveBeenCalled();
  });
});
