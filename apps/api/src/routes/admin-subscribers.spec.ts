/**
 * `GET /api/admin/subscribers` (AECI-859 / P5.2) against the in-memory D1 harness.
 *
 * The first ROW-level read `mailing_list` has ever had, so as with the feedback
 * inbox there is no prior shape to conform to — these cases pin the one it now
 * has. Three of them exist for reasons a reader should not have to infer:
 *
 * - **`unsubscribe_token` must not appear anywhere in the response**, because it
 *   is a bearer capability rather than an identifier (AECI-537). The assertion is
 *   over the serialized body, not the parsed row, so a future column added to the
 *   projection cannot slip it past a `toMatchObject`.
 * - **Email sorts case-insensitively** (AECI-825). `BINARY` would put every
 *   capitalized address ahead of every lowercase one, and addresses are mixed
 *   case often enough that the default is wrong rather than merely unusual.
 * - **A page boundary holds under a tie.** `NOCASE` makes `A@x` and `a@x` EQUAL,
 *   where `BINARY` never did, so the id tiebreaker is load-bearing on this
 *   surface in a way it is not on a `BINARY`-ordered one.
 */

import { AdminSubscribersResponseSchema, type AdminSubscribersResponse } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, mailingList } from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createAdminSubscribersHandler } from './admin-subscribers';

const NOW = new Date('2026-08-11T05:00:00.000Z');

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

function call(query = '', env: Env = TEST_ENV) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/admin/subscribers',
    handler: createAdminSubscribersHandler(t.factory, { now: () => NOW }),
  }).request(`/api/admin/subscribers?${query}`, {}, env, fakeExecutionContext());
}

async function roster(query = '', env?: Env): Promise<AdminSubscribersResponse> {
  const res = await call(query, env);
  expect(res.status).toBe(200);
  return AdminSubscribersResponseSchema.parse(await res.json());
}

describe('GET /api/admin/subscribers — empty table', () => {
  it('returns an empty page rather than an error', async () => {
    const r = await roster();

    expect(r.data).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.page).toBe(1);
    expect(r.notes).toEqual([]);
    expect(r.source).toBe('live');
  });

  it('reports churn as null over an empty list, never as zero', async () => {
    // §5.1: "`null` renders as *Not measured*, never as zero". The stock block is
    // the same `subscriberTotals()` the Audience screen renders, so the rule is
    // enforced at the contract rather than by two UIs behaving.
    const r = await roster();

    expect(r.subscribers).toEqual({
      active: 0,
      unsubscribed: 0,
      total_ever: 0,
      churn_rate: null,
    });
  });
});

describe('GET /api/admin/subscribers — populated', () => {
  beforeEach(async () => {
    await t.db.insert(mailingList).values([
      {
        email: 'zoe@example.com',
        createdAt: '2026-08-01T10:00:00.000Z',
        unsubscribeToken: 'token-zoe',
        utmSource: 'linkedin',
        utmMedium: 'social',
        utmCampaign: 'launch',
        referrer: 'https://www.linkedin.com/feed',
        country: 'US',
        region: 'California',
        city: 'San Francisco',
        asOrganization: 'Comcast Cable',
      },
      {
        email: 'adam@example.com',
        createdAt: '2026-08-05T10:00:00.000Z',
        unsubscribeToken: 'token-adam',
        unsubscribedAt: '2026-08-07T09:00:00.000Z',
      },
      {
        email: 'Bea@example.com',
        createdAt: '2026-08-09T10:00:00.000Z',
        unsubscribeToken: 'token-bea',
      },
    ]);
  });

  it('orders by signup date, newest first, by default', async () => {
    const r = await roster();

    expect(r.total).toBe(3);
    expect(r.data.map((x) => x.email)).toEqual([
      'Bea@example.com',
      'adam@example.com',
      'zoe@example.com',
    ]);
  });

  it('returns the address in full, the signup date, and the attribution', async () => {
    const r = await roster();
    const oldest = r.data.at(-1);

    expect(oldest).toMatchObject({
      email: 'zoe@example.com',
      created_at: '2026-08-01T10:00:00.000Z',
      unsubscribed_at: null,
      status: 'active',
      utm_source: 'linkedin',
      utm_medium: 'social',
      utm_campaign: 'launch',
      referrer: 'https://www.linkedin.com/feed',
      country: 'US',
      region: 'California',
      city: 'San Francisco',
      as_organization: 'Comcast Cable',
    });
    expect(typeof oldest?.id).toBe('number');
  });

  it('never puts unsubscribe_token on the wire', async () => {
    // Asserted over the raw body rather than the parsed row: Zod strips unknown
    // keys, so parsing first would hide exactly the leak this guards against.
    const body = await (await call()).text();

    expect(body).not.toContain('token-zoe');
    expect(body).not.toContain('unsubscribe_token');
    expect(body).not.toContain('unsubscribeToken');
  });

  it('derives status from unsubscribed_at rather than making the UI do it', async () => {
    const r = await roster();
    const churned = r.data.find((x) => x.email === 'adam@example.com');

    expect(churned?.status).toBe('unsubscribed');
    expect(churned?.unsubscribed_at).toBe('2026-08-07T09:00:00.000Z');
  });

  it('carries nulls through rather than collapsing them to empty strings', async () => {
    const r = await roster();
    const sparse = r.data.find((x) => x.email === 'adam@example.com');

    expect(sparse?.utm_source).toBeNull();
    expect(sparse?.country).toBeNull();
    expect(sparse?.referrer).toBeNull();
  });

  it('reports lifetime stocks unfiltered, beside a filtered total', async () => {
    const r = await roster('status=active');

    expect(r.total).toBe(2);
    expect(r.data.map((x) => x.email)).toEqual(['Bea@example.com', 'zoe@example.com']);
    // The chips label themselves off this block, so it must NOT narrow with the
    // filter — otherwise selecting "active" would rewrite the count beside
    // "unsubscribed" to zero.
    expect(r.subscribers.active).toBe(2);
    expect(r.subscribers.unsubscribed).toBe(1);
    expect(r.subscribers.total_ever).toBe(3);
  });

  it('filters to the unsubscribed without folding `false` back into `true`', async () => {
    const r = await roster('status=unsubscribed');

    expect(r.total).toBe(1);
    expect(r.data[0]?.email).toBe('adam@example.com');
  });
});

describe('GET /api/admin/subscribers — sorting (AECI-825)', () => {
  beforeEach(async () => {
    // The case spread that makes BINARY visibly wrong: under it every capital
    // precedes every lowercase, so this sorts Bea, Zeta, adam, eSUB.
    await t.db.insert(mailingList).values([
      { email: 'eSUB@example.com', createdAt: '2026-08-01T10:00:00.000Z' },
      { email: 'Zeta@example.com', createdAt: '2026-08-02T10:00:00.000Z' },
      { email: 'adam@example.com', createdAt: '2026-08-03T10:00:00.000Z' },
      { email: 'Bea@example.com', createdAt: '2026-08-04T10:00:00.000Z' },
    ]);
  });

  it('sorts email case-insensitively, A to Z by default', async () => {
    const r = await roster('sort=email');

    expect(r.data.map((x) => x.email)).toEqual([
      'adam@example.com',
      'Bea@example.com',
      'eSUB@example.com',
      'Zeta@example.com',
    ]);
  });

  it('honours an explicit descending email order', async () => {
    const r = await roster('sort=email&order=desc');

    expect(r.data.map((x) => x.email)).toEqual([
      'Zeta@example.com',
      'eSUB@example.com',
      'Bea@example.com',
      'adam@example.com',
    ]);
  });

  it('honours an explicit ascending signup order', async () => {
    const r = await roster('sort=created_at&order=asc');

    expect(r.data.map((x) => x.created_at)).toEqual([
      '2026-08-01T10:00:00.000Z',
      '2026-08-02T10:00:00.000Z',
      '2026-08-03T10:00:00.000Z',
      '2026-08-04T10:00:00.000Z',
    ]);
  });

  it('never repeats or skips a row across a page boundary under a NOCASE tie', async () => {
    // `NOCASE` reports these two as EQUAL, which `BINARY` never did — so without
    // the id tiebreaker a paginated list can drop or duplicate one (AECI-99).
    await t.db.insert(mailingList).values([
      { email: 'TIE@example.com', createdAt: '2026-08-05T10:00:00.000Z' },
      { email: 'tie@example.net', createdAt: '2026-08-06T10:00:00.000Z' },
    ]);

    const ids: number[] = [];
    for (const page of [1, 2, 3, 4, 5, 6]) {
      const r = await roster(`sort=email&page=${page}&perPage=1`);
      ids.push(...r.data.map((x) => x.id));
    }

    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });
});

describe('GET /api/admin/subscribers — search', () => {
  beforeEach(async () => {
    await t.db.insert(mailingList).values([
      { email: 'ana@acme.com', createdAt: '2026-08-01T10:00:00.000Z' },
      { email: 'ben@acme.com', createdAt: '2026-08-02T10:00:00.000Z' },
      { email: 'cara@other.io', createdAt: '2026-08-03T10:00:00.000Z' },
      { email: 'literal%wildcard@example.com', createdAt: '2026-08-04T10:00:00.000Z' },
    ]);
  });

  it('matches an email substring, so a domain finds everyone at it', async () => {
    const r = await roster('search=%40acme.com');

    expect(r.total).toBe(2);
    expect(r.data.map((x) => x.email).sort()).toEqual(['ana@acme.com', 'ben@acme.com']);
  });

  it('escapes LIKE wildcards rather than honouring them', async () => {
    // A bare `%` would match every row. `likeContains` escapes it, so this finds
    // the one address that literally contains the character.
    const r = await roster('search=%25');

    expect(r.total).toBe(1);
    expect(r.data[0]?.email).toBe('literal%wildcard@example.com');
  });

  it('ignores a whitespace-only term rather than matching nothing', async () => {
    const r = await roster('search=%20%20');
    expect(r.total).toBe(4);
  });
});

describe('GET /api/admin/subscribers — conventions', () => {
  it('caps perPage at 100 and rejects a zero page', async () => {
    expect((await call('perPage=101')).status).toBe(400);
    expect((await call('perPage=0')).status).toBe(400);
    expect((await call('page=0')).status).toBe(400);
  });

  it('400s on an unknown sort key or status rather than silently ignoring it', async () => {
    expect((await call('sort=unsubscribed_at')).status).toBe(400);
    expect((await call('status=banned')).status).toBe(400);
  });

  it('writes no audit_log row and is never edge-cacheable', async () => {
    const res = await call();

    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Cache-Tag')).toBeNull();
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});
