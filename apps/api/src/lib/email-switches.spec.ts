/**
 * The email transports honour the operator's sending switches (AECI-1224), end to end
 * against the in-memory D1 harness. Source of truth: `docs/email.md` §Sending switches,
 * `docs/ADMIN_PANEL_SPEC.md` §5.14.
 *
 * INVARIANT tests here. None should be deleted without reopening the decision behind it:
 *
 *   1. **A paused template makes no Resend call.** It writes a `paused` ledger row and
 *      counts `outcome:paused`.
 *   2. **Protected mail cannot be paused, even by a stale row.** The transport ignores a
 *      paused row for a non-pausable entry.
 *   3. **A failed read fails open.** The send goes ahead, and the failure is counted.
 *   4. **The support copy switch drops both copies.** No `bcc`, no separate `COPY:`.
 */

import { asc } from 'drizzle-orm';
import type { Context } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/client';
import { notificationSends, notificationSettings } from '../db/schema';
import type { Env } from '../env';
import { submitCount } from '../posthog';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  sendEmail,
  sendMailingListWelcomeEmail,
  sendTransactionalEmail,
  type EmailContext,
} from './email';
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
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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

const pause = (key: string, enabled = false) =>
  t.db.insert(notificationSettings).values({ key, enabled, updatedBy: 'admin-1' });

const rows = () => t.db.select().from(notificationSends).orderBy(asc(notificationSends.id));

function metric(name: string): string[][] {
  return vi
    .mocked(submitCount)
    .mock.calls.filter((call) => call[3] === name)
    .map((call) => call[5] as string[]);
}

function bodyOf(spy: { mock: { calls: unknown[][] } }, i = 0): Record<string, unknown> {
  return JSON.parse((spy.mock.calls[i]![1] as RequestInit).body as string) as Record<
    string,
    unknown
  >;
}

/** A pausable operator alert. */
const ALERT = {
  to: 'support@aecintegrations.com',
  subject: 'New review',
  text: 'Body',
  template: 'review-submitted-alert' as const,
};

describe('sendTransactionalEmail and the sending switches', () => {
  it('a paused template makes no Resend call and writes a paused row', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await pause('review-submitted-alert');

    const outcome = await sendTransactionalEmail(ctx(), {
      ...ALERT,
      dedupeKey: 'k',
      entity: { type: 'review', id: 'r1' },
    });

    expect(outcome).toBe('paused');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(metric('aeci.email.send')).toEqual([
      ['outcome:paused', 'template:review-submitted-alert'],
    ]);
    expect(await rows()).toEqual([
      expect.objectContaining({
        notificationId: 'review-submitted-alert',
        outcome: 'paused',
        recipientHash: await recipientHash('support@aecintegrations.com'),
        // A paused send holds no key, so a run after the resume can send it.
        dedupeKey: null,
        entityType: 'review',
        entityId: 'r1',
      }),
    ]);
  });

  it('logs a recipient hash, never the address', async () => {
    vi.spyOn(globalThis, 'fetch');
    await pause('review-submitted-alert');
    await sendTransactionalEmail(ctx(), ALERT);
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(logged).toContain(await recipientHash('support@aecintegrations.com'));
    expect(logged).not.toContain('support@aecintegrations.com');
  });

  it('a resumed template sends again', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"id":"re_1"}'));
    await pause('review-submitted-alert', true);
    expect(await sendTransactionalEmail(ctx(), ALERT)).toBe('sent');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('ignores a paused row for a non-pausable entry: protected mail still sends', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"id":"re_1"}'));
    await pause('claim-approved');

    const outcome = await sendTransactionalEmail(ctx(), {
      to: 'owner@example.com',
      subject: 'Approved',
      text: 'Body',
      template: 'claim-approved',
    });

    expect(outcome).toBe('sent');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('fails open when the switches cannot be read, and counts it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"id":"re_1"}'));
    // Every select throws; the ledger writes still land.
    const real = t.db as Db;
    const broken = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'select') {
          return () => {
            throw new Error('D1_ERROR');
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    vi.mocked(ledgerDb).mockReturnValue(broken);
    await pause('review-submitted-alert');

    expect(await sendTransactionalEmail(ctx(), ALERT)).toBe('sent');
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(metric('aeci.email.switches.unavailable')).toEqual([['layer:transactional']]);
  });

  it('a paused support copy drops the blind copy', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"id":"re_1"}'));
    await pause('support-copy');

    await sendTransactionalEmail(ctx({ EMAIL_BCC: 'chris@thewbsproject.com' }), ALERT);

    expect(bodyOf(fetchSpy)).not.toHaveProperty('bcc');
  });

  it('with the support copy on, the blind copy rides the send', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"id":"re_1"}'));
    await sendTransactionalEmail(ctx({ EMAIL_BCC: 'chris@thewbsproject.com' }), ALERT);
    expect(bodyOf(fetchSpy).bcc).toEqual(['chris@thewbsproject.com']);
  });

  it('a paused support copy skips the separate COPY: and records paused rows for it', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"id":"re_user"}'));
    await pause('support-copy');

    const outcome = await sendMailingListWelcomeEmail(
      ctx({
        EMAIL_BCC: 'ops@aecintegrations.com',
        PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
      }),
      { to: 'sub@example.com', token: 'tok' },
    );

    expect(outcome).toBe('sent');
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect((await rows()).map((r) => [r.notificationId, r.outcome])).toEqual([
      ['mailing-list-welcome', 'sent'],
      ['mailing-list-welcome-operator-copy', 'paused'],
    ]);
  });
});

describe('sendEmail (digests) and the sending switches', () => {
  const MSG = {
    notification: 'digest-data-quality' as const,
    from: 'AECi <dq@aecintegrations.com>',
    to: ['a@thewbsproject.com', 'b@thewbsproject.com'],
    subject: 'subj',
    text: 'body',
  };
  const silent = { warn: () => {}, error: () => {} };
  const DB = {} as D1Database;

  it('a paused digest makes no call and writes one paused row per recipient', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"id":"re_d"}'));
    await pause('digest-data-quality');

    const out = await sendEmail(
      { ENV: 'production', RESEND_API_KEY: 'k', DB },
      MSG,
      fetchImpl as unknown as typeof fetch,
      silent,
    );

    expect(out).toBe('paused');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await rows()).map((r) => [r.notificationId, r.outcome])).toEqual([
      ['digest-data-quality', 'paused'],
      ['digest-data-quality', 'paused'],
    ]);
  });

  it('a paused support copy drops the digest blind copy', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"id":"re_d"}'));
    await pause('support-copy');
    await sendEmail(
      { ENV: 'production', RESEND_API_KEY: 'k', DB, EMAIL_BCC: 'chris@thewbsproject.com' },
      MSG,
      fetchImpl as unknown as typeof fetch,
      silent,
    );
    const body = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty('bcc');
  });

  it('a failed read sends anyway and counts it when telemetry is given', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"id":"re_d"}'));
    const real = t.db as Db;
    vi.mocked(ledgerDb).mockReturnValue(
      new Proxy(real, {
        get(target, prop, receiver) {
          if (prop === 'select') {
            return () => {
              throw new Error('D1_ERROR');
            };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      }),
    );
    const out = await sendEmail(
      { ENV: 'production', RESEND_API_KEY: 'k', DB },
      MSG,
      fetchImpl as unknown as typeof fetch,
      silent,
      ctx(),
    );
    expect(out).toBe('sent');
    expect(metric('aeci.email.switches.unavailable')).toEqual([['layer:digest']]);
  });
});
