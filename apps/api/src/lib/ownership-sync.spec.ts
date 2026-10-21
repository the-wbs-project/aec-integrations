/**
 * The ownership message (AECI-1418, `REVIEW_APP_PROMOTE_API.md` §4d): the record the
 * consumer builds from D1, every delivery outcome, and the producer. Real SQLite via
 * the D1 harness; the receiver is a mock `fetch`, never the review app.
 */

import { OwnershipRecordSchema, type OwnershipRecord } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  connectorEvidencedPairs,
  integrations,
  ownershipSyncDeliveries,
  productProposals,
  productVendors,
  products,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { logToPosthog, submitCount } from '../posthog';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import {
  buildOwnershipRecord,
  classifyStatus,
  deliverOwnershipSync,
  enqueueOwnershipSync,
  OWNERSHIP_SYNC_MAX_RETRIES,
  retryDelaySeconds,
} from './ownership-sync';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  submitCount: vi.fn(),
}));

const drained = vi.hoisted(() => [] as Response[]);
vi.mock('@aeci/shared/response-drain', async (importActual) => {
  const actual = await importActual<typeof import('@aeci/shared/response-drain')>();
  return {
    discardResponseBody: (res: Response) => {
      drained.push(res);
      actual.discardResponseBody(res);
    },
  };
});

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const V = u(1); // the vendor the record is about, owned
const W = u(2); // co-owns P_SHARED
const X = u(3); // unrelated vendor
const P_MINE = u(10);
const P_SHARED = u(11);
const P_OTHER = u(12); // X's
const P_CONNECTOR = u(13); // X's, used as a connector
const P_FAR = u(14); // X's
const I_SOURCE = u(20); // P_MINE → P_OTHER
const I_TARGET = u(21); // P_OTHER → P_SHARED
const I_POWERED = u(22); // P_OTHER → P_FAR, powered by P_MINE: excluded (Q2)
const I_UNRELATED = u(23); // P_OTHER → P_FAR
const E_ENDPOINT = u(30); // a = P_MINE, connector P_CONNECTOR
const E_CONNECTOR = u(31); // connector P_MINE only: excluded (Q2)
const PROPOSAL_OPEN = u(40);
const PROPOSAL_ACCEPTED = u(41);

const OWNED_AT = '2026-10-19T00:00:00.000Z';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const URL_BASE = 'https://review.example/api/ownership';

let t: TestDb;

beforeEach(async () => {
  drained.length = 0;
  vi.mocked(submitCount).mockClear();
  vi.mocked(logToPosthog).mockClear();
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: V, slug: 'bentley', companyName: 'Bentley', ownedAt: OWNED_AT },
    { id: W, slug: 'trimble', companyName: 'Trimble' },
    { id: X, slug: 'autodesk', companyName: 'Autodesk' },
  ]);
  await t.db.insert(products).values(
    [P_MINE, P_SHARED, P_OTHER, P_CONNECTOR, P_FAR].map((id, i) => ({
      id,
      slug: `p-${i}`,
      name: `P ${i}`,
    })),
  );
  await t.db.insert(productVendors).values([
    { productId: P_MINE, vendorId: V, isPrimary: true },
    { productId: P_SHARED, vendorId: V, isPrimary: true },
    { productId: P_SHARED, vendorId: W, isPrimary: false },
    { productId: P_OTHER, vendorId: X, isPrimary: true },
    { productId: P_CONNECTOR, vendorId: X, isPrimary: true },
    { productId: P_FAR, vendorId: X, isPrimary: true },
  ]);
  await t.db.insert(integrations).values([
    { id: I_SOURCE, sourceProductId: P_MINE, targetProductId: P_OTHER },
    { id: I_TARGET, sourceProductId: P_OTHER, targetProductId: P_SHARED },
    {
      id: I_POWERED,
      sourceProductId: P_OTHER,
      targetProductId: P_FAR,
      poweredByProductId: P_MINE,
    },
    { id: I_UNRELATED, sourceProductId: P_OTHER, targetProductId: P_FAR },
  ]);
  await t.db.insert(connectorEvidencedPairs).values([
    { id: E_ENDPOINT, connectorProductId: P_CONNECTOR, productAId: P_MINE, productBId: P_OTHER },
    { id: E_CONNECTOR, connectorProductId: P_MINE, productAId: P_OTHER, productBId: P_FAR },
  ]);
  await t.db.insert(productProposals).values([
    { id: PROPOSAL_OPEN, vendorId: V, ref: 'p:recOpen1', payload: {}, proposedAt: OWNED_AT },
    {
      id: PROPOSAL_ACCEPTED,
      vendorId: V,
      ref: 'p:recDone1',
      payload: {},
      proposedAt: OWNED_AT,
      decision: 'accepted',
      decidedAt: '2026-10-20T00:00:00.000Z',
      createdProductId: P_MINE,
    },
  ]);
});
afterEach(() => t.dispose());

describe('buildOwnershipRecord', () => {
  it('lists the Q2 set for an owned vendor: endpoints count, the connector side does not', async () => {
    const record = (await buildOwnershipRecord(t.db, V, 'claim_approved', NOW))!;
    expect(OwnershipRecordSchema.parse(record)).toEqual(record);
    expect(record).toMatchObject({
      vendorId: V,
      owner: 'vendor',
      ownedAt: OWNED_AT,
      version: NOW.getTime(),
      asOf: NOW.toISOString(),
      reason: 'claim_approved',
    });
    expect(record.products).toEqual([
      { id: P_MINE, owner: 'vendor' },
      { id: P_SHARED, owner: 'vendor' },
    ]);
    expect(record.integrations).toEqual([
      { id: I_SOURCE, table: 'integrations', owner: 'vendor' },
      { id: I_TARGET, table: 'integrations', owner: 'vendor' },
      { id: E_ENDPOINT, table: 'connector_evidenced_pairs', owner: 'vendor' },
    ]);
    expect(record.proposals).toEqual([
      { id: PROPOSAL_OPEN, ref: 'p:recOpen1', state: 'open', decidedAt: null, productId: null },
      {
        id: PROPOSAL_ACCEPTED,
        ref: 'p:recDone1',
        state: 'accepted',
        decidedAt: '2026-10-20T00:00:00.000Z',
        productId: P_MINE,
      },
    ]);
  });

  it('a returned vendor is aeci-owned, and a product co-owned with an owned vendor stays vendor-owned', async () => {
    await t.db.update(vendors).set({ ownedAt: null }).where(eq(vendors.id, V));
    await t.db.update(vendors).set({ ownedAt: OWNED_AT }).where(eq(vendors.id, W));
    const record = (await buildOwnershipRecord(t.db, V, 'records_returned', NOW))!;
    expect(OwnershipRecordSchema.safeParse(record).success).toBe(true);
    expect(record.owner).toBe('aeci');
    expect(record.ownedAt).toBeNull();
    expect(record.products).toEqual([
      { id: P_MINE, owner: 'aeci' },
      { id: P_SHARED, owner: 'vendor' },
    ]);
    expect(record.integrations).toEqual([
      { id: I_SOURCE, table: 'integrations', owner: 'aeci' },
      // Its target is P_SHARED, which W still owns.
      { id: I_TARGET, table: 'integrations', owner: 'vendor' },
      { id: E_ENDPOINT, table: 'connector_evidenced_pairs', owner: 'aeci' },
    ]);
  });

  it('returns null for a vendor that does not exist', async () => {
    expect(await buildOwnershipRecord(t.db, u(99), 'backfill', NOW)).toBeNull();
  });
});

describe('classifyStatus and retryDelaySeconds', () => {
  it.each([
    [200, 'delivered'],
    [204, 'delivered'],
    [409, 'stale'],
    [408, 'retry'],
    [429, 'retry'],
    [500, 'retry'],
    [503, 'retry'],
    [400, 'permanent'],
    [401, 'permanent'],
    [404, 'permanent'],
    [422, 'permanent'],
  ])('%i → %s', (status, outcome) => {
    expect(classifyStatus(status)).toBe(outcome);
  });

  it('backs off 30 s, doubling, capped at 15 minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(retryDelaySeconds)).toEqual([
      30, 60, 120, 240, 480, 900, 900,
    ]);
  });
});

// ── Delivery ──────────────────────────────────────────────────────────────────

const CONFIGURED: Env = {
  ...TEST_ENV,
  REVIEW_APP_OWNERSHIP_URL: URL_BASE,
  REVIEW_APP_OWNERSHIP_TOKEN: 'tok-review',
};

function fakeMessage(body: unknown, attempts = 1) {
  return {
    id: 'msg-1',
    timestamp: NOW,
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<unknown> & {
    ack: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  };
}

const body = (reason = 'claim_approved') => ({
  vendorId: V,
  reason,
  enqueuedAt: NOW.toISOString(),
});

async function deliver(
  respond: () => Promise<Response>,
  opts: { env?: Env; attempts?: number; msgBody?: unknown } = {},
) {
  const fetchMock = vi.fn(respond);
  const message = fakeMessage(opts.msgBody ?? body(), opts.attempts);
  await deliverOwnershipSync(opts.env ?? CONFIGURED, fakeExecutionContext(), message, {
    fetch: fetchMock as unknown as typeof fetch,
    now: () => NOW,
    dbFor: t.factory,
  });
  const ledger = await t.db.select().from(ownershipSyncDeliveries);
  return { fetchMock, message, ledger };
}

const deliveryOutcomes = () =>
  vi
    .mocked(submitCount)
    .mock.calls.filter((c) => c[3] === 'aeci.ownership_sync.delivery')
    .map((c) => c[5]);

describe('deliverOwnershipSync', () => {
  it('PUTs the whole record with the bearer token, drains the body, acks and records it', async () => {
    const res = new Response('{"ok":true}', { status: 200 });
    const { fetchMock, message, ledger } = await deliver(async () => res);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${URL_BASE}/vendors/${V}`);
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-review');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const sent = JSON.parse(init.body as string) as OwnershipRecord;
    expect(OwnershipRecordSchema.parse(sent).integrations).toHaveLength(3);

    expect(drained).toEqual([res]);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(ledger).toEqual([
      expect.objectContaining({
        vendorId: V,
        reason: 'claim_approved',
        messageId: 'msg-1',
        attempt: 1,
        outcome: 'delivered',
        httpStatus: 200,
        recordVersion: NOW.getTime(),
        owner: 'vendor',
        productCount: 2,
        integrationCount: 3,
        error: null,
      }),
    ]);
    expect(deliveryOutcomes()).toEqual([['outcome:delivered', 'reason:claim_approved']]);
  });

  it('a 409 is the receiver holding a newer version: success, acked', async () => {
    const res = new Response('stale', { status: 409 });
    const { message, ledger } = await deliver(async () => res);
    expect(drained).toEqual([res]);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(ledger[0]).toMatchObject({ outcome: 'stale', httpStatus: 409 });
  });

  it.each([408, 429, 500, 503])(
    'a %i is retried with backoff, drained and recorded',
    async (status) => {
      const res = new Response('busy', { status });
      const { message, ledger } = await deliver(async () => res, { attempts: 2 });
      expect(drained).toEqual([res]);
      expect(message.ack).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
      expect(ledger[0]).toMatchObject({ outcome: 'retry', httpStatus: status, attempt: 2 });
    },
  );

  it('a network error is retried and recorded with no status', async () => {
    const { message, ledger } = await deliver(async () => {
      throw new TypeError('connection reset');
    });
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(ledger[0]).toMatchObject({
      outcome: 'retry',
      httpStatus: null,
      error: 'network: connection reset',
    });
  });

  it('a timeout is retried and named', async () => {
    const { message, ledger } = await deliver(async () => {
      throw new DOMException('timed out', 'TimeoutError');
    });
    expect(message.retry).toHaveBeenCalledOnce();
    expect(ledger[0]!.error).toMatch(/^timeout after/);
  });

  it('the last allowed attempt is exhausted: acked, recorded, and logged as an error', async () => {
    const res = new Response('down', { status: 502 });
    const { message, ledger } = await deliver(async () => res, {
      attempts: OWNERSHIP_SYNC_MAX_RETRIES + 1,
    });
    expect(drained).toEqual([res]);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(ledger[0]).toMatchObject({ outcome: 'exhausted', httpStatus: 502 });
    expect(vi.mocked(logToPosthog).mock.calls.some((c) => c[3].level === 'error')).toBe(true);
  });

  it.each([400, 401, 404, 422])(
    'a %i is permanent: drained, acked, never retried',
    async (status) => {
      const res = new Response('{"error":"no"}', { status });
      const { message, ledger } = await deliver(async () => res);
      expect(drained).toEqual([res]);
      expect(message.ack).toHaveBeenCalledOnce();
      expect(message.retry).not.toHaveBeenCalled();
      expect(ledger[0]).toMatchObject({ outcome: 'permanent', httpStatus: status });
    },
  );

  it.each([
    ['URL', { ...TEST_ENV, REVIEW_APP_OWNERSHIP_TOKEN: 'tok' }],
    ['token', { ...TEST_ENV, REVIEW_APP_OWNERSHIP_URL: URL_BASE }],
  ])('without the %s it acks, records unconfigured, counts it and warns', async (_, env) => {
    const { fetchMock, message, ledger } = await deliver(
      async () => new Response(null, { status: 200 }),
      { env: env as Env },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(ledger).toEqual([
      expect.objectContaining({ outcome: 'unconfigured', httpStatus: null, recordVersion: null }),
    ]);
    expect(deliveryOutcomes()).toEqual([['outcome:unconfigured', 'reason:claim_approved']]);
    expect(vi.mocked(logToPosthog).mock.calls[0]![3]).toMatchObject({ level: 'warn' });
  });

  it('a vendor that no longer exists is acked with nothing sent', async () => {
    const { fetchMock, message, ledger } = await deliver(
      async () => new Response(null, { status: 200 }),
      { msgBody: { ...body(), vendorId: u(99) } },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(ledger[0]).toMatchObject({ vendorId: u(99), outcome: 'vendor_missing' });
  });

  it('a D1 read failure retries, and logs an error on the last attempt', async () => {
    const message = fakeMessage(body(), OWNERSHIP_SYNC_MAX_RETRIES + 1);
    const fetchMock = vi.fn();
    await deliverOwnershipSync(CONFIGURED, fakeExecutionContext(), message, {
      fetch: fetchMock as unknown as typeof fetch,
      now: () => NOW,
      dbFor: () => {
        throw new Error('no DB');
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
    expect(deliveryOutcomes()).toEqual([['outcome:read_failed', 'reason:claim_approved']]);
    expect(vi.mocked(logToPosthog).mock.calls[0]![3]).toMatchObject({ level: 'error' });
  });

  it('an invalid message body is acked and counted, with no ledger row', async () => {
    const { fetchMock, message, ledger } = await deliver(
      async () => new Response(null, { status: 200 }),
      { msgBody: { job: 'stats' } },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(ledger).toEqual([]);
    expect(deliveryOutcomes()).toEqual([['outcome:invalid']]);
  });
});

// ── Producer ──────────────────────────────────────────────────────────────────

describe('enqueueOwnershipSync', () => {
  const target = (queue?: unknown) => ({
    env: { ...TEST_ENV, OWNERSHIP_SYNC_QUEUE: queue } as Env,
    ctx: fakeExecutionContext(),
    request: new Request('http://localhost/x'),
  });

  it('sends one message for one vendor, with no ownership data in it', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const sendBatch = vi.fn();
    await enqueueOwnershipSync(target({ send, sendBatch }), [V], 'claim_approved', NOW);
    expect(send).toHaveBeenCalledWith({
      vendorId: V,
      reason: 'claim_approved',
      enqueuedAt: NOW.toISOString(),
    });
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it('sends several vendors as one sendBatch', async () => {
    const send = vi.fn();
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    await enqueueOwnershipSync(target({ send, sendBatch }), [V, W, V], 'backfill', NOW);
    expect(send).not.toHaveBeenCalled();
    expect(sendBatch).toHaveBeenCalledOnce();
    expect(sendBatch.mock.calls[0]![0]).toHaveLength(2);
  });

  it('a send failure is swallowed, counted and warned', async () => {
    const send = vi.fn().mockRejectedValue(new Error('queue down'));
    await expect(
      enqueueOwnershipSync(target({ send, sendBatch: vi.fn() }), [V], 'records_returned', NOW),
    ).resolves.toBeUndefined();
    expect(vi.mocked(submitCount).mock.calls.at(-1)![5]).toEqual([
      'outcome:failed',
      'reason:records_returned',
    ]);
    expect(vi.mocked(logToPosthog)).toHaveBeenCalled();
  });

  it('an unbound queue is counted and warned, not silent', async () => {
    await enqueueOwnershipSync(target(undefined), [V], 'seat_provisioned', NOW);
    expect(vi.mocked(submitCount).mock.calls.at(-1)![5]).toEqual([
      'outcome:unbound',
      'reason:seat_provisioned',
    ]);
    expect(vi.mocked(logToPosthog)).toHaveBeenCalled();
  });
});
