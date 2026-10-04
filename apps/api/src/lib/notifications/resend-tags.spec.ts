/**
 * Resend `tags` on every send (AECI-1222). The delivery webhook keeps only its own tier's
 * events by the `tier` tag and names the template by `notification_id`, so all three Resend
 * call sites must carry both: the transactional send, the operator `COPY:`, and the digest
 * `sendEmail`.
 */

import type { Context } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../env';
import { sendEmail, sendMailingListWelcomeEmail, sendTransactionalEmail } from '../email';
import type { EmailContext } from '../email';
import { resendTags, sanitizeTagValue } from './resend-tags';

vi.mock('../../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

function ctx(env: Partial<Env> = {}): EmailContext {
  return {
    env: {
      ENV: 'production',
      RESEND_API_KEY: 'rk_test',
      EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
      ...env,
    } as Env,
    executionCtx: { waitUntil: () => {}, passThroughOnException: () => {} },
    req: { raw: new Request('https://api.test/x', { method: 'POST' }) },
  } as unknown as Context<{ Bindings: Env }>;
}

const bodyAt = (spy: { mock: { calls: unknown[][] } }, i: number) =>
  JSON.parse(String((spy.mock.calls[i]![1] as RequestInit).body)) as { tags?: unknown };

describe('sanitizeTagValue', () => {
  it('passes Resend-legal values through unchanged', () => {
    expect(sanitizeTagValue('production')).toBe('production');
    expect(sanitizeTagValue('non-production')).toBe('non-production');
    expect(sanitizeTagValue('digest-data-quality')).toBe('digest-data-quality');
    expect(sanitizeTagValue('A_b-9')).toBe('A_b-9');
  });

  it('replaces every character outside [A-Za-z0-9_-] and caps at 256', () => {
    expect(sanitizeTagValue('a.b c/d:é')).toBe('a_b_c_d__');
    expect(sanitizeTagValue('x'.repeat(300))).toHaveLength(256);
    expect(sanitizeTagValue('')).toBe('_');
  });

  it('builds the tier and notification_id tags from the env', () => {
    expect(resendTags({ ENV: 'staging' }, 'review-submitted')).toEqual([
      { name: 'tier', value: 'staging' },
      { name: 'notification_id', value: 'review-submitted' },
    ]);
    // An unknown or missing ENV is `non-production`, the tier policy's own label.
    expect(resendTags({}, 'review-submitted')[0]).toEqual({
      name: 'tier',
      value: 'non-production',
    });
  });
});

describe('every Resend call carries tier and notification_id tags', () => {
  it('the transactional send', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"id":"re_1"}', { status: 200 }));
    await sendTransactionalEmail(ctx(), {
      to: 'r@example.com',
      subject: 'Hi',
      text: 'Body',
      template: 'review-submitted',
    });
    expect(bodyAt(spy, 0).tags).toEqual([
      { name: 'tier', value: 'production' },
      { name: 'notification_id', value: 'review-submitted' },
    ]);
  });

  it('the operator COPY: names its own registry id', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response('{"id":"re_1"}', { status: 200 }));
    await sendMailingListWelcomeEmail(
      ctx({ EMAIL_BCC: 'support@aecintegrations.com', PUBLIC_SITE_URL: 'https://x.test' }),
      { to: 'sub@example.com', token: 'tok' },
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(bodyAt(spy, 0).tags).toEqual([
      { name: 'tier', value: 'production' },
      { name: 'notification_id', value: 'mailing-list-welcome' },
    ]);
    expect(bodyAt(spy, 1).tags).toEqual([
      { name: 'tier', value: 'production' },
      { name: 'notification_id', value: 'mailing-list-welcome-operator-copy' },
    ]);
  });

  it('the digest sendEmail', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"id":"re_2"}', { status: 200 }));
    await sendEmail(
      { ENV: 'production', RESEND_API_KEY: 'k' },
      {
        notification: 'digest-data-quality',
        from: 'AECi <dq@aecintegrations.com>',
        to: ['ops@aecintegrations.com'],
        subject: 's',
        text: 't',
      },
      fetchImpl as unknown as typeof fetch,
      { warn: () => {}, error: () => {} },
    );
    expect(bodyAt(fetchImpl, 0).tags).toEqual([
      { name: 'tier', value: 'production' },
      { name: 'notification_id', value: 'digest-data-quality' },
    ]);
  });
});
