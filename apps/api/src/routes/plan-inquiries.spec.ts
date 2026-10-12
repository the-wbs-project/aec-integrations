/**
 * `POST /api/plan-inquiries` (AECI-1279) against the in-memory D1 harness.
 *
 * The two sends are fire-and-forget, so `lib/email` is mocked and the specs assert
 * what each is called with: the receipt's per-address-per-day dedupe key, the alert's
 * fields, and that nothing at all happens on validation failure or a filled honeypot.
 * The reply-to and the rendered copy are covered in `lib/email.spec.ts`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LANDING_CF_HEADERS } from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { planInquiries } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { sendPlanInquiryAlert, sendPlanInquiryReceivedEmail } from '../lib/email';
import { recipientHash } from '../lib/hash';
import { rateLimit } from '../rate-limit-middleware';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createPlanInquiryHandler } from './plan-inquiries';

vi.mock('../lib/email', () => ({
  sendPlanInquiryReceivedEmail: vi.fn(() => Promise.resolve('sent')),
  sendPlanInquiryAlert: vi.fn(() => Promise.resolve('sent')),
}));

let t: TestDb;
beforeEach(async () => {
  vi.mocked(sendPlanInquiryReceivedEmail).mockClear();
  vi.mocked(sendPlanInquiryAlert).mockClear();
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const VALID = {
  topic: 'managed',
  email: '  buyer@example.com ',
  company: ' Acme Construction Software ',
  details: 'Procore connector and the Revit add-in.',
  referrer: 'https://www.aecintegrations.com/docs/vendors/plans',
};

async function post(
  body: unknown,
  opts: { headers?: Record<string, string>; ctx?: ExecutionContext } = {},
) {
  const app = buildAppWithHandler({
    method: 'post',
    path: '/api/plan-inquiries',
    handler: createPlanInquiryHandler(t.factory),
  });
  return app.request(
    '/api/plan-inquiries',
    {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    },
    TEST_ENV,
    opts.ctx ?? fakeExecutionContext(),
  );
}

describe('POST /api/plan-inquiries', () => {
  it('saves the inquiry, trimmed, with the trusted geo, and answers 201 { received: true }', async () => {
    const res = await post(VALID, {
      headers: {
        [LANDING_CF_HEADERS.country]: 'GB',
        [LANDING_CF_HEADERS.city]: 'London',
        [LANDING_CF_HEADERS.region]: 'England',
        [LANDING_CF_HEADERS.timezone]: 'Europe/London',
      },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ received: true });

    const rows = await t.db.select().from(planInquiries);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      topic: 'managed',
      email: 'buyer@example.com',
      company: 'Acme Construction Software',
      details: 'Procore connector and the Revit add-in.',
      country: 'GB',
      city: 'London',
      region: 'England',
      timezone: 'Europe/London',
      referrer: VALID.referrer,
    });
    expect(rows[0]!.createdAt).toBeTruthy();
  });

  it('stores an empty details answer as null', async () => {
    await post({ ...VALID, details: '   ' });
    const [row] = await t.db.select().from(planInquiries);
    expect(row!.details).toBeNull();
  });

  it('sends the receipt once per address per UTC day, and the alert every time', async () => {
    const ctx = fakeExecutionContext();
    await post(VALID, { ctx });
    expect(ctx.waitUntil).toHaveBeenCalledTimes(2);

    const [row] = await t.db.select().from(planInquiries);
    const inquiry = {
      inquiryId: String(row!.id),
      planName: 'Managed',
      email: 'buyer@example.com',
      company: 'Acme Construction Software',
      details: 'Procore connector and the Revit add-in.',
    };
    const entity = { type: 'plan_inquiry', id: String(row!.id) };
    const day = new Date().toISOString().slice(0, 10);

    expect(sendPlanInquiryReceivedEmail).toHaveBeenCalledTimes(1);
    const [, receipt] = vi.mocked(sendPlanInquiryReceivedEmail).mock.calls[0]!;
    expect(receipt).toEqual({
      inquiry,
      entity,
      dedupeKey: `plan-inquiry-received:${await recipientHash('buyer@example.com')}:${day}`,
    });
    // The key carries a hash, never the address.
    expect(receipt.dedupeKey).not.toContain('buyer@example.com');

    expect(sendPlanInquiryAlert).toHaveBeenCalledTimes(1);
    const [, alert] = vi.mocked(sendPlanInquiryAlert).mock.calls[0]!;
    expect(alert).toEqual({
      inquiry,
      entity,
      city: null,
      region: null,
      country: null,
      referrer: VALID.referrer,
    });
    expect(alert.dedupeKey).toBeUndefined();
  });

  it('treats a filled honeypot as success, and saves and sends nothing', async () => {
    const ctx = fakeExecutionContext();
    const res = await post({ ...VALID, website: 'https://spam.example' }, { ctx });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ received: true });
    expect(await t.db.select().from(planInquiries)).toHaveLength(0);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(sendPlanInquiryReceivedEmail).not.toHaveBeenCalled();
    expect(sendPlanInquiryAlert).not.toHaveBeenCalled();
  });

  it('ignores an empty honeypot', async () => {
    const res = await post({ ...VALID, website: '' });
    expect(res.status).toBe(201);
    expect(await t.db.select().from(planInquiries)).toHaveLength(1);
  });

  it.each([
    ['no email', { ...VALID, email: undefined }],
    ['a bad email', { ...VALID, email: 'not-an-email' }],
    ['no company', { ...VALID, company: '   ' }],
    ['a company over 200 characters', { ...VALID, company: 'x'.repeat(201) }],
    ['details over 2000 characters', { ...VALID, details: 'x'.repeat(2001) }],
    ['an unknown topic', { ...VALID, topic: 'enterprise' }],
  ])('400s %s, and saves and sends nothing', async (_label, body) => {
    const ctx = fakeExecutionContext();
    const res = await post(body, { ctx });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    );
    expect(await t.db.select().from(planInquiries)).toHaveLength(0);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it('400s a body that is not JSON', async () => {
    const res = await post('not json');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'MALFORMED_REQUEST',
    );
  });
});

describe('rate limit (AECI-1279)', () => {
  const index = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');
  const squash = (s: string) => s.replace(/\s+/g, ' ');

  it('registers the route on the token bucket, keyed by IP', () => {
    expect(squash(index)).toContain(
      "phase28.post('/api/plan-inquiries', rateLimit('token', { by: 'ip' }), createPlanInquiryHandler());",
    );
  });

  it('a tripped limiter answers 429 before the handler saves or sends anything', async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.onError(errorHandler());
    app.post(
      '/api/plan-inquiries',
      rateLimit('token', { by: 'ip' }),
      createPlanInquiryHandler(t.factory),
    );
    const ctx = fakeExecutionContext();
    const res = await app.request(
      '/api/plan-inquiries',
      {
        method: 'POST',
        body: JSON.stringify(VALID),
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
      },
      {
        ...TEST_ENV,
        TOKEN_RATE_LIMIT: { limit: async () => ({ success: false }) },
      } as unknown as Env,
      ctx,
    );
    expect(res.status).toBe(429);
    expect(await t.db.select().from(planInquiries)).toHaveLength(0);
    expect(sendPlanInquiryReceivedEmail).not.toHaveBeenCalled();
    expect(sendPlanInquiryAlert).not.toHaveBeenCalled();
  });
});
