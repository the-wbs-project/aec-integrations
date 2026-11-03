/**
 * AECI-1587 — the failure alert's dedupe key, retry maths and failure isolation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { submitCount } from '../posthog';
import {
  CRON_FAILURE_EMAIL_METRIC,
  cronFailureAlertKey,
  queueWillRetry,
  sendCronFailureAlert,
} from './cron-failure-alert';
import { sendCronJobFailedAlert, type EmailContext } from './email';

vi.mock('../posthog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../posthog')>()),
  submitCount: vi.fn(),
}));
vi.mock('./email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./email')>()),
  sendCronJobFailedAlert: vi.fn(),
}));

const FAILURE = {
  job: 'stripe-reconcile',
  reason: 'list subscriptions: network 0',
  failedAt: '2026-11-03T01:15:27.000Z',
} as const;

const c = {
  env: { SUPPORT_EMAIL: 'support@aecintegrations.com' },
  executionCtx: { waitUntil: vi.fn() },
  req: { raw: new Request('https://aeci-api/cron/failure-alert') },
} as unknown as EmailContext;

afterEach(() => vi.clearAllMocks());

describe('queueWillRetry', () => {
  it('is true until the delivery after the last retry', () => {
    expect([1, 2, 3, 4].map(queueWillRetry)).toEqual([true, true, true, false]);
  });
});

describe('cronFailureAlertKey', () => {
  it('holds for the same job, day and reason', async () => {
    const key = await cronFailureAlertKey('a', '2026-11-03', 'boom');
    expect(key).toMatch(/^cron-job-failed-alert:a:2026-11-03:[0-9a-f]{16}$/);
    expect(await cronFailureAlertKey('a', '2026-11-03', 'boom')).toBe(key);
  });

  it.each([
    ['job', 'b', '2026-11-03', 'boom'],
    ['day', 'a', '2026-11-04', 'boom'],
    ['reason', 'a', '2026-11-03', 'other'],
  ])('changes with the %s', async (_axis, job, day, reason) => {
    const key = await cronFailureAlertKey('a', '2026-11-03', 'boom');
    expect(await cronFailureAlertKey(job, day, reason)).not.toBe(key);
  });
});

describe('sendCronFailureAlert', () => {
  it('sends with the key and counts the outcome', async () => {
    vi.mocked(sendCronJobFailedAlert).mockResolvedValue('sent');

    await expect(sendCronFailureAlert(c, FAILURE, 4)).resolves.toBe('sent');

    expect(sendCronJobFailedAlert).toHaveBeenCalledWith(
      c,
      expect.objectContaining({
        to: 'support@aecintegrations.com',
        job: 'stripe-reconcile',
        attempts: 4,
        dedupeKey: await cronFailureAlertKey('stripe-reconcile', '2026-11-03', FAILURE.reason),
      }),
    );
    expect(submitCount).toHaveBeenCalledWith(
      c.executionCtx,
      c.env,
      c.req.raw,
      CRON_FAILURE_EMAIL_METRIC,
      1,
      ['job:stripe-reconcile', 'outcome:sent'],
    );
  });

  it('counts a thrown send as failed and does not reject', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(sendCronJobFailedAlert).mockRejectedValue(new Error('resend down'));

    await expect(sendCronFailureAlert(c, FAILURE, 1)).resolves.toBe('failed');

    expect(submitCount).toHaveBeenCalledWith(
      c.executionCtx,
      c.env,
      c.req.raw,
      CRON_FAILURE_EMAIL_METRIC,
      1,
      ['job:stripe-reconcile', 'outcome:failed'],
    );
  });
});
