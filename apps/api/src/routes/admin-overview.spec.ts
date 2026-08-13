/**
 * `GET /api/admin/overview` (AECI-574) against the in-memory D1 harness.
 *
 * The load-bearing spec here is **digest parity**: the endpoint's numbers must be
 * identical to the numbers the 05:00 analytics digest email reports for the same
 * day. The handler achieves that by calling `collectAnalyticsMetrics`, so this
 * spec is a regression guard against someone "optimizing" it into a second
 * implementation — which is exactly the divergence the acceptance criterion is
 * written to catch.
 *
 * The `requireAdmin()` gate lives in `index.ts` and is exercised end-to-end by
 * `admin-panel.authz-matrix.spec.ts`; this file mounts the handler alone.
 */

import {
  AdminOverviewResponseSchema,
  type AdminOverviewResponse,
  type AdminNoteCode,
} from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, mailingList, pageViews, products, profiles, statsCache } from '../db/schema';
import type { Env } from '../env';
import {
  buildAnalyticsDigest,
  collectAnalyticsMetrics,
  windowsForDay,
} from '../lib/analytics-digest';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createAdminOverviewHandler, type AdminOverviewDeps } from './admin-overview';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** The reported day in every test, and a `now` that sits on the day AFTER it —
 *  so the default (no `?day=`) window resolves to exactly this day. */
const DAY = '2026-08-10';
const NOW = new Date('2026-08-11T05:00:00.000Z');

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

async function seedDay(): Promise<void> {
  await t.db.insert(products).values([
    { id: u(1), slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
    { id: u(2), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
  ]);

  await t.db.insert(pageViews).values([
    // ── the reported day ──
    // Two human views of Procore from the operator's own ISP…
    {
      path: '/products/:slug',
      productId: u(1),
      isBot: false,
      referrerSource: 'Direct',
      cfAsn: 23700,
      cfCountry: 'ID',
      userAgentHash: 'hash-a',
      createdAt: `${DAY}T01:00:00.000Z`,
    },
    {
      path: '/products/:slug',
      productId: u(1),
      isBot: false,
      referrerSource: 'Direct',
      cfAsn: 23700,
      cfCountry: 'ID',
      userAgentHash: 'hash-a',
      createdAt: `${DAY}T02:00:00.000Z`,
    },
    // …one genuine external arrival…
    {
      path: '/products/:slug',
      productId: u(2),
      isBot: false,
      referrerSource: 'Google',
      cfAsn: 7922,
      cfCountry: 'US',
      userAgentHash: 'hash-b',
      createdAt: `${DAY}T03:00:00.000Z`,
    },
    // …one unclassified row, which the digest's `is_bot IS NOT 1` reads as HUMAN…
    {
      path: '/',
      isBot: null,
      referrerSource: null,
      cfAsn: null,
      cfCountry: 'GB',
      userAgentHash: 'hash-c',
      createdAt: `${DAY}T04:00:00.000Z`,
    },
    // …and one crawler.
    {
      path: '/',
      isBot: true,
      botName: 'Googlebot',
      cfAsn: 15169,
      cfCountry: 'US',
      userAgentHash: 'hash-d',
      createdAt: `${DAY}T05:00:00.000Z`,
    },
    // ── the prior day (the day-over-day baseline) ──
    { path: '/', isBot: false, cfAsn: 7922, createdAt: '2026-08-09T01:00:00.000Z' },
    { path: '/', isBot: false, cfAsn: 7922, createdAt: '2026-08-09T02:00:00.000Z' },
    // ── outside the window on both sides (boundary rows) ──
    { path: '/', isBot: false, cfAsn: 7922, createdAt: '2026-08-11T00:00:00.000Z' },
  ]);

  await t.db
    .insert(profiles)
    .values([{ id: u(10), role: 'reviewer', createdAt: `${DAY}T06:00:00.000Z` }]);

  await t.db.insert(mailingList).values([
    { email: 'a@example.com', createdAt: `${DAY}T07:00:00.000Z` },
    { email: 'b@example.com', unsubscribedAt: `${DAY}T08:00:00.000Z` },
  ]);

  await t.db
    .insert(statsCache)
    .values({ key: 'home.total_products', value: 2, computedAt: '2026-08-11T01:00:00.000Z' });
}

function call(url: string, env: Env = TEST_ENV, deps: AdminOverviewDeps = {}) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/admin/overview',
    handler: createAdminOverviewHandler(t.factory, { now: () => NOW, ...deps }),
  }).request(url, {}, env, fakeExecutionContext());
}

async function overview(url = '/api/admin/overview', env?: Env, deps?: AdminOverviewDeps) {
  const res = await call(url, env, deps);
  expect(res.status).toBe(200);
  return AdminOverviewResponseSchema.parse(await res.json()) as AdminOverviewResponse;
}

const codes = (body: AdminOverviewResponse): AdminNoteCode[] => body.notes.map((n) => n.code);

describe('GET /api/admin/overview — digest parity (the AECI-574 acceptance criterion)', () => {
  it('reports the same numbers the analytics digest email reports for that day', async () => {
    await seedDay();

    // What the 05:00 cron would compute and email for `DAY`.
    const metrics = await collectAnalyticsMetrics(t.db, windowsForDay(DAY));
    const email = buildAnalyticsDigest(metrics, {
      env: 'preview',
      dayLabel: DAY,
      generatedAt: NOW,
    });

    const body = await overview();

    // Traffic
    expect(body.traffic.page_views_human.total).toBe(metrics.pageViews.day);
    expect(body.traffic.page_views_bot.total).toBe(metrics.botPageViews.day);
    expect(body.traffic.delta_day.current).toBe(metrics.pageViews.day);
    expect(body.traffic.delta_day.prior).toBe(metrics.pageViews.prior);
    // Sign-ins + moderation
    expect(body.audience.new_sign_ins.current).toBe(metrics.newUsers.day);
    expect(body.audience.total_users).toBe(metrics.totalUsers);
    expect(body.status.moderation.pending_reviews).toBe(metrics.pendingModeration);
    // Ranked lists, element for element
    expect(body.traffic.top_products).toEqual(
      metrics.topProducts.map((p) => ({ name: p.name, slug: p.slug, views: p.views })),
    );
    expect(body.traffic.top_sources).toEqual(
      metrics.referrers.map((r) => ({ source: r.source, views: r.views })),
    );

    // And the email really does carry those figures — 3 humans (two operator
    // views + one Google arrival) plus the unclassified row = 4, 1 crawler.
    expect(metrics.pageViews.day).toBe(4);
    expect(metrics.botPageViews.day).toBe(1);
    expect(email.subject).toContain('4 human views');
  });

  it('applies the digest deltaText semantics: pct is null when the prior period was 0', async () => {
    await t.db
      .insert(pageViews)
      .values([{ path: '/', isBot: false, createdAt: `${DAY}T01:00:00.000Z` }]);
    const body = await overview();
    expect(body.traffic.delta_day).toEqual({ current: 1, prior: 0, diff: 1, pct: null });
  });

  it('computes a 7-day delta against the preceding 7 days', async () => {
    // 3 views inside 2026-08-04..2026-08-10, 1 inside 2026-07-28..2026-08-03.
    await t.db.insert(pageViews).values([
      { path: '/', isBot: false, createdAt: '2026-08-04T00:00:00.000Z' },
      { path: '/', isBot: false, createdAt: '2026-08-07T00:00:00.000Z' },
      { path: '/', isBot: false, createdAt: `${DAY}T23:59:59.999Z` },
      { path: '/', isBot: false, createdAt: '2026-08-03T23:59:59.999Z' },
    ]);
    const body = await overview();
    expect(body.traffic.delta_7d).toEqual({ current: 3, prior: 1, diff: 2, pct: 200 });
  });
});

describe('GET /api/admin/overview — window', () => {
  it('defaults to the prior COMPLETE UTC day, half-open [from, to)', async () => {
    await seedDay();
    const body = await overview();
    expect(body.window).toEqual({
      from: '2026-08-10T00:00:00.000Z',
      to: '2026-08-11T00:00:00.000Z',
      timezone: 'UTC',
      days: 1,
    });
    // The 2026-08-11T00:00:00.000Z row sits exactly on the exclusive bound and is out.
    expect(body.traffic.page_views_human.total).toBe(4);
  });

  it('honours ?day= and flags a still-filling current day', async () => {
    await seedDay();
    const today = await overview('/api/admin/overview?day=2026-08-11');
    expect(today.window.from).toBe('2026-08-11T00:00:00.000Z');
    expect(codes(today)).toContain('partial_day');

    const past = await overview(`/api/admin/overview?day=${DAY}`);
    expect(codes(past)).not.toContain('partial_day');
  });

  it('rejects a day that matches the shape but is not a real date', async () => {
    const res = await call('/api/admin/overview?day=2026-02-30');
    expect(res.status).toBe(400);
  });

  it('zero-fills the 30-day series so the chart has no gaps', async () => {
    await seedDay();
    const body = await overview();
    expect(body.traffic.series_30d).toHaveLength(30);
    expect(body.traffic.series_30d.at(0)?.day).toBe('2026-07-12');
    expect(body.traffic.series_30d.at(-1)).toEqual({ day: DAY, human: 4, bot: 1 });
    expect(body.traffic.series_30d.at(-2)).toEqual({ day: '2026-08-09', human: 2, bot: 0 });
    expect(body.traffic.series_30d.at(0)).toEqual({ day: '2026-07-12', human: 0, bot: 0 });
  });
});

describe('GET /api/admin/overview — the honesty envelope', () => {
  it('flags an unclassified-bot window from the DATA, not a hardcoded date', async () => {
    await seedDay();
    const withNull = await overview();
    const flag = withNull.notes.find((n) => n.code === 'bot_classification_incomplete');
    expect(flag?.params?.rows).toBe(1);

    // Classify the row — the note must retire on its own, which is what makes it
    // survive AECI-582's backfill without a code change.
    await t.db.delete(pageViews);
    await t.db
      .insert(pageViews)
      .values([{ path: '/', isBot: false, createdAt: `${DAY}T01:00:00.000Z` }]);
    const classified = await overview();
    expect(codes(classified)).not.toContain('bot_classification_incomplete');
  });

  it('declares the referrer gap and the mixed Direct bucket', async () => {
    await seedDay();
    const body = await overview();
    expect(codes(body)).toContain('referrer_source_incomplete');
    expect(codes(body)).toContain('direct_is_mixed_bucket');
    expect(codes(body)).toContain('visitor_definition_approximate');
  });
});

describe('GET /api/admin/overview — the internal-ASN filter (§13 D10)', () => {
  it('is unavailable and reports only unfiltered figures when the var is unset', async () => {
    await seedDay();
    const body = await overview();
    expect(body.internal_filter).toEqual({ available: false, applied: false, asns: [] });
    expect(body.traffic.page_views_human.excluding_internal).toBeNull();
    expect(body.traffic.unique_visitors.excluding_internal).toBeNull();
    expect(codes(body)).toContain('internal_filter_unavailable');
  });

  it('reports BOTH numbers when set — the unfiltered figure stays primary', async () => {
    await seedDay();
    const body = await overview('/api/admin/overview', {
      ...TEST_ENV,
      ANALYTICS_INTERNAL_ASNS: 'AS23700',
    });
    expect(body.internal_filter).toEqual({ available: true, applied: true, asns: [23700] });
    // 4 human views total; the two AS23700 ones are internal. The NULL-ASN row
    // survives the filter.
    expect(body.traffic.page_views_human.total).toBe(4);
    expect(body.traffic.page_views_human.excluding_internal).toBe(2);
    expect(codes(body)).toContain('internal_filter_applied');
  });

  it('counts unique visitors as distinct (user_agent_hash, cf_asn) pairs', async () => {
    await seedDay();
    const body = await overview();
    // hash-a/23700 (twice), hash-b/7922, hash-c/(null) — the crawler is excluded
    // from the human population.
    expect(body.traffic.unique_visitors.total).toBe(3);
  });
});

describe('GET /api/admin/overview — the status strip and ?recompute=1 (§13 D8)', () => {
  it('omits the two network-dependent items by default and says so', async () => {
    await seedDay();
    const body = await overview();
    expect(body.recomputed).toBe(false);
    expect(body.status.data_quality).toBeNull();
    expect(body.status.algolia_drift).toBeNull();
    expect(codes(body)).toContain('requires_recompute');
  });

  it('always carries the cheap items: version, stats freshness, moderation depth', async () => {
    await seedDay();
    const body = await overview('/api/admin/overview', {
      ...TEST_ENV,
      COMMIT_SHA: 'abc1234',
      DEPLOYED_AT: '2026-08-11T00:00:00.000Z',
    });
    expect(body.status.version).toEqual({
      sha: 'abc1234',
      deployed_at: '2026-08-11T00:00:00.000Z',
      environment: 'preview',
    });
    expect(body.status.stats_freshness.computed_at).toBe('2026-08-11T01:00:00.000Z');
    expect(body.status.stats_freshness.stale).toBe(false);
    expect(body.status.moderation).toEqual({ pending_reviews: 0, open_requests: 0 });
  });

  it('reports an empty stats_cache as stale rather than inventing an age', async () => {
    const body = await overview();
    expect(body.status.stats_freshness).toEqual({
      computed_at: null,
      age_hours: null,
      stale: true,
    });
  });

  it('?recompute=1 runs the ten checks and the drift count, sharing ONE drift call', async () => {
    await seedDay();
    const runDrift = vi.fn(async () => [
      {
        entity: 'products' as const,
        indexName: 'aeci_preview_products',
        database: 2,
        algolia: 1,
        drift: 1,
      },
    ]);
    // The logo probe must never touch the network in a spec.
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;

    const body = await overview('/api/admin/overview?recompute=1', TEST_ENV, {
      driftRunnerFor: () => runDrift,
      fetchImpl,
    });

    expect(body.recomputed).toBe(true);
    expect(body.status.data_quality?.checks).toHaveLength(10);
    expect(body.status.algolia_drift).toEqual({
      drifted: 1,
      indexes: [
        {
          entity: 'products',
          index_name: 'aeci_preview_products',
          database: 2,
          algolia: 1,
          drift: 1,
        },
      ],
    });
    // Check #10 IS the drift check — one network round trip serves both consumers.
    expect(runDrift).toHaveBeenCalledTimes(1);
    expect(codes(body)).not.toContain('requires_recompute');
  });

  it('?recompute=1 without Algolia creds reports drift as unknown, not as zero', async () => {
    await seedDay();
    const body = await overview('/api/admin/overview?recompute=1', TEST_ENV, {
      driftRunnerFor: () => undefined,
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    });
    expect(body.status.algolia_drift).toBeNull();
    expect(codes(body)).toContain('algolia_credentials_absent');
    expect(
      body.status.data_quality?.checks.find((c) => c.id === 'algolia_index_drift')?.skipped,
    ).toBe(true);
  });

  it('does not 500 when the drift call fails — the errored check carries the reason', async () => {
    await seedDay();
    const body = await overview('/api/admin/overview?recompute=1', TEST_ENV, {
      driftRunnerFor: () => async () => {
        throw new Error('Algolia count failed');
      },
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    });
    expect(body.status.algolia_drift).toBeNull();
    // Not a credentials problem — naming the wrong cause would be its own defect.
    expect(codes(body)).not.toContain('algolia_credentials_absent');
    const check = body.status.data_quality?.checks.find((c) => c.id === 'algolia_index_drift');
    expect(check?.error).toContain('Algolia count failed');
    expect(body.status.data_quality?.failing).toBeGreaterThan(0);
  });
});

describe('GET /api/admin/overview — catalog, audience, and the read-only invariant', () => {
  it('reports live catalog totals and active (non-unsubscribed) subscribers', async () => {
    await seedDay();
    const body = await overview();
    expect(body.catalog).toEqual({
      products: 2,
      integrations: 0,
      vendors: 0,
      claims: 0,
      attestations: 0,
    });
    // Two rows, one soft-deleted (`unsubscribed_at`) — a suppression, not a subscriber.
    expect(body.audience.active_subscribers).toBe(1);
  });

  it('writes no audit_log row — reads emit nothing (§6, ADR 0022)', async () => {
    await seedDay();
    await overview();
    await overview('/api/admin/overview?recompute=1', TEST_ENV, {
      driftRunnerFor: () => undefined,
      fetchImpl: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
    });
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('is never edge-cacheable', async () => {
    const res = await call('/api/admin/overview');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Cache-Tag')).toBeNull();
  });
});
