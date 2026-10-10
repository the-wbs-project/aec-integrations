/**
 * `/api/admin/email/*` (AECI-1223), against the in-memory D1 harness with seeded ledger
 * and delivery-event rows. Source of truth: `docs/ADMIN_PANEL_SPEC.md` §5.14.
 *
 * INVARIANT tests here. None should be deleted without reopening the decision behind it:
 *
 *   1. **No address and no full hash leaves the API.** The ledger is hash-only by design
 *      (ADR 0038, §13 D23). Asserted on the SERIALIZED body, so a Zod strip cannot hide a
 *      leak.
 *   2. **The GET list refuses an `address` parameter.** An address in a URL is written to
 *      Workers Logs; the search is a POST body.
 *   3. **The search matches the ledger's own normalization.** Case, whitespace and a
 *      `Name <a@b>` wrapper all find the same rows.
 *   4. **The sign-in panel is production-only.** Other tiers never record that stream, so
 *      a zero there would be a false statement.
 */

import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  AdminEmailSearchResponseSchema,
  AdminEmailSendsResponseSchema,
  AdminEmailSummaryResponseSchema,
  type AdminEmailSearchResponse,
  type AdminEmailSendsResponse,
  type AdminEmailSummaryResponse,
} from '@aeci/shared';

import {
  notificationDeliveryEvents,
  notificationSends,
  profiles,
  vendorRequests,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { entityLink } from '../lib/admin-email';
import { requireAdmin, type AuthzVariables } from '../lib/authz';
import { recipientHash } from '../lib/hash';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import {
  createAdminEmailSearchHandler,
  createAdminEmailSendsHandler,
  createAdminEmailSummaryHandler,
} from './admin-email';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const clock = { now: () => NOW };
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const PREVIEW = { ENV: 'staging' } as Env;
const PRODUCTION = { ENV: 'production' } as Env;

const ALICE = 'Alice@Example.com';
const BOB = 'bob@example.com';
const CLAIM_ID = '00000000-0000-4000-8000-000000000101';
const CORRECTION_ID = '00000000-0000-4000-8000-000000000102';

let t: TestDb;
let aliceHash: string;
let bobHash: string;

beforeAll(async () => {
  aliceHash = await recipientHash(ALICE);
  bobHash = await recipientHash(BOB);
});
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

interface SendSeed {
  notificationId: string;
  recipientHash: string;
  outcome: string;
  createdAt: string;
  providerMessageId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
}

async function seedSend(row: SendSeed): Promise<number> {
  const [inserted] = await t.db
    .insert(notificationSends)
    .values({
      notificationId: row.notificationId,
      recipientHash: row.recipientHash,
      tier: 'production',
      outcome: row.outcome as 'sent',
      providerMessageId: row.providerMessageId ?? null,
      entityType: row.entityType ?? null,
      entityId: row.entityId ?? null,
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
    })
    .returning({ id: notificationSends.id });
  return inserted!.id;
}

let svix = 0;
async function seedEvent(row: {
  providerMessageId: string;
  eventType: string;
  sendId: number | null;
  notificationId: string;
  recipientHash: string;
  occurredAt: string;
  createdAt?: string;
  tier?: string;
  bounceType?: string;
}) {
  svix += 1;
  await t.db.insert(notificationDeliveryEvents).values({
    svixId: `msg_${svix}`,
    providerMessageId: row.providerMessageId,
    eventType: row.eventType as 'delivered',
    notificationSendId: row.sendId,
    notificationId: row.notificationId,
    tier: row.tier ?? 'production',
    recipientHash: row.recipientHash,
    bounceType: row.bounceType ?? null,
    bounceSubtype: null,
    occurredAt: row.occurredAt,
    createdAt: row.createdAt ?? row.occurredAt,
  });
}

function app() {
  const a = new Hono<{ Bindings: Env }>();
  a.onError(errorHandler());
  a.get('/api/admin/email/summary', createAdminEmailSummaryHandler(t.factory, clock));
  a.get('/api/admin/email/sends', createAdminEmailSendsHandler(t.factory, clock));
  a.post('/api/admin/email/sends/search', createAdminEmailSearchHandler(t.factory, clock));
  return a;
}

const get = (path: string, env: Env = PREVIEW) =>
  app().request(path, {}, env, fakeExecutionContext());

const search = (body: unknown, env: Env = PREVIEW) =>
  app().request(
    '/api/admin/email/sends/search',
    { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
    env,
    fakeExecutionContext(),
  );

async function list(query = ''): Promise<AdminEmailSendsResponse> {
  const res = await get(`/api/admin/email/sends${query}`);
  expect(res.status).toBe(200);
  return AdminEmailSendsResponseSchema.parse(await res.json());
}

/** A small, realistic ledger: three claim emails, one bounced, one digest, one old row. */
async function seedLedger() {
  const approved = await seedSend({
    notificationId: 'claim-approved',
    recipientHash: aliceHash,
    outcome: 'sent',
    providerMessageId: 're_1',
    entityType: 'vendor_request',
    entityId: CLAIM_ID,
    createdAt: daysAgo(1),
  });
  await seedEvent({
    providerMessageId: 're_1',
    eventType: 'sent',
    sendId: approved,
    notificationId: 'claim-approved',
    recipientHash: aliceHash,
    occurredAt: '2026-10-01T12:00:01.000Z',
  });
  await seedEvent({
    providerMessageId: 're_1',
    eventType: 'delivered',
    sendId: approved,
    notificationId: 'claim-approved',
    recipientHash: aliceHash,
    occurredAt: '2026-10-01T12:00:05.000Z',
  });

  const rejected = await seedSend({
    notificationId: 'claim-rejected',
    recipientHash: bobHash,
    outcome: 'sent',
    providerMessageId: 're_2',
    entityType: 'vendor_request',
    entityId: CORRECTION_ID,
    createdAt: daysAgo(2),
  });
  await seedEvent({
    providerMessageId: 're_2',
    eventType: 'bounced',
    sendId: rejected,
    notificationId: 'claim-rejected',
    recipientHash: bobHash,
    occurredAt: '2026-09-30T12:00:05.000Z',
    bounceType: 'Permanent',
  });

  await seedSend({
    notificationId: 'claim-approved',
    recipientHash: aliceHash,
    outcome: 'failed',
    createdAt: daysAgo(3),
  });
  await seedSend({
    notificationId: 'claim-approved',
    recipientHash: bobHash,
    outcome: 'suppressed',
    createdAt: daysAgo(10),
  });
  // Outside 30 days: in the list, not in the summary.
  await seedSend({
    notificationId: 'review-approved',
    recipientHash: aliceHash,
    outcome: 'sent',
    providerMessageId: 're_old',
    createdAt: daysAgo(45),
  });
  // An id the registry no longer knows.
  await seedSend({
    notificationId: 'retired-template',
    recipientHash: bobHash,
    outcome: 'sent',
    providerMessageId: 're_3',
    createdAt: daysAgo(5),
  });
  await t.db.insert(vendorRequests).values([
    {
      id: CLAIM_ID,
      kind: 'claim',
      targetType: 'vendor',
      targetId: 'v',
      submitterEmail: 'x@vendor.test',
      body: 'claim body',
    },
    {
      id: CORRECTION_ID,
      kind: 'correction',
      targetType: 'vendor',
      targetId: 'v',
      submitterEmail: 'x@vendor.test',
      body: 'correction body',
    },
  ]);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

describe('GET /api/admin/email/summary', () => {
  it('counts ledger outcomes and delivery events per template, 7 and 30 days', async () => {
    await seedLedger();
    const res = await get('/api/admin/email/summary');
    expect(res.status).toBe(200);
    const body: AdminEmailSummaryResponse = AdminEmailSummaryResponseSchema.parse(await res.json());

    const approved = body.rows.find((r) => r.notification_id === 'claim-approved')!;
    expect(approved.registered).toBe(true);
    expect(approved.summary).toMatch(/claim/i);
    expect(approved.d7.outcomes).toMatchObject({ sent: 1, failed: 1, suppressed: 0 });
    expect(approved.d30.outcomes).toMatchObject({ sent: 1, failed: 1, suppressed: 1 });
    expect(approved.d7.delivery.delivered).toBe(1);

    const rejected = body.rows.find((r) => r.notification_id === 'claim-rejected')!;
    expect(rejected.d30.delivery.bounced).toBe(1);

    // Outside 30 days: no row at all.
    expect(body.rows.some((r) => r.notification_id === 'review-approved')).toBe(false);

    const retired = body.rows.find((r) => r.notification_id === 'retired-template')!;
    expect(retired.registered).toBe(false);
    expect(retired.summary).toBeNull();
  });

  it('offers every email registry entry as a template, and no portal or Linear entry', async () => {
    const body = AdminEmailSummaryResponseSchema.parse(
      await (await get('/api/admin/email/summary')).json(),
    );
    const ids = body.templates.map((x) => x.id);
    expect(ids).toContain('claim-approved');
    expect(ids).toContain('digest-analytics');
    expect(ids.some((id) => id.startsWith('portal-'))).toBe(false);
    expect(ids.some((id) => id.startsWith('linear-'))).toBe(false);
    expect(ids).not.toContain('supabase-sign-in');
    expect(body.rows).toEqual([]);
  });

  it('does not count a `sending` row in either group', async () => {
    await seedSend({
      notificationId: 'claim-approved',
      recipientHash: aliceHash,
      outcome: 'sending',
      createdAt: daysAgo(1),
    });
    const body = AdminEmailSummaryResponseSchema.parse(
      await (await get('/api/admin/email/summary')).json(),
    );
    expect(body.rows).toEqual([]);
  });

  it('reports the sign-in stream on production only, and keeps it out of the template rows', async () => {
    await seedEvent({
      providerMessageId: 're_auth',
      eventType: 'delivered',
      sendId: null,
      notificationId: 'supabase-sign-in',
      recipientHash: aliceHash,
      tier: 'auth',
      occurredAt: daysAgo(1),
    });
    await seedEvent({
      providerMessageId: 're_auth2',
      eventType: 'bounced',
      sendId: null,
      notificationId: 'supabase-sign-in',
      recipientHash: bobHash,
      tier: 'auth',
      occurredAt: daysAgo(20),
    });

    const preview = AdminEmailSummaryResponseSchema.parse(
      await (await get('/api/admin/email/summary', PREVIEW)).json(),
    );
    expect(preview.sign_in).toBeNull();
    expect(preview.environment).toBe('staging');

    const prod = AdminEmailSummaryResponseSchema.parse(
      await (await get('/api/admin/email/summary', PRODUCTION)).json(),
    );
    expect(prod.environment).toBe('production');
    expect(prod.sign_in?.d7).toMatchObject({ delivered: 1, bounced: 0 });
    expect(prod.sign_in?.d30).toMatchObject({ delivered: 1, bounced: 1 });
    expect(prod.rows.some((r) => r.notification_id === 'supabase-sign-in')).toBe(false);
  });
});

// ─── The list ─────────────────────────────────────────────────────────────────

describe('GET /api/admin/email/sends', () => {
  it('lists newest first with the latest delivery event and the entity link', async () => {
    await seedLedger();
    const body = await list();
    expect(body.total).toBe(6);
    expect(body.data.map((r) => r.notification_id)).toEqual([
      'claim-approved',
      'claim-rejected',
      'claim-approved',
      'retired-template',
      'claim-approved',
      'review-approved',
    ]);

    const [first, second, third] = body.data;
    // `delivered` happened after Resend's own `sent`, so it is the latest.
    expect(first!.latest_delivery?.event_type).toBe('delivered');
    expect(first!.entity).toEqual({
      type: 'vendor_request',
      id: CLAIM_ID,
      admin_path: `/admin/claims/${CLAIM_ID}`,
    });
    expect(second!.latest_delivery).toMatchObject({
      event_type: 'bounced',
      bounce_type: 'Permanent',
    });
    expect(second!.entity?.admin_path).toBe('/admin/requests');
    expect(third!.latest_delivery).toBeNull();
    expect(first!.recipient_hash_prefix).toBe(aliceHash.slice(0, 8));
  });

  it('filters by template, outcome, and inclusive date range', async () => {
    await seedLedger();
    expect((await list('?template=claim-approved')).total).toBe(3);
    expect((await list('?outcome=failed')).data.map((r) => r.outcome)).toEqual(['failed']);
    const from = daysAgo(3).slice(0, 10);
    const to = daysAgo(1).slice(0, 10);
    expect((await list(`?from=${from}&to=${to}`)).total).toBe(3);
    expect((await list(`?from=${to}&to=${to}`)).total).toBe(1);
  });

  it('filters by latest delivery status, including rows with no report', async () => {
    await seedLedger();
    expect((await list('?delivery=delivered')).data.map((r) => r.provider_message_id)).toEqual([
      're_1',
    ]);
    expect((await list('?delivery=bounced')).total).toBe(1);
    // `sent` is the latest for nobody: re_1 moved on to `delivered`.
    expect((await list('?delivery=sent')).total).toBe(0);
    expect((await list('?delivery=none')).total).toBe(4);
  });

  it('pages with a stable order', async () => {
    await seedLedger();
    const one = await list('?perPage=4&page=1');
    const two = await list('?perPage=4&page=2');
    expect(one.data).toHaveLength(4);
    expect(two.data).toHaveLength(2);
    const ids = [...one.data, ...two.data].map((r) => r.id);
    expect(new Set(ids).size).toBe(6);
  });

  it('refuses an address in the URL', async () => {
    const res = await get(`/api/admin/email/sends?address=${encodeURIComponent(BOB)}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ADDRESS_NOT_ALLOWED_IN_URL');
    expect(JSON.stringify(body)).not.toContain(BOB);
  });

  it('400s a from after to, and an unknown outcome', async () => {
    expect((await get('/api/admin/email/sends?from=2026-10-02&to=2026-10-01')).status).toBe(400);
    expect((await get('/api/admin/email/sends?outcome=nope')).status).toBe(400);
  });
});

// ─── Address search ───────────────────────────────────────────────────────────

describe('POST /api/admin/email/sends/search', () => {
  it('finds every send to an address, whatever its case, whitespace or display name', async () => {
    await seedLedger();
    for (const address of [
      'alice@example.com',
      '  ALICE@example.COM ',
      'Alice Smith <alice@example.com>',
    ]) {
      const res = await search({ address });
      expect(res.status).toBe(200);
      const body: AdminEmailSearchResponse = AdminEmailSearchResponseSchema.parse(await res.json());
      expect(body.total).toBe(3);
      expect(new Set(body.data.map((r) => r.recipient_hash_prefix))).toEqual(
        new Set([aliceHash.slice(0, 8)]),
      );
    }
  });

  it('combines the address with the other filters', async () => {
    await seedLedger();
    const body = AdminEmailSearchResponseSchema.parse(
      await (await search({ address: BOB, outcome: 'sent' })).json(),
    );
    expect(body.data.map((r) => r.notification_id)).toEqual(['claim-rejected', 'retired-template']);
  });

  it('never echoes the address or the full hash', async () => {
    await seedLedger();
    const text = await (await search({ address: ALICE })).text();
    expect(text.toLowerCase()).not.toContain('alice@example.com');
    expect(text).not.toContain(aliceHash);
  });

  it('returns delivery events no ledger row claims, such as the sign-in stream', async () => {
    await seedSend({
      notificationId: 'claim-approved',
      recipientHash: aliceHash,
      outcome: 'sent',
      providerMessageId: 're_1',
      createdAt: daysAgo(1),
    });
    await seedEvent({
      providerMessageId: 're_auth',
      eventType: 'bounced',
      sendId: null,
      notificationId: 'supabase-sign-in',
      recipientHash: aliceHash,
      tier: 'auth',
      occurredAt: daysAgo(1),
      bounceType: 'Permanent',
    });
    await seedEvent({
      providerMessageId: 're_other',
      eventType: 'delivered',
      sendId: null,
      notificationId: 'supabase-sign-in',
      recipientHash: bobHash,
      tier: 'auth',
      occurredAt: daysAgo(1),
    });
    const body = AdminEmailSearchResponseSchema.parse(
      await (await search({ address: ALICE }, PRODUCTION)).json(),
    );
    expect(body.unmatched_events).toHaveLength(1);
    expect(body.unmatched_events[0]).toMatchObject({
      notification_id: 'supabase-sign-in',
      tier: 'auth',
      event_type: 'bounced',
      bounce_type: 'Permanent',
    });
  });

  it('400s a body with no usable address, without quoting it', async () => {
    const res = await search({ address: 'not-an-address' });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('not-an-address');
    expect((await search({})).status).toBe(400);
  });

  it('400s a body that is not JSON', async () => {
    const res = await app().request(
      '/api/admin/email/sends/search',
      { method: 'POST', body: 'address=alice@example.com' },
      PREVIEW,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(400);
  });
});

describe('entityLink', () => {
  const kinds = new Map([
    ['c', 'claim'],
    ['r', 'correction'],
  ]);
  it.each([
    ['vendor', 'v1', '/admin/vendors/v1'],
    ['profile', 'p1', '/admin/users/p1'],
    ['vendor_request', 'c', '/admin/claims/c'],
    ['vendor_request', 'r', '/admin/requests'],
    ['vendor_request', 'gone', null],
    ['review', 'x', '/admin/reviews'],
    ['integration_field_challenge', 'x', '/admin/contests'],
    ['mailing_list', '7', '/admin/subscribers'],
    ['vendor_seat_invite', 'x', null],
  ])('%s %s → %s', (type, id, path) => {
    expect(entityLink(type, id, kinds)).toEqual({ type, id, admin_path: path });
  });
  it('is null when the sender named no entity', () => {
    expect(entityLink(null, null, kinds)).toBeNull();
  });
});

// ─── Authorization (the real guard) ───────────────────────────────────────────

describe('/api/admin/email — authorization', () => {
  const SUPABASE_URL = 'https://test-project.supabase.co';
  const AUTHZ_ENV = { ENV: 'staging', SUPABASE_URL } as Env;
  const ADMIN = '00000000-0000-4000-8000-000000000900';
  const USER = '00000000-0000-4000-8000-000000000901';

  let jwks: TestJwks;
  beforeAll(async () => {
    jwks = await makeTestJwks();
  });

  function guarded() {
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    const guard = requireAdmin({ getKey: jwks.getKey, dbFor: t.factory });
    a.get('/api/admin/email/summary', guard, createAdminEmailSummaryHandler(t.factory, clock));
    a.get('/api/admin/email/sends', guard, createAdminEmailSendsHandler(t.factory, clock));
    a.post('/api/admin/email/sends/search', guard, createAdminEmailSearchHandler(t.factory, clock));
    return a;
  }

  const call = (path: string, method: string, token?: string) =>
    guarded().request(
      path,
      {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify({ address: BOB }) } : {}),
      },
      AUTHZ_ENV,
      fakeExecutionContext(),
    );

  const ROUTES = [
    ['/api/admin/email/summary', 'GET'],
    ['/api/admin/email/sends', 'GET'],
    ['/api/admin/email/sends/search', 'POST'],
  ] as const;

  it('401s an anonymous caller on all three', async () => {
    for (const [path, method] of ROUTES) expect((await call(path, method)).status).toBe(401);
  });

  it('403s a signed-in non-admin on all three', async () => {
    await t.db.insert(profiles).values({ id: USER, role: 'reviewer' });
    const token = await jwks.mintToken({ sub: USER, supabaseUrl: SUPABASE_URL });
    for (const [path, method] of ROUTES) {
      expect((await call(path, method, token)).status).toBe(403);
    }
  });

  it('lets an admin through on all three', async () => {
    await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
    const token = await jwks.mintToken({ sub: ADMIN, supabaseUrl: SUPABASE_URL });
    for (const [path, method] of ROUTES) {
      expect((await call(path, method, token)).status).toBe(200);
    }
  });
});
