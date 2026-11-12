/**
 * The `legal-terms-change` queue (AECI-1620) on the in-memory D1 harness.
 *
 * INVARIANTS. None should be deleted without reopening the decision behind it:
 *
 *   1. **The audience** per document: Vendor Terms is every company with an unbanned
 *      seat; the Managed plan is every company with a live subscription of any source.
 *   2. **The key holds the company id**, so a billing address shared by two companies
 *      gets one notice per company, and a re-run sends no address twice.
 *   3. **A PDF that no longer matches its hash sends nothing** and retries.
 *   4. **A degraded seat lookup retries** and sends nothing: never an ack with seats
 *      missing.
 *   5. **A failed send retries**; the retry reaches only the failed address.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/client';
import {
  auditLog,
  billingAccounts,
  legalVersions,
  licenses,
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
import { recipientHash } from './hash';
import {
  deliverLegalNotice,
  isLegalNoticeQueue,
  legalClosingFor,
  legalNoticeDedupeKey,
  legalNoticeRetryDelaySeconds,
  legalNoticeVendorIds,
  LEGAL_NOTICE_MAX_RETRIES,
  LEGAL_VERSION_NOTICE_EXPIRED_ACTION,
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
const V1 = u(1);
const V2 = u(2);
const V3 = u(3);
/** Before every seeded effective moment, so no spec depends on the real clock. */
const NOW = new Date('2026-11-20T00:00:00.000Z');
const PDF = new TextEncoder().encode('%PDF-1.7\nterms\n%%EOF\n');

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  vi.mocked(logToPosthog).mockClear();
});
afterEach(() => {
  t.dispose();
  vi.restoreAllMocks();
});

async function seedVendor(id: string, slug: string, billingEmail: string | null = null) {
  await t.db.insert(vendors).values({ id, slug, companyName: slug, maintainedBy: 'vendor' });
  await t.db
    .insert(billingAccounts)
    .values({ id: `acct-${id}`, vendorId: id, name: slug, billingEmail });
}

async function seedSeat(
  id: string,
  vendorId: string,
  over: { owner?: boolean; banned?: boolean } = {},
) {
  await t.db.insert(profiles).values({
    id,
    role: 'vendor_admin',
    vendorId,
    seatOwner: over.owner ?? false,
    bannedAt: over.banned ? '2026-01-01T00:00:00.000Z' : null,
  });
}

async function seedLicense(
  id: string,
  vendorId: string,
  over: { source?: string; endsAt?: string | null; endedAt?: string | null } = {},
) {
  await t.db.insert(licenses).values({
    id,
    billingAccountId: `acct-${vendorId}`,
    source: over.source ?? 'stripe',
    startsAt: '2026-01-01T00:00:00.000Z',
    endsAt: over.endsAt === undefined ? null : over.endsAt,
    endedAt: over.endedAt ?? null,
    endReason: over.endedAt ? 'lapsed' : null,
  });
}

async function seedVersion(over: Partial<LegalVersionRow> = {}): Promise<LegalVersionRow> {
  const row: LegalVersionRow = {
    id: u(900),
    document: 'vendor_terms',
    version: '1.4',
    effectiveAt: Date.parse('2027-01-15T12:00:00.000Z'),
    summaryJson: JSON.stringify(['First change.', 'Second change.']),
    material: true,
    requiresAcceptance: false,
    expeditedReason: null,
    pdfKey: 'legal/vendor-terms/v1.4.pdf',
    pdfSha256: await sha256OfBytes(PDF.slice()),
    pdfBytes: PDF.length,
    publishedBy: u(800),
    publishedAt: '2026-11-12T00:00:00.000Z',
    noticeEnqueuedAt: null,
    noticeVendorCount: null,
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

/** Seat id → address; the seam reports itself healthy. */
const seatEmails: FetchSeatEmailsResult = async (_env, ids) => ({
  available: true,
  reason: 'ok',
  emails: new Map(ids.map((id) => [id, `seat-${id.slice(-3)}@vendor.example`])),
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
  vendorId: string,
  opts: {
    env?: Partial<Env>;
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
    { legalVersionId: row.id, vendorId, enqueuedAt: '2026-11-12T00:00:00.000Z' },
    opts.attempts,
  );
  await deliverLegalNotice(
    { ...baseEnv(bucket), ...opts.env } as Env,
    fakeExecutionContext(),
    message,
    {
      dbFor: t.factory,
      fetchSeatEmails: opts.fetchSeatEmails ?? seatEmails,
      send: spy.send,
      now: () => opts.now ?? NOW,
    },
  );
  return { message, ...spy };
}

const errorLogs = () =>
  vi
    .mocked(logToPosthog)
    .mock.calls.map((call) => call[3])
    .filter((e) => (e as { level?: string }).level === 'error');

describe('the queue name', () => {
  it('routes only aeci-legal-notice-* queues here', () => {
    expect(isLegalNoticeQueue('aeci-legal-notice-production')).toBe(true);
    expect(isLegalNoticeQueue('aeci-ownership-sync-production')).toBe(false);
  });

  it('backs off 10, 20, then 30 minutes', () => {
    expect([1, 2, 3, 4].map(legalNoticeRetryDelaySeconds)).toEqual([600, 1200, 1800, 1800]);
  });
});

describe('the audience', () => {
  it('vendor_terms: every company with an unbanned seat', async () => {
    await seedVendor(V1, 'a');
    await seedVendor(V2, 'b');
    await seedVendor(V3, 'c');
    await seedSeat(u(11), V1);
    await seedSeat(u(12), V1, { owner: true });
    await seedSeat(u(21), V2, { banned: true });
    // V3 has a live subscription but no seat: not a Vendor Terms party.
    await seedLicense(u(31), V3);
    expect(await legalNoticeVendorIds(t.db, 'vendor_terms')).toEqual([V1]);
  });

  it('managed_plan: every company with a live subscription, grants included, ended ones not', async () => {
    await seedVendor(V1, 'a');
    await seedVendor(V2, 'b');
    await seedVendor(V3, 'c');
    await seedLicense(u(11), V1, { source: 'stripe' });
    await seedLicense(u(12), V1, { source: 'stripe' });
    await seedLicense(u(21), V2, { source: 'complimentary', endsAt: '2027-06-01T00:00:00.000Z' });
    await seedLicense(u(31), V3, { endedAt: '2026-06-01T00:00:00.000Z' });
    expect(await legalNoticeVendorIds(t.db, 'managed_plan')).toEqual([V1, V2]);
  });
});

describe('the closing line', () => {
  it('picks the line from the document, the acceptance answer and a monthly card subscription', () => {
    expect(legalClosingFor('vendor_terms', false, false)).toBe('vendor-terms');
    expect(legalClosingFor('vendor_terms', true, false)).toBe('vendor-terms-accept');
    expect(legalClosingFor('managed_plan', true, true)).toBe('managed-monthly-accept');
    expect(legalClosingFor('managed_plan', true, false)).toBe('managed-binds');
    expect(legalClosingFor('managed_plan', false, true)).toBe('managed-binds');
  });
});

describe('deliverLegalNotice', () => {
  it('vendor_terms: every unbanned seat and the billing email, keyed with the company id', async () => {
    await seedVendor(V1, 'alpha', 'billing@a.example');
    await seedSeat(u(11), V1);
    await seedSeat(u(12), V1, { owner: true });
    await seedSeat(u(13), V1, { banned: true });
    const row = await seedVersion({ requiresAcceptance: true, expeditedReason: 'law' });

    const { message, calls } = await deliver(row, V1);

    expect(message.ack).toHaveBeenCalledTimes(1);
    expect(message.retry).not.toHaveBeenCalled();
    expect(calls.map((c) => c.to)).toEqual([
      'seat-011@vendor.example',
      'seat-012@vendor.example',
      'billing@a.example',
    ]);
    const first = calls[0]!;
    expect(first).toMatchObject({
      document: 'vendor_terms',
      version: '1.4',
      effectiveDay: '2027-01-15',
      summary: ['First change.', 'Second change.'],
      closing: 'vendor-terms-accept',
      expeditedReason: 'law',
      vendorSlug: 'alpha',
      entity: { type: 'legal_version', id: row.id },
    });
    const hash = await recipientHash('seat-011@vendor.example');
    expect(first.dedupeKey).toBe(`legal-terms-change:vendor_terms:1.4:${V1}:${hash}`);
    expect(first.dedupeKey).toBe(legalNoticeDedupeKey('vendor_terms', '1.4', V1, hash));
    expect(atob(first.pdfBase64).startsWith('%PDF-')).toBe(true);
  });

  it('managed_plan, annual: the owner seats and the billing email, no accept ask', async () => {
    await seedVendor(V1, 'a', 'billing@a.example');
    await seedSeat(u(11), V1);
    await seedSeat(u(12), V1, { owner: true });
    await seedLicense(u(31), V1, { source: 'stripe', endsAt: '2027-06-01T00:00:00.000Z' });
    const row = await seedVersion({
      document: 'managed_plan',
      version: '1.2',
      requiresAcceptance: true,
      pdfKey: 'legal/managed-plan-agreement/v1.2.pdf',
    });

    const { calls } = await deliver(row, V1);

    expect(calls.map((c) => c.to)).toEqual(['seat-012@vendor.example', 'billing@a.example']);
    expect(calls[0]!.closing).toBe('managed-binds');
  });

  it('managed_plan, monthly card, needs acceptance: asks for the portal accept', async () => {
    await seedVendor(V1, 'a', 'billing@a.example');
    await seedLicense(u(31), V1, { source: 'stripe', endsAt: null });
    const row = await seedVersion({
      document: 'managed_plan',
      version: '1.2',
      requiresAcceptance: true,
      pdfKey: 'legal/managed-plan-agreement/v1.2.pdf',
    });
    const { calls } = await deliver(row, V1);
    expect(calls.map((c) => c.closing)).toEqual(['managed-monthly-accept']);
  });

  it('sends nothing, logs an error and retries when the stored PDF no longer matches its hash', async () => {
    await seedVendor(V1, 'a', 'billing@a.example');
    await seedSeat(u(11), V1);
    const row = await seedVersion();
    const changed = await bucketWith(row.pdfKey, new TextEncoder().encode('%PDF-1.7\nother\n'));

    const { message, send } = await deliver(row, V1, { bucket: changed });

    expect(send).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 600 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(errorLogs()).toContainEqual(
      expect.objectContaining({ problem: 'hash_mismatch', vendor_id: V1 }),
    );
  });

  it('retries without sending when the seat lookup is degraded, and never acks', async () => {
    await seedVendor(V1, 'a', 'billing@a.example');
    await seedSeat(u(11), V1);
    await seedSeat(u(12), V1);
    const row = await seedVersion();
    // One id answered, the other failed: a partial map is still a degraded answer.
    const degraded: FetchSeatEmailsResult = async (_env, ids) => ({
      available: false,
      reason: 'error',
      emails: new Map([[ids[0]!, 'seat-first@vendor.example']]),
    });

    const { message, send } = await deliver(row, V1, { fetchSeatEmails: degraded });

    expect(send).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 600 });
    expect(errorLogs()).toContainEqual(expect.objectContaining({ reason: 'error' }));
  });

  it('retries when the lookup has no credentials too', async () => {
    await seedVendor(V1, 'a');
    await seedSeat(u(11), V1);
    const row = await seedVersion();
    const none: FetchSeatEmailsResult = async () => ({
      available: false,
      reason: 'no_credentials',
      emails: new Map(),
    });
    const { message, send } = await deliver(row, V1, { fetchSeatEmails: none });
    expect(send).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledTimes(1);
  });

  it('names the version and company when the last attempt drops the message', async () => {
    await seedVendor(V1, 'a', 'billing@a.example');
    const row = await seedVersion();
    const { message, send } = await deliver(row, V1, {
      bucket: makeFakeR2Bucket() as unknown as R2Bucket,
      attempts: LEGAL_NOTICE_MAX_RETRIES + 1,
    });
    expect(send).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(errorLogs()).toContainEqual(
      expect.objectContaining({
        problem: 'missing',
        legal_version_id: row.id,
        vendor_id: V1,
        version: '1.4',
        message: expect.stringContaining('last attempt'),
      }),
    );
  });

  it('sends nothing without PUBLIC_SITE_URL, because the version link is one of the four parts', async () => {
    await seedVendor(V1, 'a', 'billing@a.example');
    const row = await seedVersion();
    const { message, send } = await deliver(row, V1, { env: { PUBLIC_SITE_URL: undefined } });
    expect(send).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledTimes(1);
  });

  it('retries when a send failed, and acks once every address is past failed', async () => {
    await seedVendor(V1, 'a', 'billing@a.example');
    await seedSeat(u(11), V1);
    const row = await seedVersion();
    const flaky = sendSpy((to) => (to === 'billing@a.example' ? 'failed' : 'sent'));

    const { message } = await deliver(row, V1, { send: flaky });
    expect(message.retry).toHaveBeenCalledTimes(1);
    expect(message.ack).not.toHaveBeenCalled();

    const again = await deliver(row, V1, { send: sendSpy(() => 'duplicate') });
    expect(again.message.ack).toHaveBeenCalledTimes(1);
  });

  it('sends nothing after the effective moment, acks, and marks the notice not completed once', async () => {
    await seedVendor(V1, 'a', 'billing@a.example');
    await seedSeat(u(11), V1);
    const row = await seedVersion({
      noticeEnqueuedAt: '2026-11-12T00:00:00.000Z',
      noticeVendorCount: 5,
    });
    const late = new Date(row.effectiveAt);

    const first = await deliver(row, V1, { now: late });
    expect(first.send).not.toHaveBeenCalled();
    expect(first.message.ack).toHaveBeenCalledTimes(1);
    expect(first.message.retry).not.toHaveBeenCalled();
    expect(errorLogs()).toContainEqual(
      expect.objectContaining({ legal_version_id: row.id, vendor_id: V1 }),
    );
    const [after] = await t.db.select().from(legalVersions);
    expect(after).toMatchObject({ noticeEnqueuedAt: null, noticeVendorCount: 5 });
    const audits = (await t.db.select().from(auditLog)).filter(
      (a) => a.action === LEGAL_VERSION_NOTICE_EXPIRED_ACTION,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'system', entityId: row.id });

    // A second late message for the same version writes nothing more.
    const second = await deliver(after!, V1, { now: late });
    expect(second.send).not.toHaveBeenCalled();
    expect(second.message.ack).toHaveBeenCalledTimes(1);
    expect(
      (await t.db.select().from(auditLog)).filter(
        (a) => a.action === LEGAL_VERSION_NOTICE_EXPIRED_ACTION,
      ),
    ).toHaveLength(1);
  });

  it('still sends one millisecond before the effective moment', async () => {
    await seedVendor(V1, 'a', 'billing@a.example');
    const row = await seedVersion();
    const { send, message } = await deliver(row, V1, { now: new Date(row.effectiveAt - 1) });
    expect(send).toHaveBeenCalledTimes(1);
    expect(message.ack).toHaveBeenCalledTimes(1);
  });

  it('acks and drops an unknown version, a non-material one and a malformed body', async () => {
    await seedVendor(V1, 'a', 'billing@a.example');
    const ghost = { id: u(999), pdfKey: 'legal/vendor-terms/v9.pdf' };
    const first = await deliver(ghost, V1);
    expect(first.message.ack).toHaveBeenCalledTimes(1);
    expect(first.send).not.toHaveBeenCalled();

    const quiet = await seedVersion({ material: false });
    const second = await deliver(quiet, V1);
    expect(second.message.ack).toHaveBeenCalledTimes(1);
    expect(second.send).not.toHaveBeenCalled();

    const bad = fakeMessage({ nope: true });
    await deliverLegalNotice(
      baseEnv(makeFakeR2Bucket() as unknown as R2Bucket),
      fakeExecutionContext(),
      bad,
      { dbFor: t.factory, now: () => NOW },
    );
    expect(bad.ack).toHaveBeenCalledTimes(1);
  });

  it('through the real sender: one notice per company for a shared billing address, none twice', async () => {
    vi.mocked(ledgerDb).mockReturnValue(t.db as Db);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{"id":"re_1"}', { status: 200 }));
    await seedVendor(V1, 'a', 'shared@billing.example');
    await seedVendor(V2, 'b', 'Shared@Billing.example');
    const row = await seedVersion();
    const bucket = await bucketWith(row.pdfKey, PDF);
    const env = {
      ...baseEnv(bucket),
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
      EMAIL_BCC: 'ops@aecintegrations.com',
    } as Env;
    const run = async (vendorId: string) => {
      const message = fakeMessage({ legalVersionId: row.id, vendorId, enqueuedAt: 'x' });
      await deliverLegalNotice(env, fakeExecutionContext(), message, {
        dbFor: t.factory,
        fetchSeatEmails: seatEmails,
        send: sendLegalTermsChangeEmail,
        now: () => NOW,
      });
      expect(message.ack).toHaveBeenCalledTimes(1);
    };
    await run(V1);
    await run(V2);
    // A re-send of V1 finds the key held.
    await run(V1);

    const resend = fetchSpy.mock.calls.filter(
      (c) => String(c[0]) === 'https://api.resend.com/emails',
    );
    expect(resend).toHaveLength(2);
    const sent = JSON.parse(String((resend[0]![1] as RequestInit).body)) as {
      bcc?: unknown;
      attachments: { filename: string; content: string }[];
    };
    expect(sent.bcc).toBeUndefined();
    expect(sent.attachments[0]!.filename).toBe('aeci-vendor-terms-v1.4.pdf');
    expect(atob(sent.attachments[0]!.content).startsWith('%PDF-')).toBe(true);

    const ledger = await t.db.select().from(notificationSends);
    const hash = await recipientHash('shared@billing.example');
    expect(ledger.filter((r) => r.outcome === 'sent').map((r) => r.dedupeKey)).toEqual([
      `legal-terms-change:vendor_terms:1.4:${V1}:${hash}`,
      `legal-terms-change:vendor_terms:1.4:${V2}:${hash}`,
    ]);
    expect(ledger.filter((r) => r.outcome === 'duplicate')).toHaveLength(1);
    expect(ledger.every((r) => r.entityId === row.id)).toBe(true);
  });
});
