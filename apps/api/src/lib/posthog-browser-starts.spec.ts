/**
 * Unit tests for the AECI-870 browser-start read — the D1-to-PostHog seam.
 *
 * The theme: the operator exclusion is the reason this module exists, so every
 * way it can silently stop excluding has a test. On the Sep 7–10 production
 * sample the operator was 41 of 109 starts, i.e. well over a third of the raw
 * figure, and an unfiltered number labelled "operator excluded" is worse than no
 * number at all.
 *
 * PostHog is never reached: `fetchImpl` is injected and D1 is the in-memory
 * better-sqlite3 harness the rest of `apps/api` uses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { profiles } from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';

import { readAdminUserIds, readPosthogBrowserStarts } from './posthog-browser-starts';

const WINDOW = {
  startIso: '2026-09-10T00:00:00.000Z',
  endIso: '2026-09-11T00:00:00.000Z',
};

const ENV = {
  PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
  POSTHOG_QUERY_API_KEY: 'phx_test',
  POSTHOG_PROJECT_ID: '354071',
} as unknown as Env;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function seedProfile(id: string, role: string): Promise<void> {
  await t.db.insert(profiles).values({ id, role, displayName: `${role} ${id}` });
}

/** A `Db` whose first read throws — the "we could not find out" case. */
const brokenDb = () =>
  ({
    select: () => {
      throw new Error('D1_ERROR');
    },
  }) as unknown as TestDb['db'];

/** The HogQL the call actually sent. */
function sentQuery(fetchImpl: { mock: { calls: unknown[][] } }): string {
  const init = fetchImpl.mock.calls[0][1] as { body: string };
  return (JSON.parse(init.body) as { query: { query: string } }).query.query;
}

describe('readAdminUserIds', () => {
  it('returns the Supabase user ids of admin profiles only', async () => {
    await seedProfile('admin-one', 'admin');
    await seedProfile('admin-two', 'admin');
    await seedProfile('reviewer-one', 'reviewer');
    await seedProfile('vendor-one', 'vendor_admin');

    const ids = await readAdminUserIds(t.db);
    expect(ids?.slice().sort()).toEqual(['admin-one', 'admin-two']);
  });

  it('returns an empty array, not null, when the deployment has no admins', async () => {
    // A legitimate state that correctly yields an unfiltered count. It must be
    // distinguishable from a failed read, which must NOT.
    await seedProfile('reviewer-one', 'reviewer');
    expect(await readAdminUserIds(t.db)).toEqual([]);
  });

  it('returns null rather than an empty list when the read throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await readAdminUserIds(brokenDb())).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('readPosthogBrowserStarts', () => {
  it('passes the admin ids into the query and returns the counts', async () => {
    await seedProfile('49dd03ee-admin', 'admin');
    await seedProfile('reviewer-one', 'reviewer');
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [[21, 13, 7]] }));

    const outcome = await readPosthogBrowserStarts(
      ENV,
      t.db,
      WINDOW,
      fetchImpl as unknown as typeof fetch,
    );

    expect(outcome).toEqual({
      ok: true,
      starts: { startsAll: 21, starts: 13, searchReferred: 7 },
    });
    expect(sentQuery(fetchImpl)).toContain("distinct_id IN ('49dd03ee-admin')");
    expect(sentQuery(fetchImpl)).not.toContain('reviewer-one');
  });

  it('scopes the query to this environment own host', async () => {
    // Preview, staging and demo share one PostHog project; an unscoped read would
    // fold three tiers into one figure.
    await seedProfile('admin-one', 'admin');
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [[1, 1, 0]] }));

    await readPosthogBrowserStarts(ENV, t.db, WINDOW, fetchImpl as unknown as typeof fetch);

    expect(sentQuery(fetchImpl)).toContain("properties.$host = 'www.aecintegrations.com'");
  });

  it('skips without querying when PUBLIC_SITE_URL is unset', async () => {
    const fetchImpl = vi.fn();
    const outcome = await readPosthogBrowserStarts(
      { ...ENV, PUBLIC_SITE_URL: undefined } as Env,
      t.db,
      WINDOW,
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome).toEqual({ ok: false, reason: 'public_site_url_unset' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('suppresses the figure when the admin lookup fails, rather than publishing it unfiltered', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn();

    const outcome = await readPosthogBrowserStarts(
      ENV,
      brokenDb(),
      WINDOW,
      fetchImpl as unknown as typeof fetch,
    );

    expect(outcome).toEqual({ ok: false, reason: 'admin_lookup_failed' });
    expect(fetchImpl).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('still queries when there are no admins, with no operator clause', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [[9, 9, 2]] }));

    const outcome = await readPosthogBrowserStarts(
      ENV,
      t.db,
      WINDOW,
      fetchImpl as unknown as typeof fetch,
    );

    expect(outcome.ok).toBe(true);
    expect(sentQuery(fetchImpl)).not.toContain('person_id NOT IN');
  });

  it('is exactly one PostHog request', async () => {
    await seedProfile('admin-one', 'admin');
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [[1, 1, 1]] }));
    await readPosthogBrowserStarts(ENV, t.db, WINDOW, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
