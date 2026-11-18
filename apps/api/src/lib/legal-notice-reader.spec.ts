/**
 * The account notice of a Terms of Service or Privacy Policy version (AECI-1637,
 * `legal-account-change`) on the in-memory D1 harness.
 *
 * INVARIANTS. None should be deleted without reopening the decision behind it:
 *
 *   1. **The audience** is every unbanned account, vendor seats included, less the
 *      accounts already delivered; 25 accounts per message, 100 messages per send.
 *   2. **A company message with no `kind` still parses** and reaches the company path, so
 *      messages queued before this change are delivered.
 *   3. **One key per account**: `legal-account-change:{document}:{version}:{profileId}`.
 *   4. **An Auth outage retries the whole message** and sends nothing.
 *   5. **A late message sends nothing**, and **a PDF that no longer matches sends nothing**.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/client';
import {
  legalNoticeReaderDeliveries,
  legalVersions,
  notificationSends,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { logToPosthog } from '../posthog';
import { makeTestDb, type TestDb } from '../test/d1';
import { makeFakeR2Bucket } from '../test/fake-r2';
import { fakeExecutionContext } from '../test/helpers';
import {
  sendLegalTermsChangeEmail,
  type EmailOutcome,
  type LegalTermsChangeSubject,
} from './email';
import {
  D1_MAX_BOUND_PARAMS,
  DELIVERY_UPSERT_CHUNK,
  deliverLegalNotice,
  fanOutReaderLegalNotice,
  legalNoticeAccountIds,
  legalReaderClosingFor,
  legalReaderNoticeDedupeKey,
  LEGAL_NOTICE_MAX_RETRIES,
  loadReaderNoticeDeliveries,
  readerDeliveryUpsertStatement,
  READER_NOTICE_CHUNK,
  type FetchSeatEmailsResult,
} from './legal-notice';
import { sha256OfBytes, type LegalVersionRow } from './legal-versions';
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

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-11-20T00:00:00.000Z');
const PDF = new TextEncoder().encode('%PDF-1.7\nterms of service\n%%EOF\n');

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  vi.mocked(logToPosthog).mockClear();
});
afterEach(() => {
  t.dispose();
  vi.restoreAllMocks();
});

async function seedAccounts(n: number, from = 1, over: { banned?: boolean } = {}) {
  const ids = Array.from({ length: n }, (_, i) => u(from + i));
  await t.db.insert(profiles).values(
    ids.map((id) => ({
      id,
      role: 'reviewer',
      bannedAt: over.banned ? '2026-01-01T00:00:00.000Z' : null,
    })),
  );
  return ids;
}

async function seedVersion(over: Partial<LegalVersionRow> = {}): Promise<LegalVersionRow> {
  const row: LegalVersionRow = {
    id: u(900),
    document: 'terms',
    version: '1.2',
    effectiveAt: Date.parse('2027-01-15T12:00:00.000Z'),
    summaryJson: JSON.stringify(['The disputes section changes.']),
    material: true,
    requiresAcceptance: true,
    expeditedReason: null,
    pdfKey: 'legal/terms/v1.2.pdf',
    pdfSha256: await sha256OfBytes(PDF.slice()),
    pdfBytes: PDF.length,
    publishedBy: u(800),
    publishedAt: '2026-11-12T00:00:00.000Z',
    noticeEnqueuedAt: '2026-11-12T00:00:01.000Z',
    noticeVendorCount: 3,
    ...over,
  };
  await t.db.insert(legalVersions).values(row);
  return row;
}

async function bucketWith(key: string, bytes: Uint8Array) {
  const bucket = makeFakeR2Bucket();
  await bucket.put(key, bytes.slice().buffer);
  return bucket as unknown as R2Bucket;
}

const accountEmails: FetchSeatEmailsResult = async (_env, ids) => ({
  available: true,
  reason: 'ok',
  emails: new Map(ids.map((id) => [id, `reader-${id.slice(-3)}@example.com`])),
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

function sendSpy(outcome: (to: string) => EmailOutcome = () => 'sent') {
  const calls: LegalTermsChangeSubject[] = [];
  const send = vi.fn(async (_c: unknown, opts: LegalTermsChangeSubject) => {
    calls.push(opts);
    return outcome(opts.to);
  });
  return { calls, send };
}

const baseEnv = (bucket: R2Bucket): Env =>
  ({
    ENV: 'production',
    PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
    UPLOADS: bucket,
  }) as Env;

async function deliver(
  row: Pick<LegalVersionRow, 'id' | 'pdfKey'>,
  profileIds: string[],
  opts: {
    bucket?: R2Bucket;
    send?: ReturnType<typeof sendSpy>;
    attempts?: number;
    now?: Date;
    fetchSeatEmails?: FetchSeatEmailsResult;
  } = {},
) {
  const bucket = opts.bucket ?? (await bucketWith(row.pdfKey, PDF));
  const spy = opts.send ?? sendSpy();
  const message = fakeMessage(
    { kind: 'reader', legalVersionId: row.id, profileIds, enqueuedAt: NOW.toISOString() },
    opts.attempts,
  );
  await deliverLegalNotice(baseEnv(bucket), fakeExecutionContext(), message, {
    dbFor: t.factory,
    fetchSeatEmails: opts.fetchSeatEmails ?? accountEmails,
    send: spy.send,
    now: () => opts.now ?? NOW,
  });
  return { message, ...spy };
}

const rows = async () =>
  (await t.db.select().from(legalNoticeReaderDeliveries))
    .map((r) => ({ profileId: r.profileId, status: r.status, lastReason: r.lastReason }))
    .sort((a, b) => (a.profileId < b.profileId ? -1 : 1));

const target = (queue: unknown) => ({
  env: { LEGAL_NOTICE_QUEUE: queue } as unknown as Env,
  ctx: { waitUntil: () => {} },
  request: new Request('https://aeci-api/x'),
});

describe('the reader audience and fan-out', () => {
  it('is every unbanned account, vendor seats included, sorted', async () => {
    const readers = await seedAccounts(2, 1);
    await seedAccounts(1, 10, { banned: true });
    await t.db.insert(vendors).values({ id: u(50), slug: 'v', companyName: 'V' });
    await t.db.insert(profiles).values({ id: u(20), role: 'vendor_admin', vendorId: u(50) });
    expect(await legalNoticeAccountIds(t.db)).toEqual([...readers, u(20)]);
  });

  it('queues 25 accounts per message, writes queued rows, and skips accounts delivered', async () => {
    const ids = await seedAccounts(61);
    const row = await seedVersion();
    await t.db.insert(legalNoticeReaderDeliveries).values({
      legalVersionId: row.id,
      profileId: ids[0]!,
      status: 'delivered',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const sendBatch = vi.fn(async () => {});
    const fan = await fanOutReaderLegalNotice(target({ sendBatch }), t.db, row, NOW);
    expect(fan).toEqual({ total: 60, queued: 60, complete: true, failure: null });
    expect(sendBatch).toHaveBeenCalledTimes(1);
    const messages = (
      sendBatch.mock.calls[0] as unknown as [{ body: Record<string, unknown> }[]]
    )[0];
    expect(messages.map((m) => (m.body['profileIds'] as string[]).length)).toEqual([25, 25, 10]);
    expect(messages.every((m) => m.body['kind'] === 'reader')).toBe(true);
    expect(messages.flatMap((m) => m.body['profileIds'] as string[])).toEqual(ids.slice(1));
    const record = await rows();
    expect(record.filter((r) => r.status === 'queued')).toHaveLength(60);
    expect(record.find((r) => r.profileId === ids[0])!.status).toBe('delivered');
  });

  it('records every account dropped when the queue is unbound', async () => {
    await seedAccounts(2);
    const row = await seedVersion();
    const fan = await fanOutReaderLegalNotice(target(undefined), t.db, row, NOW);
    expect(fan).toMatchObject({ complete: false, failure: 'unbound', total: 2, queued: 0 });
    expect((await rows()).map((r) => [r.status, r.lastReason])).toEqual([
      ['dropped', 'enqueue_failed'],
      ['dropped', 'enqueue_failed'],
    ]);
  });

  it('keeps each delivery upsert under D1’s bound-parameter cap', () => {
    const ids = Array.from({ length: DELIVERY_UPSERT_CHUNK }, (_, i) => u(i));
    const { params } = readerDeliveryUpsertStatement(
      t.db,
      'lv',
      ids,
      { status: 'queued', attempts: 0, lastReason: null },
      NOW,
      true,
    ).toSQL();
    expect(params.length).toBeLessThan(D1_MAX_BOUND_PARAMS);
    expect(READER_NOTICE_CHUNK).toBe(25);
  });
});

describe('the reader consumer', () => {
  it('sends one notice per account, keyed per account, and marks each delivered', async () => {
    const ids = await seedAccounts(2);
    const row = await seedVersion();
    const { message, calls } = await deliver(row, ids);
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.dedupeKey)).toEqual(
      ids.map((id) => `legal-account-change:terms:1.2:${id}`),
    );
    expect(calls[0]).toMatchObject({
      document: 'terms',
      closing: 'reader-terms-accept',
      vendorSlug: null,
      expeditedReason: null,
    });
    expect((await rows()).map((r) => r.status)).toEqual(['delivered', 'delivered']);
  });

  it('picks the closing by document and acceptance', () => {
    expect(legalReaderClosingFor('terms', false)).toBe('reader-terms');
    expect(legalReaderClosingFor('terms', true)).toBe('reader-terms-accept');
    expect(legalReaderClosingFor('privacy', false)).toBe('reader-privacy');
    expect(legalReaderNoticeDedupeKey('privacy', '1.2', 'u1')).toBe(
      'legal-account-change:privacy:1.2:u1',
    );
  });

  it('an account with no email is no_recipients; the rest still go', async () => {
    const ids = await seedAccounts(2);
    const row = await seedVersion();
    const partial: FetchSeatEmailsResult = async () => ({
      available: true,
      reason: 'ok',
      emails: new Map([[ids[0]!, 'one@example.com']]),
    });
    const { message, calls } = await deliver(row, ids, { fetchSeatEmails: partial });
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.to)).toEqual(['one@example.com']);
    expect((await rows()).map((r) => r.status)).toEqual(['delivered', 'no_recipients']);
  });

  it('retries the whole message on an Auth outage, sends nothing, and drops on the last try', async () => {
    const ids = await seedAccounts(2);
    const row = await seedVersion();
    const down: FetchSeatEmailsResult = async () => ({
      available: false,
      reason: 'error',
      emails: new Map(),
    });
    const first = await deliver(row, ids, { fetchSeatEmails: down });
    expect(first.calls).toHaveLength(0);
    expect(first.message.retry).toHaveBeenCalledTimes(1);
    expect(first.message.ack).not.toHaveBeenCalled();
    expect((await rows()).map((r) => [r.status, r.lastReason])).toEqual([
      ['queued', 'seats_unavailable'],
      ['queued', 'seats_unavailable'],
    ]);
    await deliver(row, ids, { fetchSeatEmails: down, attempts: LEGAL_NOTICE_MAX_RETRIES + 1 });
    expect((await rows()).map((r) => r.status)).toEqual(['dropped', 'dropped']);
  });

  it('sends nothing once the version is in effect, and marks the notice not completed', async () => {
    const ids = await seedAccounts(1);
    const row = await seedVersion();
    const { message, calls } = await deliver(row, ids, { now: new Date(row.effectiveAt) });
    expect(calls).toHaveLength(0);
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual([
      { profileId: ids[0], status: 'expired', lastReason: 'in_effect' },
    ]);
    const [stored] = await t.db.select().from(legalVersions);
    expect(stored!.noticeEnqueuedAt).toBeNull();
  });

  it('sends nothing when the stored PDF no longer matches its published hash', async () => {
    const ids = await seedAccounts(1);
    const row = await seedVersion();
    const bucket = await bucketWith(row.pdfKey, new TextEncoder().encode('%PDF-1.7\nother\n'));
    const { message, calls } = await deliver(row, ids, { bucket });
    expect(calls).toHaveLength(0);
    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual([
      { profileId: ids[0], status: 'queued', lastReason: 'pdf_refused' },
    ]);
  });

  it('a failed send retries, and the retry reaches only that account', async () => {
    const ids = await seedAccounts(2);
    const row = await seedVersion();
    const failing = sendSpy((to) =>
      to.endsWith(`${ids[1]!.slice(-3)}@example.com`) ? 'failed' : 'sent',
    );
    const first = await deliver(row, ids, { send: failing });
    expect(first.message.retry).toHaveBeenCalledTimes(1);
    expect(await rows()).toEqual([
      { profileId: ids[0], status: 'delivered', lastReason: null },
      { profileId: ids[1], status: 'queued', lastReason: 'send_failed' },
    ]);
    const second = await deliver(row, ids, { attempts: 2 });
    expect(second.calls.map((c) => c.dedupeKey)).toEqual([
      `legal-account-change:terms:1.2:${ids[1]}`,
    ]);
    expect(second.message.ack).toHaveBeenCalledTimes(1);
  });

  it('drops a reader message that names an agreement version', async () => {
    const ids = await seedAccounts(1);
    const row = await seedVersion({
      document: 'vendor_terms',
      pdfKey: 'legal/vendor-terms/v1.4.pdf',
    });
    const { message, calls } = await deliver(row, ids);
    expect(calls).toHaveLength(0);
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it('a company message with no kind still reaches the company path', async () => {
    await t.db.insert(vendors).values({ id: u(50), slug: 'v', companyName: 'V' });
    await t.db.insert(profiles).values({ id: u(20), role: 'vendor_admin', vendorId: u(50) });
    const row = await seedVersion({
      document: 'vendor_terms',
      version: '1.4',
      requiresAcceptance: false,
      pdfKey: 'legal/vendor-terms/v1.4.pdf',
    });
    const spy = sendSpy();
    const message = fakeMessage({ legalVersionId: row.id, vendorId: u(50), enqueuedAt: 'x' });
    await deliverLegalNotice(
      baseEnv(await bucketWith(row.pdfKey, PDF)),
      fakeExecutionContext(),
      message,
      { dbFor: t.factory, fetchSeatEmails: accountEmails, send: spy.send, now: () => NOW },
    );
    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.closing).toBe('vendor-terms');
  });

  it('through the real sender: ledgered as legal-account-change, never twice', async () => {
    vi.mocked(ledgerDb).mockReturnValue(t.db as Db);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{"id":"re_1"}', { status: 200 }));
    const ids = await seedAccounts(1);
    const row = await seedVersion({
      document: 'privacy',
      requiresAcceptance: false,
      pdfKey: 'legal/privacy/v1.2.pdf',
    });
    const bucket = await bucketWith(row.pdfKey, PDF);
    const env = {
      ...baseEnv(bucket),
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
    } as Env;
    const run = async () => {
      const message = fakeMessage({
        kind: 'reader',
        legalVersionId: row.id,
        profileIds: ids,
        enqueuedAt: 'x',
      });
      await deliverLegalNotice(env, fakeExecutionContext(), message, {
        dbFor: t.factory,
        fetchSeatEmails: accountEmails,
        send: sendLegalTermsChangeEmail,
        now: () => NOW,
      });
      expect(message.ack).toHaveBeenCalledTimes(1);
    };
    await run();
    // A re-delivery of a delivered account is skipped before any send.
    await run();
    const resend = fetchSpy.mock.calls.filter(
      (c) => String(c[0]) === 'https://api.resend.com/emails',
    );
    expect(resend).toHaveLength(1);
    const sent = JSON.parse(String((resend[0]![1] as RequestInit).body)) as {
      subject: string;
      text: string;
      attachments: { filename: string }[];
    };
    expect(sent.subject).toBe('Version 1.2 of the Privacy Policy takes effect on January 15, 2027');
    expect(sent.text).toContain('The new version applies from January 15, 2027.');
    expect(sent.text).toContain('because you have an account on AEC Integrations');
    expect(sent.attachments[0]!.filename).toBe('aeci-privacy-v1.2.pdf');
    const ledger = await t.db.select().from(notificationSends);
    expect(ledger.map((r) => [r.notificationId, r.outcome, r.dedupeKey])).toEqual([
      ['legal-account-change', 'sent', `legal-account-change:privacy:1.2:${ids[0]}`],
    ]);
  });
});

describe('the per-account delivery summary', () => {
  it('counts and lists the accounts not reached, by id', async () => {
    const row = await seedVersion();
    const at = NOW.toISOString();
    const r = (profileId: string, status: string, lastReason: string | null = null) => ({
      legalVersionId: row.id,
      profileId,
      status,
      lastReason,
      createdAt: at,
      updatedAt: at,
    });
    await t.db
      .insert(legalNoticeReaderDeliveries)
      .values([
        r(u(2), 'delivered'),
        r(u(3), 'dropped', 'send_failed'),
        r(u(1), 'no_recipients'),
        r(u(4), 'delivered', 'outcome_unknown'),
      ]);
    const summary = (await loadReaderNoticeDeliveries(t.db, [row], NOW)).get(row.id)!;
    expect(summary).toMatchObject({ total: 4, delivered: 2, pending: 0, not_reached: 2 });
    expect(summary.not_reached_companies).toEqual([
      { vendor_id: u(1), name: null, slug: null, status: 'no_recipients', reason: null },
      { vendor_id: u(3), name: null, slug: null, status: 'dropped', reason: 'send_failed' },
    ]);
    expect(summary.delivered_to_check_companies).toEqual([
      { vendor_id: u(4), name: null, slug: null, reason: 'outcome_unknown' },
    ]);
  });
});
