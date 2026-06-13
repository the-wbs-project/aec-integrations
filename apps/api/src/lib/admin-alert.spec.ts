/**
 * Unit tests for the admin-alert seam (AECI-214 / Phase 6.7). Until Phase 7 wires
 * Loops (§14) this is a fail-open no-op: it returns `'skipped'`, emits the email
 * outcome metric, and logs — the Datadog alert raised by the sweep is the
 * backstop. These lock in that contract so Phase 7's transport swap is the only
 * change needed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeExecutionContext, TEST_ENV } from '../test/helpers';

vi.mock('../datadog', () => ({
  logToDatadog: vi.fn(),
  submitCount: vi.fn(),
}));

import { logToDatadog, submitCount } from '../datadog';
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

beforeEach(() => vi.clearAllMocks());

describe('sendAdminAlert', () => {
  it('is a fail-open no-op (returns skipped + emits outcome:skipped) until Loops lands', async () => {
    const outcome = await sendAdminAlert(ctx(), ALERT);

    expect(outcome).toBe('skipped');
    expect(submitCount).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      'aeci.linear.reconcile.email',
      1,
      ['outcome:skipped'],
    );
  });

  it('logs the recipient when ADMIN_ALERT_EMAIL is set', async () => {
    await sendAdminAlert(ctx({ ADMIN_ALERT_EMAIL: 'ops@aecintegrations.com' }), ALERT);

    expect(logToDatadog).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        source: 'reconcile',
        message: expect.stringContaining('ops@aecintegrations.com'),
      }),
    );
  });

  it('never throws', async () => {
    await expect(sendAdminAlert(ctx(), { kind: 'stuck_requests', rows: [] })).resolves.toBe(
      'skipped',
    );
  });
});
