/**
 * The day-of notice when the first in-force versions take effect (AECI-1870,
 * `legal-first-effective`, rulings 28 and 68) on the in-memory D1 harness.
 *
 * INVARIANTS. None should be deleted without reopening the decision behind it:
 *
 *   1. **Nothing before the moment**, from the job or the consumer.
 *   2. **One email per account per moment**, keyed `legal-first-effective:{day}:{profileId}`.
 *      A person who is both a reader and a vendor seat is one profile, so one entry.
 *   3. **The marker and its audit row land in one batch**, and a second run sends nothing.
 *   4. **Only a first in-force version counts**, and never more than 7 days late.
 *   5. **Banned accounts and bare billing emails get nothing.**
 */

import { legalEffectiveAtMs, type LegalInForceMaps } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, legalVersions, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import type { EmailOutcome, LegalFirstEffectiveSubject } from './email';
import {
  LEGAL_FIRST_EFFECTIVE_ENQUEUED_ACTION,
  deliverLegalFirstEffectiveNotice,
  fanOutFirstEffectiveNotice,
  isLegalFirstEffectiveMessage,
  legalFirstEffectiveDedupeKey,
  runLegalFirstEffectiveNotice,
  type LegalFirstEffectiveMessage,
} from './legal-first-effective-notice';
import { LEGAL_NOTICE_MAX_RETRIES, type FetchSeatEmailsResult } from './legal-notice';
import type { LegalVersionRow } from './legal-versions';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DAY = '2027-01-15';
const MOMENT = legalEffectiveAtMs(DAY);
const AT_MOMENT = new Date(MOMENT);
const DAY_MS = 86_400_000;

/** Every document still a draft, and the four below upcoming on DAY. */
const MAPS: LegalInForceMaps = {
  agreementCurrent: { vendor_terms: '1.3', managed_plan: '1.1' },
  agreementUpcoming: { vendor_terms: { version: '1.4', effectiveOn: DAY } },
  agreementEffectiveOn: {
    vendor_terms: { '1.0': null, '1.1': null, '1.2': null, '1.3': null },
    managed_plan: { '1.0': null, '1.1': null },
  },
  readerCurrent: { terms: '1.1', privacy: '1.1' },
  readerUpcoming: {
    terms: { version: '1.2', effectiveOn: DAY },
    privacy: { version: '1.2', effectiveOn: DAY },
  },
  readerEffectiveOn: { terms: { '1.0': null, '1.1': null }, privacy: { '1.0': null, '1.1': null } },
  policyCurrent: { listing_accuracy: '1.0', review_guidelines: '1.0' },
  policyUpcoming: {},
};

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => {
  t.dispose();
  vi.restoreAllMocks();
});

async function seedVersion(
  id: number,
  document: string,
  version: string,
  over: Partial<LegalVersionRow> = {},
): Promise<LegalVersionRow> {
  const row: LegalVersionRow = {
    id: u(id),
    document,
    version,
    effectiveAt: MOMENT,
    summaryJson: JSON.stringify(['A change.']),
    material: true,
    requiresAcceptance: false,
    expeditedReason: null,
    pdfKey: `legal/${document}/v${version}.pdf`,
    pdfSha256: '0'.repeat(64),
    pdfBytes: 1,
    publishedBy: u(800),
    publishedAt: '2026-12-01T00:00:00.000Z',
    noticeEnqueuedAt: '2026-12-01T00:00:01.000Z',
    noticeVendorCount: 1,
    firstEffectiveNoticeEnqueuedAt: null,
    ...over,
  };
  await t.db.insert(legalVersions).values(row);
  return row;
}

async function seedFirst() {
  return [
    await seedVersion(901, 'vendor_terms', '1.4'),
    await seedVersion(902, 'terms', '1.2'),
    await seedVersion(903, 'privacy', '1.2'),
  ];
}

async function seedAccounts() {
  await t.db.insert(vendors).values({ id: u(50), slug: 'bentley', companyName: 'Bentley' });
  await t.db.insert(profiles).values([
    { id: u(1), role: 'reviewer' },
    { id: u(2), role: 'reviewer', bannedAt: '2026-01-01T00:00:00.000Z' },
    // One person, both a reader and the vendor's owner seat: one profile.
    { id: u(3), role: 'vendor_admin', vendorId: u(50), seatOwner: true },
    { id: u(4), role: 'vendor_admin', vendorId: u(50), seatOwner: false },
  ]);
}

const target = (queue: unknown) => ({
  env: { LEGAL_NOTICE_QUEUE: queue } as unknown as Env,
  ctx: { waitUntil: () => {} },
  request: new Request('https://aeci-api/x'),
});

function queueSpy() {
  const sendBatch = vi.fn(async (_messages: { body: LegalFirstEffectiveMessage }[]) => {});
  const bodies = () => sendBatch.mock.calls.flatMap(([messages]) => messages.map((m) => m.body));
  return { queue: { sendBatch }, sendBatch, bodies };
}

const markers = async () =>
  (await t.db.select().from(legalVersions))
    .map((r) => [r.document, r.firstEffectiveNoticeEnqueuedAt])
    .sort();

const audits = async () =>
  (await t.db.select().from(auditLog)).filter(
    (a) => a.action === LEGAL_FIRST_EFFECTIVE_ENQUEUED_ACTION,
  );

describe('the job', () => {
  it('queues nothing before the moment', async () => {
    await seedAccounts();
    await seedFirst();
    const q = queueSpy();
    const result = await runLegalFirstEffectiveNotice(
      target(q.queue),
      t.db,
      new Date(MOMENT - 1),
      MAPS,
    );
    expect(result.moments).toEqual([]);
    expect(q.sendBatch).not.toHaveBeenCalled();
    expect((await markers()).every(([, m]) => m === null)).toBe(true);
  });

  it('at the moment: one message set for the whole moment, then the marker with its audit rows', async () => {
    await seedAccounts();
    const rows = await seedFirst();
    const q = queueSpy();
    const result = await runLegalFirstEffectiveNotice(target(q.queue), t.db, AT_MOMENT, MAPS);
    expect(result.moments).toEqual([
      {
        effectiveOn: DAY,
        documents: ['vendor_terms', 'terms', 'privacy'],
        accounts: 3,
        queued: 3,
        outcome: 'enqueued',
        marked: 3,
      },
    ]);
    expect(q.sendBatch).toHaveBeenCalledTimes(1);
    const [body] = q.bodies();
    expect(body).toMatchObject({
      kind: 'first-effective',
      effectiveAt: MOMENT,
      profileIds: [u(1), u(3), u(4)],
    });
    expect([...body!.legalVersionIds].sort()).toEqual(rows.map((r) => r.id).sort());
    expect(isLegalFirstEffectiveMessage(body)).toBe(true);

    const stamp = AT_MOMENT.toISOString();
    expect(await markers()).toEqual([
      ['privacy', stamp],
      ['terms', stamp],
      ['vendor_terms', stamp],
    ]);
    const written = await audits();
    expect(written.map((a) => a.entityId).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(written[0]).toMatchObject({ actorType: 'system', entityType: 'legal_version' });
  });

  it('a second run sees the marker and queues nothing', async () => {
    await seedAccounts();
    await seedFirst();
    await runLegalFirstEffectiveNotice(target(queueSpy().queue), t.db, AT_MOMENT, MAPS);
    const q = queueSpy();
    const again = await runLegalFirstEffectiveNotice(
      target(q.queue),
      t.db,
      new Date(MOMENT + DAY_MS),
      MAPS,
    );
    expect(again.moments).toEqual([]);
    expect(q.sendBatch).not.toHaveBeenCalled();
    expect(await audits()).toHaveLength(3);
  });

  it('never sends a notice more than 7 days late, and counts it stale', async () => {
    await seedAccounts();
    await seedFirst();
    const q = queueSpy();
    const result = await runLegalFirstEffectiveNotice(
      target(q.queue),
      t.db,
      new Date(MOMENT + 7 * DAY_MS),
      MAPS,
    );
    expect(result).toEqual({ moments: [], stale: 3 });
    expect(q.sendBatch).not.toHaveBeenCalled();
  });

  it('still sends 6 days late', async () => {
    await seedAccounts();
    await seedFirst();
    const q = queueSpy();
    const result = await runLegalFirstEffectiveNotice(
      target(q.queue),
      t.db,
      new Date(MOMENT + 6 * DAY_MS),
      MAPS,
    );
    expect(result.moments.map((m) => m.outcome)).toEqual(['enqueued']);
  });

  it('sends nothing for a version that is not the first in force', async () => {
    await seedAccounts();
    const LATER_DAY = '2027-06-01';
    const later = legalEffectiveAtMs(LATER_DAY);
    // Terms 1.2 took effect on DAY, so 1.3 on LATER_DAY is a later version.
    await seedVersion(902, 'terms', '1.2', { firstEffectiveNoticeEnqueuedAt: 'x' });
    await seedVersion(904, 'terms', '1.3', { effectiveAt: later });
    const maps: LegalInForceMaps = {
      ...MAPS,
      readerCurrent: { terms: '1.2', privacy: '1.1' },
      readerUpcoming: { terms: { version: '1.3', effectiveOn: LATER_DAY } },
      readerEffectiveOn: {
        terms: { '1.0': null, '1.1': null, '1.2': DAY },
        privacy: { '1.0': null, '1.1': null },
      },
    };
    const q = queueSpy();
    const result = await runLegalFirstEffectiveNotice(target(q.queue), t.db, new Date(later), maps);
    expect(result).toEqual({ moments: [], stale: 0 });
    expect(q.sendBatch).not.toHaveBeenCalled();
  });

  it('a fan-out that did not finish leaves the marker unset, so the next run retries', async () => {
    await seedAccounts();
    await seedFirst();
    const result = await runLegalFirstEffectiveNotice(target(undefined), t.db, AT_MOMENT, MAPS);
    expect(result.moments).toMatchObject([{ outcome: 'failed', failure: 'unbound', marked: 0 }]);
    expect((await markers()).every(([, m]) => m === null)).toBe(true);
    expect(await audits()).toHaveLength(0);
  });
});

describe('the fan-out', () => {
  it('excludes banned accounts, lists each profile once, and uses sendBatch in chunks of 25', async () => {
    await t.db.insert(vendors).values({ id: u(50), slug: 'bentley', companyName: 'Bentley' });
    await t.db
      .insert(profiles)
      .values([
        ...Array.from({ length: 59 }, (_, i) => ({ id: u(100 + i), role: 'reviewer' })),
        { id: u(300), role: 'reviewer', bannedAt: '2026-01-01T00:00:00.000Z' },
        { id: u(301), role: 'vendor_admin', vendorId: u(50), seatOwner: true },
      ]);
    const q = queueSpy();
    const fan = await fanOutFirstEffectiveNotice(
      target(q.queue),
      t.db,
      { effectiveAtMs: MOMENT, legalVersionIds: [u(901)] },
      AT_MOMENT,
    );
    expect(fan).toEqual({ total: 60, queued: 60, complete: true, failure: null });
    expect(q.sendBatch).toHaveBeenCalledTimes(1);
    const ids = q.bodies().flatMap((b) => b.profileIds);
    expect(q.bodies().map((b) => b.profileIds.length)).toEqual([25, 25, 10]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(u(300));
    expect(ids).toContain(u(301));
  });

  it('reports a sendBatch failure as incomplete', async () => {
    await seedAccounts();
    const fan = await fanOutFirstEffectiveNotice(
      target({ sendBatch: vi.fn(async () => Promise.reject(new Error('throttled'))) }),
      t.db,
      { effectiveAtMs: MOMENT, legalVersionIds: [u(901)] },
      AT_MOMENT,
    );
    expect(fan).toMatchObject({ complete: false, failure: 'send_batch', queued: 0 });
  });
});

// ─── The consumer ──────────────────────────────────────────────────────────────

const emails: FetchSeatEmailsResult = async (_env, ids) => ({
  available: true,
  reason: 'ok',
  emails: new Map(ids.map((id) => [id, `p-${id.slice(-3)}@example.com`])),
});

function fakeMessage(body: unknown, attempts = 1) {
  return {
    id: 'msg-1',
    timestamp: new Date(),
    body,
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<unknown> & {
    ack: ReturnType<typeof vi.fn>;
    retry: ReturnType<typeof vi.fn>;
  };
}

/** A send that records each call and answers like the ledger: a held key is a duplicate. */
function ledgerSend(outcome: () => EmailOutcome = () => 'sent') {
  const held = new Set<string>();
  const calls: LegalFirstEffectiveSubject[] = [];
  const send = vi.fn(async (_c: unknown, opts: LegalFirstEffectiveSubject) => {
    calls.push(opts);
    if (held.has(opts.dedupeKey)) return 'duplicate' as const;
    const result = outcome();
    if (result !== 'failed') held.add(opts.dedupeKey);
    return result;
  });
  return { calls, send };
}

async function deliver(
  legalVersionIds: string[],
  profileIds: string[],
  opts: {
    send?: ReturnType<typeof ledgerSend>;
    now?: Date;
    env?: Partial<Env>;
    fetchSeatEmails?: FetchSeatEmailsResult;
    attempts?: number;
  } = {},
) {
  const spy = opts.send ?? ledgerSend();
  const message = fakeMessage(
    {
      kind: 'first-effective',
      effectiveAt: MOMENT,
      legalVersionIds,
      profileIds,
      enqueuedAt: AT_MOMENT.toISOString(),
    },
    opts.attempts,
  );
  await deliverLegalFirstEffectiveNotice(
    { PUBLIC_SITE_URL: 'https://www.aecintegrations.com', ...opts.env } as Env,
    fakeExecutionContext(),
    message,
    {
      dbFor: t.factory,
      fetchSeatEmails: opts.fetchSeatEmails ?? emails,
      send: spy.send,
      now: () => opts.now ?? AT_MOMENT,
    },
  );
  return { message, ...spy };
}

describe('the consumer', () => {
  it('sends one email per account, keyed per moment and profile, and acks', async () => {
    await seedAccounts();
    const rows = await seedFirst();
    const { message, calls } = await deliver(
      rows.map((r) => r.id),
      [u(1), u(3), u(4)],
    );
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.dedupeKey)).toEqual([
      `legal-first-effective:${DAY}:${u(1)}`,
      `legal-first-effective:${DAY}:${u(3)}`,
      `legal-first-effective:${DAY}:${u(4)}`,
    ]);
    expect(legalFirstEffectiveDedupeKey(DAY, 'p')).toBe('legal-first-effective:2027-01-15:p');
    expect(calls[0]!.effectiveDay).toBe(DAY);
    expect(calls[0]!.documents.map((d) => `${d.document}@${d.version}`).sort()).toEqual([
      'privacy@1.2',
      'terms@1.2',
      'vendor_terms@1.4',
    ]);
  });

  it('marks only the owner seat as an owner', async () => {
    await seedAccounts();
    const rows = await seedFirst();
    const { calls } = await deliver(
      rows.map((r) => r.id),
      [u(1), u(3), u(4)],
    );
    expect(calls.map((c) => [c.to, c.ownerSeat])).toEqual([
      ['p-001@example.com', false],
      ['p-003@example.com', true],
      ['p-004@example.com', false],
    ]);
  });

  it('a second delivery of the same message sends nothing new', async () => {
    await seedAccounts();
    const rows = await seedFirst();
    const send = ledgerSend();
    await deliver(
      rows.map((r) => r.id),
      [u(1)],
      { send },
    );
    const second = await deliver(
      rows.map((r) => r.id),
      [u(1)],
      { send },
    );
    expect(second.message.ack).toHaveBeenCalledTimes(1);
    expect(await Promise.all(send.send.mock.results.map((r) => r.value))).toEqual([
      'sent',
      'duplicate',
    ]);
  });

  it('refuses before the moment: nothing sent, retried', async () => {
    await seedAccounts();
    const rows = await seedFirst();
    const { message, calls } = await deliver(
      rows.map((r) => r.id),
      [u(1)],
      { now: new Date(MOMENT - 1) },
    );
    expect(calls).toHaveLength(0);
    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('skips an account banned since the fan-out', async () => {
    await seedAccounts();
    const rows = await seedFirst();
    const { calls, message } = await deliver(
      rows.map((r) => r.id),
      [u(1), u(2)],
    );
    expect(calls.map((c) => c.to)).toEqual(['p-001@example.com']);
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it('retries the whole message on an Auth outage and sends nothing', async () => {
    await seedAccounts();
    const rows = await seedFirst();
    const { calls, message } = await deliver(
      rows.map((r) => r.id),
      [u(1)],
      {
        fetchSeatEmails: async () => ({ available: false, reason: 'error', emails: new Map() }),
      },
    );
    expect(calls).toHaveLength(0);
    expect(message.retry).toHaveBeenCalledTimes(1);
  });

  it('retries a failed send; the retry reaches only the account that failed', async () => {
    await seedAccounts();
    const rows = await seedFirst();
    let n = 0;
    const send = ledgerSend(() => (++n === 2 ? 'failed' : 'sent'));
    const first = await deliver(
      rows.map((r) => r.id),
      [u(1), u(3)],
      { send },
    );
    expect(first.message.retry).toHaveBeenCalledTimes(1);
    const second = await deliver(
      rows.map((r) => r.id),
      [u(1), u(3)],
      {
        send,
        attempts: 2,
      },
    );
    expect(second.message.ack).toHaveBeenCalledTimes(1);
    expect(await Promise.all(send.send.mock.results.map((r) => r.value))).toEqual([
      'sent',
      'failed',
      'duplicate',
      'sent',
    ]);
  });

  it('retries with no site URL, and drops a message whose row is gone', async () => {
    await seedAccounts();
    const rows = await seedFirst();
    const noSite = await deliver(
      rows.map((r) => r.id),
      [u(1)],
      {
        env: { PUBLIC_SITE_URL: '' },
      },
    );
    expect(noSite.calls).toHaveLength(0);
    expect(noSite.message.retry).toHaveBeenCalledTimes(1);
    const gone = await deliver([u(999)], [u(1)]);
    expect(gone.calls).toHaveLength(0);
    expect(gone.message.ack).toHaveBeenCalledTimes(1);
  });

  it('drops a malformed message', async () => {
    const message = fakeMessage({ kind: 'first-effective', profileIds: [] });
    await deliverLegalFirstEffectiveNotice({} as Env, fakeExecutionContext(), message, {
      dbFor: t.factory,
    });
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(LEGAL_NOTICE_MAX_RETRIES).toBe(3);
  });
});
