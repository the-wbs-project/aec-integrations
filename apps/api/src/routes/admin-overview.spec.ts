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
  ARRIVAL_COVERAGE_METRIC,
  type AdminOverviewResponse,
  type AdminNoteCode,
} from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  mailingList,
  metricsDaily,
  pageViews,
  products,
  profiles,
  statsCache,
} from '../db/schema';
import type { Env } from '../env';
import {
  buildAnalyticsDigest,
  collectAnalyticsMetrics,
  unresolvedRequests,
  windowsForDay,
} from '../lib/analytics-digest';
import { CHECKS } from '../lib/data-quality';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import type { PosthogBrowserStartsOutcome } from '../lib/posthog-query';

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
    // AECI-683's three figures come off the same collector, so the panel cannot
    // grow a second definition of "corroborated" or of the operator-pair leak.
    expect(body.traffic.corroborated_views).toBe(metrics.corroboratedViews.day);
    expect(body.traffic.corroborated_visitors).toBe(metrics.corroboratedVisitors);
    expect(body.traffic.operator_leak_excluded).toBe(metrics.operatorLeakViews);
    // AECI-745. The headline is the POST-AUTOMATION count on both surfaces now.
    // On this fixture the detector flags nothing, so the filtered and raw figures
    // coincide — which is why the test below seeds a client it DOES flag. Both
    // are needed: this one pins the fields to the collector, that one proves the
    // panel is reading the filtered one.
    expect(body.traffic.page_views_human.total).toBe(unresolvedRequests(metrics).day);
    expect(body.traffic.page_views_human_raw.total).toBe(metrics.pageViews.day);
    expect(body.traffic.automation_flagged).toBe(metrics.automation?.flagged.day ?? null);

    // And the email really does carry those figures — 3 humans (two operator
    // views + one Google arrival) plus the unclassified row = 4, 1 crawler.
    expect(metrics.pageViews.day).toBe(4);
    expect(metrics.botPageViews.day).toBe(1);
    expect(email.subject).toContain('4 requests of unresolved origin');
  });

  it('leads with the SAME post-automation figure the email leads with (AECI-745)', async () => {
    await seedDay();
    // Four views under one fingerprint from four different networks — over
    // `SWARM_MIN_VIEWS` at an ASN ratio of 1.0, so the real detector flags them.
    // Without a client the detector actually flags, the raw and filtered figures
    // coincide and this assertion would pass on the pre-AECI-745 code too, which
    // is the trap the relational assertions above quietly sat in.
    await t.db.insert(pageViews).values(
      Array.from({ length: 4 }, (_, i) => ({
        path: '/products/procore',
        isBot: false,
        userAgentHash: 'rotating-proxy',
        cfAsn: 4000 + i,
        cfCountry: ['PL', 'BR', 'ID', 'VN'][i],
        createdAt: `${DAY}T1${i}:00:00.000Z`,
      })),
    );

    const metrics = await collectAnalyticsMetrics(t.db, windowsForDay(DAY));
    const email = buildAnalyticsDigest(metrics, {
      env: 'preview',
      dayLabel: DAY,
      generatedAt: NOW,
    });
    const body = await overview();

    // The two figures must actually differ, or the rest proves nothing.
    expect(metrics.pageViews.day).toBe(8);
    expect(metrics.automation?.flagged.day).toBe(4);
    expect(body.traffic.page_views_human_raw.total).toBe(8);
    expect(body.traffic.automation_flagged).toBe(4);

    // …and the panel leads with the filtered one, which is the whole issue.
    expect(body.traffic.page_views_human.total).toBe(4);
    expect(email.subject).toContain('4 requests of unresolved origin (8 raw)');

    // The day-over-day delta is filtered on BOTH sides (AECI-741). The prior day
    // flags nothing, so its filtered count is its raw count of 2.
    expect(body.traffic.delta_day).toMatchObject({ current: 4, prior: 2 });

    // And the envelope says how the number was reached.
    expect(codes(body)).toContain('automation_filter_applied');
    expect(codes(body)).not.toContain('automation_filter_did_not_run');
  });

  it('excludes /admin and /account rows so the panel never measures the console (AECI-575)', async () => {
    await seedDay();
    // Operator navigations inside the console, on the reported day AND the prior
    // day. The digest filters these on read; every panel figure must agree, or
    // the console re-pollutes the very numbers it exists to report.
    await t.db.insert(pageViews).values([
      { path: '/admin', isBot: false, cfAsn: 23700, createdAt: `${DAY}T09:00:00.000Z` },
      { path: '/admin/traffic', isBot: false, cfAsn: 23700, createdAt: `${DAY}T09:30:00.000Z` },
      { path: '/account', isBot: false, cfAsn: 23700, createdAt: `${DAY}T10:00:00.000Z` },
      { path: '/admin', isBot: false, cfAsn: 23700, createdAt: '2026-08-09T09:00:00.000Z' },
    ]);

    const metrics = await collectAnalyticsMetrics(t.db, windowsForDay(DAY));
    const body = await overview();

    // Still 4 humans / 2 prior — the console rows are gone from every read path.
    expect(body.traffic.page_views_human.total).toBe(4);
    expect(body.traffic.page_views_human.total).toBe(metrics.pageViews.day);
    expect(body.traffic.delta_day.prior).toBe(metrics.pageViews.prior);
    expect(body.traffic.series_30d.at(-1)).toEqual({ day: DAY, human: 4, bot: 1, degraded: false });
    expect(body.traffic.series_30d.at(-2)).toEqual({
      day: '2026-08-09',
      human: 2,
      bot: 0,
      degraded: false,
    });
    // `/administrators` would be a false match for a naive prefix filter — but
    // there is no such row here; the point is the four console rows above vanish.
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
    expect(body.traffic.series_30d.at(-1)).toEqual({ day: DAY, human: 4, bot: 1, degraded: false });
    expect(body.traffic.series_30d.at(-2)).toEqual({
      day: '2026-08-09',
      human: 2,
      bot: 0,
      degraded: false,
    });
    expect(body.traffic.series_30d.at(0)).toEqual({
      day: '2026-07-12',
      human: 0,
      bot: 0,
      // AECI-869: no stored coverage row for that day, so it is `false` — "not
      // assessed", never "blind". Painting an unmeasured day red is the one
      // failure mode a telemetry marker must not have.
      degraded: false,
    });
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

  // AECI-836. The note explains how an exclusion was INFERRED, so it owes the
  // reader a figure to attach to. These two pin the note to `operator_leak_excluded`
  // in both directions rather than to a literal count — the invariant is that the
  // two agree, which is what the emit site can no longer break.
  it('omits the operator-leak note entirely when nothing was excluded', async () => {
    // `seedDay()` writes no `is_operator = 1` row, so no pair can match and the
    // figure is 0. The note used to fire here anyway, with no exclusion anywhere
    // on the screen and no number beside it.
    await seedDay();
    const body = await overview();
    expect(body.traffic.operator_leak_excluded).toBe(0);
    expect(codes(body)).not.toContain('operator_leak_is_an_inference');
  });

  it('emits the operator-leak note, carrying the count, when a pair matched', async () => {
    await seedDay();
    // One verified operator row on the same (user_agent_hash, cf_asn) pair as the
    // two Procore views above. `is_operator` fails open on an expired token, so
    // those two are indistinguishable from a visitor on the row itself — only the
    // pair identifies them, which is the inference the note discloses. The anchor
    // sits on `/admin`, a path §9.6 already excludes, so it adds no counted view.
    await t.db.insert(pageViews).values({
      path: '/admin',
      isBot: false,
      cfAsn: 23700,
      cfCountry: 'ID',
      userAgentHash: 'hash-a',
      isOperator: true,
      createdAt: `${DAY}T00:30:00.000Z`,
    });

    const body = await overview();
    expect(body.traffic.operator_leak_excluded).toBe(2);

    const leak = body.notes.find((n) => n.code === 'operator_leak_is_an_inference');
    expect(leak).toBeDefined();
    expect(leak?.severity).toBe('info');
    // The note's own number IS the reported figure. A future change that gates
    // the note on one value and reports another trips here.
    expect(leak?.params?.rows).toBe(body.traffic.operator_leak_excluded);
  });
});

describe('GET /api/admin/overview — the internal-ASN filter (§13 D10)', () => {
  it('applies no ASN exclusion, and says so, when the var is unset', async () => {
    await seedDay();
    const body = await overview();
    expect(body.internal_filter).toEqual({ available: false, applied: false, asns: [] });
    expect(body.traffic.page_views_human.excluding_internal).toBeNull();
    expect(body.traffic.unique_visitors.excluding_internal).toBeNull();
    expect(codes(body)).toContain('internal_filter_unavailable');
  });

  // AECI-752. The `message` is what a curl of this endpoint shows, and it used to
  // read "Every figure is unfiltered." — false beside a headline the automation
  // filter had already reduced (AECI-745) and the operator-leak match had trimmed
  // (AECI-683). Asserting the absence rather than the new sentence means any
  // replacement that generalises the same way trips this too.
  it('does not claim the whole response is unfiltered when the ASN filter is off', async () => {
    await seedDay();
    const body = await overview();
    const message = body.notes.find((n) => n.code === 'internal_filter_unavailable')?.message ?? '';
    expect(message).not.toMatch(/every figure/i);
    expect(message).toContain('ANALYTICS_INTERNAL_ASNS');
    expect(message).toContain('company-network');
  });

  // AECI-752. The UI string for this code on /admin/overview reads "is not
  // configured", which is only true because this route hardcodes `requested:
  // true` — the note's other state ("configured but not requested") is
  // unreachable here. Nothing pinned that, so a change from `true` to
  // `query.exclude_internal` would silently make the operator-facing copy false
  // again. This is that pin.
  it('always requests the split, so `applied` tracks `available` exactly', async () => {
    await seedDay();
    const off = await overview();
    expect(off.internal_filter.applied).toBe(off.internal_filter.available);

    const on = await overview('/api/admin/overview', {
      ...TEST_ENV,
      ANALYTICS_INTERNAL_ASNS: 'AS23700',
    });
    expect(on.internal_filter.applied).toBe(on.internal_filter.available);
    expect(on.internal_filter.applied).toBe(true);
  });

  it('reports BOTH numbers when set — the ASN-inclusive figure stays primary', async () => {
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
  it('omits both items by default when no run has been stored', async () => {
    await seedDay();
    const body = await overview();
    expect(body.recomputed).toBe(false);
    expect(body.status.data_quality).toBeNull();
    expect(body.status.algolia_drift).toBeNull();
    expect(codes(body)).toContain('requires_recompute');
  });

  it('serves the SAME stored data-quality result /system does — the two strips cannot diverge', async () => {
    // Both endpoints go through `runExpensiveStatusItems`, which is the whole
    // reason that helper exists. If this ever fails, the §5.1 strip and the §5.6
    // screen have started reporting different check counts on the default view.
    await seedDay();
    t.raw
      .prepare(
        'INSERT INTO job_runs (job, started_at, finished_at, outcome, detail) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        'data-quality',
        '2026-08-11T04:00:00.000Z',
        '2026-08-11T04:01:00.000Z',
        'failed',
        JSON.stringify({
          job: 'data-quality',
          durationMs: 900,
          email: 'sent',
          checks: [
            {
              id: 'broken_integration_refs',
              label: 'Broken refs',
              severity: 'error',
              count: 3,
              sample: ['a'],
            },
          ],
        }),
      );

    const body = await overview();
    expect(body.status.data_quality).toMatchObject({
      source: 'job_runs',
      computed_at: '2026-08-11T04:01:00.000Z',
      failing: 1,
    });
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

  it('?recompute=1 runs every data-quality check and the drift count, sharing ONE drift call', async () => {
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
    expect(body.status.data_quality?.checks).toHaveLength(CHECKS.length);
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

describe('GET /api/admin/overview — arrival telemetry health (AECI-869)', () => {
  /** Full-document arrivals on `day`, `withAsn` of which carried a network. */
  async function seedArrivals(day: string, total: number, withAsn: number): Promise<void> {
    await t.db.insert(pageViews).values(
      Array.from({ length: total }, (_, i) => ({
        path: '/',
        isBot: false,
        navigation: 'arrival',
        cfAsn: i < withAsn ? 13335 : null,
        createdAt: `${day}T${String(i % 24).padStart(2, '0')}:30:00.000Z`,
      })),
    );
  }

  it('reports the measurement and the verdict, and warns when the day was blind', async () => {
    await seedDay();
    await seedArrivals(DAY, 8, 1); // 0.125 — well under the 0.95 bar

    const body = await overview();
    expect(body.traffic.arrival_telemetry).toEqual({
      arrivals: 8,
      arrivals_with_asn: 1,
      coverage: 0.125,
      degraded: true,
    });
    // The §13 D15 envelope carries it, above the automation notes whose figures
    // it invalidates — the cause has to sit above the effect.
    expect(codes(body)).toContain('arrival_telemetry_unavailable');
    const note = body.notes.find((n) => n.code === 'arrival_telemetry_unavailable');
    expect(note?.severity).toBe('warn');
    expect(note?.params).toEqual({ arrivals: 8, arrivals_with_asn: 1 });
    expect(codes(body).indexOf('arrival_telemetry_unavailable')).toBeLessThan(
      codes(body).indexOf('automation_filter_applied'),
    );
  });

  it('says nothing when telemetry is healthy', async () => {
    await seedDay();
    await seedArrivals(DAY, 8, 8);

    const body = await overview();
    expect(body.traffic.arrival_telemetry.degraded).toBe(false);
    expect(codes(body)).not.toContain('arrival_telemetry_unavailable');
  });

  it('treats a day with no arrivals as healthy rather than as a total outage', async () => {
    await seedDay(); // seeds page views, but none carry `navigation = 'arrival'`
    const body = await overview();
    expect(body.traffic.arrival_telemetry).toEqual({
      arrivals: 0,
      arrivals_with_asn: 0,
      coverage: 1,
      degraded: false,
    });
    expect(codes(body)).not.toContain('arrival_telemetry_unavailable');
  });

  it('marks the chart days a stored coverage row shows were blind', async () => {
    await seedDay();
    // Written by the 00:15 snapshot, or by `ops:backfill-metrics-daily` over the
    // AECI-868 window. The endpoint reads the RATIO and applies the threshold
    // itself, so a later retune re-decides every past day.
    await t.db.insert(metricsDaily).values([
      { day: DAY, metric: ARRIVAL_COVERAGE_METRIC, value: 0, computedAt: NOW.toISOString() },
      {
        day: '2026-08-09',
        metric: ARRIVAL_COVERAGE_METRIC,
        value: 0.99,
        computedAt: NOW.toISOString(),
      },
    ]);

    const body = await overview();
    expect(body.traffic.series_30d.at(-1)?.degraded).toBe(true);
    expect(body.traffic.series_30d.at(-2)?.degraded).toBe(false);
    // A day with no stored row is `false` — "not assessed", never "blind".
    expect(body.traffic.series_30d.at(0)?.degraded).toBe(false);

    const note = body.notes.find((n) => n.code === 'series_spans_degraded_days');
    expect(note?.severity).toBe('warn');
    expect(note?.params).toEqual({ degraded_days: 1, requested: 30 });
  });

  it('omits the series note entirely when every stored day passed', async () => {
    await seedDay();
    await t.db.insert(metricsDaily).values({
      day: DAY,
      metric: ARRIVAL_COVERAGE_METRIC,
      value: 1,
      computedAt: NOW.toISOString(),
    });
    const body = await overview();
    expect(codes(body)).not.toContain('series_spans_degraded_days');
    expect(body.traffic.series_30d.every((p) => !p.degraded)).toBe(true);
  });
});

describe('GET /api/admin/overview — browser starts (AECI-870)', () => {
  const HEALTHY: PosthogBrowserStartsOutcome = {
    ok: true,
    starts: { startsAll: 21, starts: 13, searchReferred: 7 },
  };

  /** A `readBrowserStarts` seam that records its arguments. Specs never reach
   *  PostHog; the transport itself is covered in `posthog-query.spec.ts`. */
  const startsSeam = (outcome: PosthogBrowserStartsOutcome) =>
    vi.fn<NonNullable<AdminOverviewDeps['readBrowserStarts']>>(async () => outcome);

  /** The two expensive status items, stubbed so `?recompute=1` touches no network. */
  const noNetwork = {
    driftRunnerFor: () => undefined,
    fetchImpl: vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
  };

  it('does NOT query PostHog on a default load, and reports null rather than zero', async () => {
    // The read costs an external request, so it is gated on `?recompute=1` beside
    // the other two network-dependent items (§13 D8). A zero here would be a
    // fabricated number sitting next to a real residual.
    await seedDay();
    const seam = startsSeam(HEALTHY);
    const body = await overview('/api/admin/overview', TEST_ENV, { readBrowserStarts: seam });

    expect(seam).not.toHaveBeenCalled();
    expect(body.traffic.browser_starts).toBeNull();
    expect(body.traffic.browser_starts_unavailable).toBeNull();
    // The existing note already tells the operator an expensive item was skipped.
    expect(codes(body)).toContain('requires_recompute');
  });

  it('?recompute=1 returns all three counts, over the digest window', async () => {
    await seedDay();
    const seam = startsSeam(HEALTHY);
    const body = await overview('/api/admin/overview?recompute=1', TEST_ENV, {
      readBrowserStarts: seam,
      ...noNetwork,
    });

    expect(body.traffic.browser_starts).toEqual({
      starts_all: 21,
      starts: 13,
      search_referred: 7,
    });
    expect(body.traffic.browser_starts_unavailable).toBeNull();
    // The same window the 05:00 email reports, so the two surfaces describe one day.
    const window = seam.mock.calls[0][2] as unknown as { startIso: string };
    expect(window.startIso).toBe(`${DAY}T00:00:00.000Z`);
  });

  it('is exactly ONE extra read per recompute', async () => {
    await seedDay();
    const seam = startsSeam(HEALTHY);
    await overview('/api/admin/overview?recompute=1', TEST_ENV, {
      readBrowserStarts: seam,
      ...noNetwork,
    });
    expect(seam).toHaveBeenCalledTimes(1);
  });

  it('names the reason when the read ran and failed, and still returns null counts', async () => {
    await seedDay();
    const body = await overview('/api/admin/overview?recompute=1', TEST_ENV, {
      readBrowserStarts: startsSeam({ ok: false, reason: 'posthog_http_503' }),
      ...noNetwork,
    });
    expect(body.traffic.browser_starts).toBeNull();
    expect(body.traffic.browser_starts_unavailable).toBe('posthog_http_503');
  });

  it('reports a real zero as a zero, because zero starts is a finding', async () => {
    await seedDay();
    const body = await overview('/api/admin/overview?recompute=1', TEST_ENV, {
      readBrowserStarts: startsSeam({
        ok: true,
        starts: { startsAll: 0, starts: 0, searchReferred: 0 },
      }),
      ...noNetwork,
    });
    expect(body.traffic.browser_starts).toEqual({
      starts_all: 0,
      starts: 0,
      search_referred: 0,
    });
    expect(body.traffic.browser_starts_unavailable).toBeNull();
  });

  it('never folds starts into any D1 figure', async () => {
    // The two populations overlap and one of them is not consent-gated, so the
    // headline, the raw count and the corroborated floor must all be exactly what
    // they were before this field existed.
    await seedDay();
    const before = await overview();
    const after = await overview('/api/admin/overview?recompute=1', TEST_ENV, {
      readBrowserStarts: startsSeam(HEALTHY),
      ...noNetwork,
    });
    expect(after.traffic.page_views_human).toEqual(before.traffic.page_views_human);
    expect(after.traffic.page_views_human_raw).toEqual(before.traffic.page_views_human_raw);
    expect(after.traffic.corroborated_views).toBe(before.traffic.corroborated_views);
  });

  it('writes no audit_log row for the extra read', async () => {
    await seedDay();
    await overview('/api/admin/overview?recompute=1', TEST_ENV, {
      readBrowserStarts: startsSeam(HEALTHY),
      ...noNetwork,
    });
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});
