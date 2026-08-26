/**
 * Unit tests for the admin-alert seam (AECI-214 / Phase 6.7, transport wired in
 * AECI-240 / Phase 7.5). `sendAdminAlert` now delegates to Resend via
 * `sendStuckRequestAdminAlert` (`lib/email.ts`), then emits the
 * `aeci.linear.reconcile.email` outcome metric and logs the digest. It stays
 * fail-open: an absent key/recipient yields `'skipped'` and the Datadog alert
 * raised by the sweep is the backstop. The email transport itself is covered by
 * `email.spec.ts`; here we lock the seam's contract (delegation + metric + log).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeExecutionContext, TEST_ENV } from '../test/helpers';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  submitCount: vi.fn(),
}));

vi.mock('./email', () => ({
  sendStuckRequestAdminAlert: vi.fn(),
}));

import { logToPosthog, submitCount } from '../posthog';
import { sendStuckRequestAdminAlert } from './email';
import { sendAdminAlert, type AdminAlert } from './admin-alert';

function ctx(envOverrides: Record<string, unknown> = {}) {
  return {
    env: { ...TEST_ENV, ...envOverrides },
    executionCtx: fakeExecutionContext(),
    req: { raw: new Request('https://api.test/cron/reconcile') },
  };
}

const ALERT: AdminAlert = {
  kind: 'stuck_requests',
  rows: [
    {
      requestId: 'req-1',
      kind: 'claim',
      targetType: 'vendor',
      targetName: 'Globex Inc',
      ageMinutes: 95,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the transport reports a successful send.
  vi.mocked(sendStuckRequestAdminAlert).mockResolvedValue('sent');
});

describe('sendAdminAlert', () => {
  it('delegates to the Resend transport with the recipient + rows and returns its outcome', async () => {
    const c = ctx({ ADMIN_ALERT_EMAIL: 'ops@aecintegrations.com' });
    const outcome = await sendAdminAlert(c, ALERT);

    expect(outcome).toBe('sent');
    expect(sendStuckRequestAdminAlert).toHaveBeenCalledWith(
      c,
      expect.objectContaining({ to: 'ops@aecintegrations.com', rows: ALERT.rows }),
    );
    expect(submitCount).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'aeci.linear.reconcile.email',
      1,
      ['outcome:sent'],
    );
  });

  it('emits outcome:failed and warns when the send fails', async () => {
    vi.mocked(sendStuckRequestAdminAlert).mockResolvedValue('failed');
    const outcome = await sendAdminAlert(
      ctx({ ADMIN_ALERT_EMAIL: 'ops@aecintegrations.com' }),
      ALERT,
    );

    expect(outcome).toBe('failed');
    expect(submitCount).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'aeci.linear.reconcile.email',
      1,
      ['outcome:failed'],
    );
    expect(logToPosthog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ level: 'warn', source: 'reconcile' }),
    );
  });

  it('passes no recipient and skips when ADMIN_ALERT_EMAIL is unset', async () => {
    vi.mocked(sendStuckRequestAdminAlert).mockResolvedValue('skipped');
    const outcome = await sendAdminAlert(ctx(), ALERT);

    expect(outcome).toBe('skipped');
    expect(sendStuckRequestAdminAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: undefined }),
    );
    expect(logToPosthog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ message: expect.stringContaining('recipient=unset') }),
    );
  });

  it('logs the recipient when ADMIN_ALERT_EMAIL is set', async () => {
    await sendAdminAlert(ctx({ ADMIN_ALERT_EMAIL: 'ops@aecintegrations.com' }), ALERT);

    expect(logToPosthog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        source: 'reconcile',
        message: expect.stringContaining('ops@aecintegrations.com'),
      }),
    );
  });

  it('never throws (empty digest still resolves)', async () => {
    vi.mocked(sendStuckRequestAdminAlert).mockResolvedValue('skipped');
    await expect(sendAdminAlert(ctx(), { kind: 'stuck_requests', rows: [] })).resolves.toBe(
      'skipped',
    );
  });
});
