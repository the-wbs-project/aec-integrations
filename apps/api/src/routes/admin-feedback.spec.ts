/**
 * `GET /api/admin/feedback` (AECI-586 / P5.1) against the in-memory D1 harness.
 *
 * This is the first read path the `feedback` table has ever had, so there is no
 * prior shape to conform to — these cases pin the one it now has: newest first,
 * a stable page boundary, the full row including the volunteered email, and an
 * empty table that pages cleanly rather than erroring.
 */

import { AdminFeedbackResponseSchema, type AdminFeedbackResponse } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, feedback } from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createAdminFeedbackHandler } from './admin-feedback';

const NOW = new Date('2026-08-11T05:00:00.000Z');

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

function call(query = '', env: Env = TEST_ENV) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/admin/feedback',
    handler: createAdminFeedbackHandler(t.factory, { now: () => NOW }),
  }).request(`/api/admin/feedback?${query}`, {}, env, fakeExecutionContext());
}

async function inbox(query = '', env?: Env): Promise<AdminFeedbackResponse> {
  const res = await call(query, env);
  expect(res.status).toBe(200);
  return AdminFeedbackResponseSchema.parse(await res.json());
}

describe('GET /api/admin/feedback — empty table', () => {
  it('returns an empty page rather than an error', async () => {
    const r = await inbox();

    expect(r.data).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.page).toBe(1);
    expect(r.notes).toEqual([]);
    expect(r.source).toBe('live');
  });

  it('returns an empty page past the end too', async () => {
    const r = await inbox('page=5');
    expect(r.data).toEqual([]);
    expect(r.total).toBe(0);
  });
});

describe('GET /api/admin/feedback — populated', () => {
  beforeEach(async () => {
    await t.db.insert(feedback).values([
      {
        features: 'Better search',
        tools: 'Procore, Revit',
        email: 'first@example.com',
        subscribed: true,
        country: 'ID',
        city: 'Jakarta',
        region: 'Jakarta',
        timezone: 'Asia/Jakarta',
        referrer: 'https://example.com/blog',
        createdAt: '2026-08-01T10:00:00.000Z',
      },
      {
        features: null,
        tools: 'Bluebeam',
        email: null,
        subscribed: false,
        createdAt: '2026-08-05T10:00:00.000Z',
      },
      {
        features: 'A third',
        tools: null,
        email: 'third@example.com',
        subscribed: false,
        createdAt: '2026-08-09T10:00:00.000Z',
      },
    ]);
  });

  it('orders newest first', async () => {
    const r = await inbox();

    expect(r.total).toBe(3);
    expect(r.data.map((x) => x.created_at)).toEqual([
      '2026-08-09T10:00:00.000Z',
      '2026-08-05T10:00:00.000Z',
      '2026-08-01T10:00:00.000Z',
    ]);
  });

  it('returns the whole row, including the volunteered email and the opt-in flag', async () => {
    const r = await inbox();
    const oldest = r.data.at(-1);

    expect(oldest).toMatchObject({
      features: 'Better search',
      tools: 'Procore, Revit',
      email: 'first@example.com',
      subscribed: true,
      country: 'ID',
      city: 'Jakarta',
      region: 'Jakarta',
      timezone: 'Asia/Jakarta',
      referrer: 'https://example.com/blog',
    });
    expect(typeof oldest?.id).toBe('number');
  });

  it('carries nulls through rather than collapsing them to empty strings', async () => {
    const r = await inbox();
    const middle = r.data[1];

    expect(middle?.features).toBeNull();
    expect(middle?.email).toBeNull();
    expect(middle?.country).toBeNull();
    expect(middle?.subscribed).toBe(false);
  });

  it('paginates with a total that counts every row, not the page', async () => {
    const first = await inbox('page=1&perPage=2');
    expect(first.data).toHaveLength(2);
    expect(first.total).toBe(3);
    expect(first.perPage).toBe(2);

    const second = await inbox('page=2&perPage=2');
    expect(second.data).toHaveLength(1);
    expect(second.total).toBe(3);
  });

  it('never repeats or skips a row across a page boundary, even at an identical timestamp', async () => {
    // Two submissions stamped in the same millisecond: `created_at` alone cannot
    // order them, so the id tiebreaker is what keeps pagination total (AECI-99).
    await t.db.insert(feedback).values([
      { features: 'tie A', createdAt: '2026-08-10T00:00:00.000Z' },
      { features: 'tie B', createdAt: '2026-08-10T00:00:00.000Z' },
    ]);

    const ids: number[] = [];
    for (const page of [1, 2, 3, 4, 5]) {
      const r = await inbox(`page=${page}&perPage=1`);
      ids.push(...r.data.map((x) => x.id));
    }

    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });
});

describe('GET /api/admin/feedback — conventions', () => {
  it('caps perPage at 100 and rejects a zero page', async () => {
    expect((await call('perPage=101')).status).toBe(400);
    expect((await call('perPage=0')).status).toBe(400);
    expect((await call('page=0')).status).toBe(400);
  });

  it('writes no audit_log row and is never edge-cacheable', async () => {
    const res = await call();

    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Cache-Tag')).toBeNull();
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});
