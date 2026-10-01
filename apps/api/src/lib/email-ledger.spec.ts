/**
 * The email transports write the send ledger (AECI-1202), end to end against the
 * in-memory D1 harness. `ledgerDb` is the one seam mocked: it hands the transport the
 * harness client in place of a `getDb(env)` over a D1 binding. Resend is a stubbed fetch.
 */

import { asc } from 'drizzle-orm';
import type { Context } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/client';
import { notificationSends } from '../db/schema';
import type { Env } from '../env';
import { submitCount } from '../posthog';
import { makeTestDb, type TestDb } from '../test/d1';
import { sendEmail, sendMailingListWelcomeEmail, sendTransactionalEmail } from './email';
import type { EmailContext } from './email';
import { recipientHash } from './hash';
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

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  vi.mocked(ledgerDb).mockReturnValue(t.db as Db);
  vi.mocked(submitCount).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  t.dispose();
});

function ctx(env: Partial<Env> = {}): EmailContext {
  return {
    env: {
      ENV: 'production',
      POSTHOG_PROJECT_KEY: undefined,
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
      ...env,
    } as Env,
    executionCtx: { waitUntil: () => {}, passThroughOnException: () => {} },
    req: { raw: new Request('https://api.test/x', { method: 'POST' }) },
  } as unknown as Context<{ Bindings: Env }>;
}

const rows = () => t.db.select().from(notificationSends).orderBy(asc(notificationSends.id));

const INPUT = {
  to: 'Reviewer <R@Example.com>',
  subject: 'Hi',
  text: 'Body',
  template: 'claim-approved' as const,
};

function sendTags(): string[][] {
  return vi
    .mocked(submitCount)
    .mock.calls.filter((call) => call[3] === 'aeci.email.send')
    .map((call) => call[5] as string[]);
}

describe('sendTransactionalEmail writes the send ledger', () => {
  it('stores the Resend id from the 2xx body, keyed by the hash of the bare address', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"id":"re_1"}'));

    const outcome = await sendTransactionalEmail(ctx(), {
      ...INPUT,
      dedupeKey: 'claim-approved:c1',
      entity: { type: 'claim', id: 'c1' },
    });

    expect(outcome).toBe('sent');
    expect(await rows()).toEqual([
      expect.objectContaining({
        notificationId: 'claim-approved',
        recipientHash: await recipientHash('r@example.com'),
        tier: 'production',
        outcome: 'sent',
        providerMessageId: 're_1',
        dedupeKey: 'claim-approved:c1',
        entityType: 'claim',
        entityId: 'c1',
      }),
    ]);
  });

  it('sends no Idempotency-Key while the ledger is up, so a re-send after a refusal is not a 409', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('nope', { status: 422 }))
      .mockResolvedValueOnce(new Response('{"id":"re_2"}'));

    expect(await sendTransactionalEmail(ctx(), { ...INPUT, dedupeKey: 'k' })).toBe('failed');
    expect(await sendTransactionalEmail(ctx(), { ...INPUT, dedupeKey: 'k' })).toBe('sent');

    const headers = fetchSpy.mock.calls.map(
      (call) => (call[1] as RequestInit).headers as Record<string, string>,
    );
    expect(headers).toHaveLength(2);
    for (const h of headers) expect(h).not.toHaveProperty('Idempotency-Key');
  });

  it('a second send with the same key is a duplicate: no fetch, a duplicate row', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"id":"re_1"}'));
    await sendTransactionalEmail(ctx(), { ...INPUT, dedupeKey: 'k' });
    fetchSpy.mockClear();
    vi.mocked(submitCount).mockClear();

    const outcome = await sendTransactionalEmail(ctx(), { ...INPUT, dedupeKey: 'k' });

    expect(outcome).toBe('duplicate');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sendTags()).toEqual([['outcome:duplicate', 'template:claim-approved']]);
    expect((await rows()).map((r) => [r.outcome, r.dedupeKey, r.providerMessageId])).toEqual([
      ['sent', 'k', 're_1'],
      ['duplicate', null, null],
    ]);
  });

  it('a duplicate sends no operator copy either', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"id":"re_1"}'));
    const input = {
      ...INPUT,
      dedupeKey: 'k',
      headers: { 'List-Unsubscribe': '<https://x/u>' },
      operatorCopy: { notification: 'mailing-list-welcome-operator-copy' as const, text: 'c' },
    };
    const env = { EMAIL_BCC: 'ops@aecintegrations.com' };
    await sendTransactionalEmail(ctx(env), input);
    fetchSpy.mockClear();
    await sendTransactionalEmail(ctx(env), input);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a non-2xx is a failed row, releases the key and drains the body', async () => {
    const res = new Response('rejected', { status: 422 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);

    expect(await sendTransactionalEmail(ctx(), { ...INPUT, dedupeKey: 'k' })).toBe('failed');
    await new Promise((r) => setTimeout(r, 0));

    expect(res.bodyUsed || res.body?.locked).toBeTruthy();
    expect(await rows()).toEqual([
      expect.objectContaining({ outcome: 'failed', dedupeKey: null, providerMessageId: null }),
    ]);

    // Released: the retry sends.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"id":"re_2"}'));
    expect(await sendTransactionalEmail(ctx(), { ...INPUT, dedupeKey: 'k' })).toBe('sent');
  });

  it('a thrown fetch is an unknown row that keeps its key: a retry is a duplicate (AECI-1197 review)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('network down'));
    const keyed = { ...INPUT, dedupeKey: 'review-decision:rev-9' };
    expect(await sendTransactionalEmail(ctx(), keyed)).toBe('unknown');
    expect((await rows()).map((r) => [r.outcome, r.dedupeKey])).toEqual([
      ['unknown', 'review-decision:rev-9'],
    ]);

    fetchSpy.mockResolvedValue(new Response('{"id":"re_2"}', { status: 200 }));
    expect(await sendTransactionalEmail(ctx(), keyed)).toBe('duplicate');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('a non-2xx is a failed row that releases its key: a retry sends', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('busy', { status: 503 }));
    const keyed = { ...INPUT, dedupeKey: 'review-decision:rev-10' };
    expect(await sendTransactionalEmail(ctx(), keyed)).toBe('failed');

    fetchSpy.mockResolvedValue(new Response('{"id":"re_3"}', { status: 200 }));
    expect(await sendTransactionalEmail(ctx(), keyed)).toBe('sent');
    expect((await rows()).map((r) => [r.outcome, r.dedupeKey])).toEqual([
      ['failed', null],
      ['sent', 'review-decision:rev-10'],
    ]);
  });

  it('a 2xx with an unreadable body is still sent, with no id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>', { status: 200 }));
    expect(await sendTransactionalEmail(ctx(), INPUT)).toBe('sent');
    expect(await rows()).toEqual([
      expect.objectContaining({ outcome: 'sent', providerMessageId: null }),
    ]);
  });

  it('writes a skipped row when there is no key, and an empty hash when there is no address', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await sendTransactionalEmail(ctx({ RESEND_API_KEY: undefined }), INPUT)).toBe('skipped');
    expect(await sendTransactionalEmail(ctx(), { ...INPUT, to: '' })).toBe('skipped');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await rows()).map((r) => [r.outcome, r.recipientHash])).toEqual([
      ['skipped', await recipientHash('r@example.com')],
      ['skipped', ''],
    ]);
  });

  it('writes a suppressed row on a non-production tier, with the tier label', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await sendTransactionalEmail(ctx({ ENV: 'staging' }), INPUT)).toBe('suppressed');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await rows()).toEqual([
      expect.objectContaining({ outcome: 'suppressed', tier: 'staging', dedupeKey: null }),
    ]);
  });

  it('fails open: a broken ledger still sends', async () => {
    vi.mocked(ledgerDb).mockReturnValue({
      insert: () => {
        throw new Error('D1_ERROR');
      },
      update: () => {
        throw new Error('D1_ERROR');
      },
    } as unknown as Db);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"id":"re_1"}'));

    expect(await sendTransactionalEmail(ctx(), { ...INPUT, dedupeKey: 'k' })).toBe('sent');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('records the operator copy under its own registry id, one row per operator address', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"id":"re_user"}'))
      .mockResolvedValueOnce(new Response('{"id":"re_copy"}'));

    const outcome = await sendMailingListWelcomeEmail(
      ctx({
        EMAIL_BCC: 'ops@aecintegrations.com, chris@thewbsproject.com',
        PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
      }),
      { to: 'sub@example.com', token: 'tok' },
    );

    expect(outcome).toBe('sent');
    const all = await rows();
    expect(all.map((r) => [r.notificationId, r.outcome, r.providerMessageId])).toEqual([
      ['mailing-list-welcome', 'sent', 're_user'],
      ['mailing-list-welcome-operator-copy', 'sent', 're_copy'],
      ['mailing-list-welcome-operator-copy', 'sent', 're_copy'],
    ]);
    expect(all[1]?.recipientHash).toBe(await recipientHash('ops@aecintegrations.com'));
  });
});

describe('sendEmail (digests) writes the send ledger', () => {
  const MSG = {
    notification: 'digest-data-quality' as const,
    from: 'AECi <dq@aecintegrations.com>',
    to: ['a@thewbsproject.com', 'b@example.com'],
    subject: 'subj',
    text: 'body',
  };
  const silent = { warn: () => {}, error: () => {} };
  const DB = {} as D1Database;

  it('writes one row per recipient, sharing the one Resend id', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"id":"re_digest"}'));
    const out = await sendEmail(
      { ENV: 'production', RESEND_API_KEY: 'k', DB },
      MSG,
      fetchImpl as unknown as typeof fetch,
      silent,
    );

    expect(out).toBe('sent');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const all = await rows();
    expect(all.map((r) => [r.notificationId, r.outcome, r.providerMessageId])).toEqual([
      ['digest-data-quality', 'sent', 're_digest'],
      ['digest-data-quality', 'sent', 're_digest'],
    ]);
    expect(all.map((r) => r.recipientHash)).toEqual([
      await recipientHash('a@thewbsproject.com'),
      await recipientHash('b@example.com'),
    ]);
  });

  it('writes suppressed rows for refused addresses and sent rows for the rest', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"id":"re_d"}'));
    await sendEmail(
      { ENV: 'staging', RESEND_API_KEY: 'k', DB },
      MSG,
      fetchImpl as unknown as typeof fetch,
      silent,
    );
    expect((await rows()).map((r) => [r.outcome, r.tier])).toEqual([
      ['suppressed', 'staging'],
      ['sent', 'staging'],
    ]);
  });

  it('writes failed rows on a non-2xx, and skipped rows with no key', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 500 }));
    await sendEmail(
      { ENV: 'production', RESEND_API_KEY: 'k', DB },
      MSG,
      fetchImpl as unknown as typeof fetch,
      silent,
    );
    await sendEmail({ ENV: 'production', DB }, MSG, fetchImpl as unknown as typeof fetch, silent);
    expect((await rows()).map((r) => r.outcome)).toEqual([
      'failed',
      'failed',
      'skipped',
      'skipped',
    ]);
  });
});
