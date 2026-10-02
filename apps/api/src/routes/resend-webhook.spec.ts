/**
 * `POST /api/webhooks/resend` (AECI-1222) against the in-memory D1 harness, end to end:
 * a real Svix signature over the raw body, the real migration-built tables, and the real
 * join to `notification_sends`. PostHog is the one mock, so the metric tags can be read.
 */

import { createHmac } from 'node:crypto';

import { asc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { notificationDeliveryEvents, notificationSends } from '../db/schema';
import type { Env } from '../env';
import { recipientHash } from '../lib/hash';
import { logToPosthog, submitCount } from '../posthog';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext } from '../test/helpers';
import { createResendWebhookHandler, EMAIL_DELIVERY_METRIC } from './webhooks';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const KEY = Buffer.from('resend-webhook-test-key');
const SECRET = `whsec_${KEY.toString('base64')}`;
const PROD: Env = { ENV: 'production', RESEND_WEBHOOK_SECRET: SECRET };
const STAGING: Env = { ENV: 'staging', RESEND_WEBHOOK_SECRET: SECRET };

type Rec = Record<string, unknown>;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  vi.mocked(submitCount).mockClear();
  vi.mocked(logToPosthog).mockClear();
});
afterEach(() => t.dispose());

const app = () =>
  buildAppWithHandler({
    method: 'post',
    path: '/api/webhooks/resend',
    handler: createResendWebhookHandler(t.factory),
  });

function signed(raw: string, id: string, ts = String(Math.floor(Date.now() / 1000))) {
  const sig = createHmac('sha256', KEY).update(`${id}.${ts}.${raw}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
}

async function post(
  body: Rec,
  opts: { env?: Env; id?: string; headers?: Record<string, string> } = {},
) {
  const raw = JSON.stringify(body);
  const id = opts.id ?? 'msg_1';
  return app().request(
    '/api/webhooks/resend',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.headers ?? signed(raw, id)) },
      body: raw,
    },
    opts.env ?? PROD,
    fakeExecutionContext(),
  );
}

function event(type: string, data: Rec = {}): Rec {
  return {
    type,
    created_at: '2026-10-02T10:00:00.000Z',
    data: {
      email_id: 'em_1',
      from: 'AEC Integrations <notifications@aecintegrations.com>',
      to: ['Reviewer <R@Example.com>'],
      subject: 'Your review is in',
      tags: { tier: 'production', notification_id: 'review-submitted' },
      ...data,
    },
  };
}

async function ledgerRow(
  address: string,
  over: Partial<typeof notificationSends.$inferInsert> = {},
) {
  const [row] = await t.db
    .insert(notificationSends)
    .values({
      notificationId: 'review-submitted',
      recipientHash: await recipientHash(address),
      tier: 'production',
      outcome: 'sent',
      providerMessageId: 'em_1',
      ...over,
    })
    .returning({ id: notificationSends.id });
  return row!.id;
}

const events = () =>
  t.db.select().from(notificationDeliveryEvents).orderBy(asc(notificationDeliveryEvents.id));

/** Every `aeci.email.delivery` tag list this test. */
function deliveryTags(): Array<{ value: number; tags: string[] }> {
  return vi
    .mocked(submitCount)
    .mock.calls.filter((call) => call[3] === EMAIL_DELIVERY_METRIC)
    .map((call) => ({ value: call[4] as number, tags: call[5] as string[] }));
}

describe('POST /api/webhooks/resend — signature', () => {
  it('rejects a missing signature with 401 and writes nothing', async () => {
    const res = await post(event('email.delivered'), { headers: {} });
    expect(res.status).toBe(401);
    expect(await events()).toHaveLength(0);
  });

  it('rejects a bad signature with 401 and counts the reason', async () => {
    const raw = JSON.stringify(event('email.delivered'));
    const headers = { ...signed(raw, 'msg_1'), 'svix-signature': 'v1,AAAA' };
    const res = await post(event('email.delivered'), { headers });
    expect(res.status).toBe(401);
    expect(await events()).toHaveLength(0);
    const failure = vi
      .mocked(submitCount)
      .mock.calls.find((c) => c[3] === 'aeci.webhooks.resend.signature_failure');
    expect(failure?.[5]).toEqual(['reason:mismatch']);
  });

  it('rejects a stale timestamp with 401', async () => {
    const body = event('email.delivered');
    const stale = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const res = await post(body, { headers: signed(JSON.stringify(body), 'msg_1', stale) });
    expect(res.status).toBe(401);
    expect(await events()).toHaveLength(0);
  });

  it('fails closed and warns when RESEND_WEBHOOK_SECRET is unset', async () => {
    const res = await post(event('email.delivered'), { env: { ENV: 'production' } });
    expect(res.status).toBe(401);
    expect(await events()).toHaveLength(0);
    expect(vi.mocked(logToPosthog).mock.calls[0]?.[3]).toMatchObject({ level: 'warn' });
  });

  it('answers 400 to a signed body that is not JSON', async () => {
    const raw = 'not json';
    const res = await app().request(
      '/api/webhooks/resend',
      { method: 'POST', headers: signed(raw, 'msg_1'), body: raw },
      PROD,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/webhooks/resend — recording', () => {
  it('writes a signed event and joins it to its ledger row', async () => {
    const sendId = await ledgerRow('r@example.com');
    const res = await post(event('email.delivered'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recorded: 1, reason: 'recorded' });

    const [row] = await events();
    expect(row).toMatchObject({
      svixId: 'msg_1',
      providerMessageId: 'em_1',
      eventType: 'delivered',
      notificationSendId: sendId,
      notificationId: 'review-submitted',
      tier: 'production',
      recipientHash: await recipientHash('r@example.com'),
      occurredAt: '2026-10-02T10:00:00.000Z',
      bounceType: null,
    });
  });

  it('records a replayed svix-id once, and the replay still answers 200', async () => {
    await ledgerRow('r@example.com');
    expect((await post(event('email.delivered'))).status).toBe(200);
    const replay = await post(event('email.delivered'));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, recorded: 0, reason: 'replay' });
    expect(await events()).toHaveLength(1);
    expect(deliveryTags().map((d) => d.tags.at(-1))).toEqual([
      'outcome:recorded',
      'outcome:replay',
    ]);
  });

  it('picks the right ledger row when several share one message id', async () => {
    // A digest: one Resend call, one row per recipient, all sharing the id.
    await ledgerRow('a@aecintegrations.com', { notificationId: 'digest-data-quality' });
    const bId = await ledgerRow('b@aecintegrations.com', { notificationId: 'digest-data-quality' });
    await post(
      event('email.bounced', {
        to: ['b@aecintegrations.com'],
        tags: { tier: 'production', notification_id: 'digest-data-quality' },
        bounce: { type: 'Permanent', subType: 'General', message: 'no such user' },
      }),
    );
    const [row] = await events();
    expect(row).toMatchObject({
      notificationSendId: bId,
      notificationId: 'digest-data-quality',
      eventType: 'bounced',
      bounceType: 'Permanent',
      bounceSubtype: 'General',
    });
  });

  it('joins a retried send to the earliest row that carries the id', async () => {
    const first = await ledgerRow('r@example.com');
    await ledgerRow('r@example.com'); // Idempotency-Key handed back the first id
    await post(event('email.delivered'));
    expect((await events())[0]?.notificationSendId).toBe(first);
  });

  it('writes one row per impacted recipient and stores a BCC recipient unjoined', async () => {
    const sendId = await ledgerRow('r@example.com');
    await post(event('email.delivered', { to: ['r@example.com', 'support@aecintegrations.com'] }));
    const rows = await events();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.notificationSendId).toBe(sendId);
    expect(rows[1]).toMatchObject({
      notificationSendId: null,
      notificationId: 'review-submitted',
      recipientHash: await recipientHash('support@aecintegrations.com'),
    });
    expect(deliveryTags()).toEqual([
      {
        value: 2,
        tags: [
          'event:delivered',
          'template:review-submitted',
          'tier:production',
          'outcome:recorded',
        ],
      },
    ]);
  });

  it('stores an event with no ledger row unjoined, never inventing one', async () => {
    await post(event('email.sent'));
    expect(await events()).toEqual([
      expect.objectContaining({ notificationSendId: null, notificationId: 'review-submitted' }),
    ]);
    expect(await t.db.select().from(notificationSends)).toHaveLength(0);
  });
});

describe('POST /api/webhooks/resend — tier filter', () => {
  it('drops an event tagged for another tier, counts it, and stores nothing', async () => {
    const res = await post(
      event('email.bounced', { tags: { tier: 'staging', notification_id: 'review-submitted' } }),
    );
    expect(res.status).toBe(200);
    expect(await events()).toHaveLength(0);
    expect(deliveryTags()).toEqual([
      {
        value: 1,
        tags: ['event:bounced', 'template:unknown', 'tier:staging', 'outcome:other_tier'],
      },
    ]);
  });

  it('staging keeps its own events and drops production ones', async () => {
    await post(
      event('email.delivered', { tags: { tier: 'staging', notification_id: 'review-submitted' } }),
      { env: STAGING, id: 'msg_a' },
    );
    await post(event('email.delivered'), { env: STAGING, id: 'msg_b' });
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ svixId: 'msg_a', tier: 'staging' });
  });

  it('records a sign-in bounce on production as tier auth', async () => {
    const res = await post(
      event('email.bounced', {
        subject: 'Sign in to AEC Integrations',
        to: ['person@gmail.com'],
        tags: undefined,
        bounce: { type: 'Permanent', subType: 'Suppressed' },
      }),
    );
    expect(res.status).toBe(200);
    const [row] = await events();
    expect(row).toMatchObject({
      tier: 'auth',
      notificationId: 'supabase-sign-in',
      notificationSendId: null,
      eventType: 'bounced',
      bounceSubtype: 'Suppressed',
    });
    expect(deliveryTags()[0]?.tags).toEqual([
      'event:bounced',
      'template:supabase-sign-in',
      'tier:auth',
      'outcome:recorded',
    ]);
  });

  it('drops the sign-in stream on a non-production tier', async () => {
    await post(
      event('email.bounced', {
        subject: 'Sign in to AEC Integrations',
        tags: undefined,
      }),
      { env: STAGING },
    );
    expect(await events()).toHaveLength(0);
    expect(deliveryTags()[0]?.tags.at(-1)).toBe('outcome:untagged');
  });

  it('acknowledges opens, clicks and other types without storing them', async () => {
    for (const [i, type] of ['email.opened', 'email.clicked', 'contact.created'].entries()) {
      const res = await post(event(type), { id: `msg_${i}` });
      expect(res.status).toBe(200);
    }
    expect(await events()).toHaveLength(0);
    expect(deliveryTags().every((d) => d.tags.includes('outcome:ignored'))).toBe(true);
  });
});

describe('POST /api/webhooks/resend — the PostHog payload', () => {
  it('never carries a recipient address or hash in any metric or log', async () => {
    await ledgerRow('r@example.com');
    await post(event('email.delivered'));
    await post(event('email.bounced', { tags: { tier: 'staging' } }), { id: 'msg_2' });
    const hash = await recipientHash('r@example.com');
    const sent = JSON.stringify([
      vi.mocked(submitCount).mock.calls.map((c) => c.slice(3)),
      vi.mocked(logToPosthog).mock.calls.map((c) => c[3]),
    ]);
    expect(sent.toLowerCase()).not.toContain('r@example.com');
    expect(sent).not.toContain(hash);
    expect(sent).not.toContain('@');
  });
});
