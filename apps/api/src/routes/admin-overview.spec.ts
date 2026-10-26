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
 *
 * AECI-1460 removed the residual tile's fields from the wire. The parity cases
 * now pin the surviving figures and the class-filtered tables.
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
  vendorRequests,
} from '../db/schema';
import type { Env } from '../env';
import {
  buildAnalyticsDigest,
  collectAnalyticsMetrics,
  TABLES_UNCLASSIFIED_NOTE,
  windowsForDay,
} from '../lib/analytics-digest';
import { COLLECTION_METHOD_CHANGES } from '../lib/collection-method-changes';
import { CHECKS } from '../lib/data-quality';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';

import { createAdminOverviewHandler, type AdminOverviewDeps } from './admin-overview';

/** The real production AECI-1460 §3d row (AECI-1465). */
const AECI_1460_ROW = COLLECTION_METHOD_CHANGES.find(
  (r) => r.issue === 'AECI-1460' && r.tier === 'production',
)!;

/** Store one classification for an existing page view (AECI-1460 table filter). */
function classifyRow(id: number, cls: string, day: string, version = 'v1'): void {
  t.raw
    .prepare(
      `INSERT INTO page_view_classifications
         (page_view_id, class, reason_codes, classifier_version, evaluated_at,
          evidence_from, evidence_to, view_day, created_at)
       VALUES (?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      cls,
      version,
      `${day}T23:59:00.000Z`,
      `${day}T00:00:00.000Z`,
      `${day}T00:00:00.000Z`,
      day,
      `${day}T23:59:00.000Z`,
    );
}

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

/** A `vendor_requests` row with only the columns the moderation depths key off.
 *  The target is `u(1)`, which `seedDay` creates. */
function req(n: number, kind: 'claim' | 'correction', status: string) {
  return {
    id: u(n),
    kind,
    status,
    targetType: 'product',
    targetId: u(1),
    submitterEmail: `s${n}@example.com`,
    body: 'b',
  };
}

describe('GET /api/admin/overview — digest parity (the AECI-574 acceptance criterion)', () => {
  it('reports the same numbers the analytics digest email reports for that day', async () => {
    await seedDay();

    // What the 05:00 cron would compute and email for `DAY`.
    const metrics = await collectAnalyticsMetrics(t.db, windowsForDay(DAY));
    const email = buildAnalyticsDigest(metrics, {
      env: 'staging',
      dayLabel: DAY,
      generatedAt: NOW,
    });

    const body = await overview();

    // Traffic
    expect(body.traffic.page_views_bot.total).toBe(metrics.botPageViews.day);
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
    // The D15(b) operator-leak figure lives on the class internal line now, off
    // the same collector the email's internal line reads.
    expect(body.classification.internal_excluded.operator_leak_inferred).toBe(
      metrics.operatorLeakViews,
    );

    // The fixture has no classes, so the email names that and carries no count,
    // and both surfaces say the tables are unfiltered (AECI-1460).
    expect(metrics.tablesUnclassified).toBe(true);
    expect(email.subject).toContain(': NOT CLASSIFIED,');
    expect(email.subject).not.toContain('unresolved origin');
    const tablesNote = body.notes.find((n) => n.code === 'tables_unclassified');
    expect(tablesNote).toMatchObject({ severity: 'info', message: TABLES_UNCLASSIFIED_NOTE });
  });

  it('serves only the surviving traffic fields (AECI-1460)', async () => {
    await seedDay();
    const body = await overview();
    expect(Object.keys(body.traffic).sort()).toEqual([
      'arrival_telemetry',
      'page_views_bot',
      'series_30d',
      'top_products',
      'top_sources',
      'unique_visitors',
    ]);
    const retired = [
      'automation_filter_applied',
      'automation_filter_did_not_run',
      'corroborated_is_a_referrer_floor',
      'operator_leak_is_an_inference',
    ];
    for (const code of retired) expect(codes(body) as string[]).not.toContain(code);
  });

  it('filters the tables by class, the same rows the email lists (AECI-1460)', async () => {
    await seedDay();
    // Classify the reported day: the two Procore views are automation, the Revit
    // arrival is unresolved. The unclassified-bot row gets no class and is kept.
    const rows = await t.db
      .select({ id: pageViews.id, productId: pageViews.productId, createdAt: pageViews.createdAt })
      .from(pageViews);
    for (const r of rows) {
      if (!r.createdAt.startsWith(DAY)) continue;
      if (r.productId === u(1)) classifyRow(r.id, 'identified_automation', DAY);
      if (r.productId === u(2)) classifyRow(r.id, 'unresolved', DAY);
    }

    const metrics = await collectAnalyticsMetrics(t.db, windowsForDay(DAY));
    const body = await overview();

    expect(body.traffic.top_products).toEqual([{ name: 'Revit', slug: 'revit', views: 1 }]);
    expect(body.traffic.top_sources).toEqual([{ source: 'Google', views: 1 }]);
    expect(body.traffic.top_products).toEqual(
      metrics.topProducts.map((p) => ({ name: p.name, slug: p.slug, views: p.views })),
    );
    expect(codes(body)).not.toContain('tables_unclassified');
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
    expect(metrics.pageViews).toEqual({ day: 4, prior: 2 });
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
    await t.db.insert(profiles).values([{ id: u(11), createdAt: `${DAY}T01:00:00.000Z` }]);
    const body = await overview();
    expect(body.audience.new_sign_ins).toEqual({ current: 1, prior: 0, diff: 1, pct: null });
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
    expect(body.traffic.series_30d.at(-1)?.human).toBe(4);
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

  // AECI-1460 retired `operator_leak_is_an_inference` with the residual. The
  // figure survives on the class section's internal line.
  it('reports the operator-leak inference on the class internal line only', async () => {
    await seedDay();
    expect((await overview()).classification.internal_excluded.operator_leak_inferred).toBe(0);
    // One verified operator row on the same (user_agent_hash, cf_asn) pair as the
    // two Procore views. It sits on `/admin`, which §9.6 already excludes.
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
    expect(body.classification.internal_excluded.operator_leak_inferred).toBe(2);
    expect(codes(body) as string[]).not.toContain('operator_leak_is_an_inference');
  });
});

describe('GET /api/admin/overview — the internal-ASN filter (§13 D10)', () => {
  it('applies no ASN exclusion, and says so, when the var is unset', async () => {
    await seedDay();
    const body = await overview();
    expect(body.internal_filter).toEqual({ available: false, applied: false, asns: [] });
    expect(body.traffic.page_views_bot.excluding_internal).toBeNull();
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
    // 1 bot view, on AS15169, which is not internal. The visitor pairs on AS23700
    // are: hash-a counts once in the total and not in the filtered figure.
    expect(body.traffic.page_views_bot).toEqual({ total: 1, excluding_internal: 1 });
    expect(body.traffic.unique_visitors.total).toBe(3);
    expect(body.traffic.unique_visitors.excluding_internal).toBe(2);
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
              id: 'promotion_status_invariant',
              label: "Catalog rows not at promotion_status='promoted'",
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
      environment: 'development',
    });
    expect(body.status.stats_freshness.computed_at).toBe('2026-08-11T01:00:00.000Z');
    expect(body.status.stats_freshness.stale).toBe(false);
    expect(body.status.moderation).toEqual({
      pending_reviews: 0,
      open_requests: 0,
      open_claims: 0,
    });
  });

  // AECI-922. `open_requests` links the operator to `/admin/requests`, which is
  // CORRECTIONS ONLY, so an all-kinds count would name a number that page cannot
  // show — and would double every open claim against the Operations nav badge
  // beside it. The two kinds are one `vendor_requests` table, so only a fixture
  // holding both catches a missing `kind` predicate.
  it('splits the request backlog by kind, and counts only open rows', async () => {
    await seedDay();
    await t.db.insert(vendorRequests).values([
      req(31, 'correction', 'open'),
      req(32, 'correction', 'open'),
      req(33, 'claim', 'open'),
      req(34, 'claim', 'open'),
      req(35, 'claim', 'open'),
      // Neither is waiting on an operator's first look, so neither is a depth.
      req(36, 'claim', 'in_review'),
      req(37, 'correction', 'resolved'),
    ]);

    const body = await overview();
    expect(body.status.moderation.open_requests).toBe(2);
    expect(body.status.moderation.open_claims).toBe(3);
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
    // The §13 D15 envelope carries it, above the classes whose network inputs it
    // says were empty — the cause has to sit above the effect.
    expect(codes(body)).toContain('arrival_telemetry_unavailable');
    const note = body.notes.find((n) => n.code === 'arrival_telemetry_unavailable');
    expect(note?.severity).toBe('warn');
    expect(note?.params).toEqual({ arrivals: 8, arrivals_with_asn: 1 });
    expect(codes(body).indexOf('arrival_telemetry_unavailable')).toBeLessThan(
      codes(body).indexOf('classification_is_heuristic'),
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

describe('GET /api/admin/overview — stored traffic classes (AECI-1345)', () => {
  it('returns four zero counts and a null version before the writer has run, and changes no traffic figure', async () => {
    await seedDay();
    const body = await overview();

    expect(body.classification).toMatchObject({
      classifier_version: null,
      basis: 'requests',
      version_seam: null,
      internal_excluded: { views: 0, operator_leak_inferred: 0 },
    });
    expect(body.classification.counts.map((c) => c.views)).toEqual([0, 0, 0, 0]);
    // The heuristic caveat is unconditional; the two gated notes are absent.
    expect(codes(body)).toContain('classification_is_heuristic');
    expect(codes(body)).not.toContain('classification_unresolved_share');
    expect(codes(body)).not.toContain('classification_version_seam');
  });

  it('reads the stored classes for the day and warns when unresolved is above half', async () => {
    await seedDay();
    const before = await overview();
    const { classifyDay } = await import('../lib/traffic-classification-writer');
    const { TRAFFIC_CLASSIFIER_VERSION } = await import('../lib/traffic-classifier');
    const stored = await classifyDay(t.db, DAY, NOW);

    const body = await overview();

    expect(body.classification.classifier_version).toBe(TRAFFIC_CLASSIFIER_VERSION);
    const total = body.classification.counts.reduce((a, c) => a + c.views, 0);
    expect(total + body.classification.internal_excluded.views).toBe(stored.rowsSeen);
    // seedDay's crawler declares itself; the four other rows carry no human evidence.
    expect(body.classification.counts.find((c) => c.class === 'identified_automation')?.views).toBe(
      1,
    );
    const warn = body.notes.find((n) => n.code === 'classification_unresolved_share');
    expect(warn).toMatchObject({ severity: 'warn', params: { unresolved: 4, classified: 5 } });
    // Phase 2 changes no reported number.
    expect(body.traffic).toEqual(before.traffic);
  });
});

describe('GET /api/admin/overview — class deltas, the class series and seams (AECI-1346)', () => {
  /** One page view on `day`, classified as `cls` under `version`. */
  async function classified(day: string, cls: string, version: string, extra = {}) {
    const [row] = await t.db
      .insert(pageViews)
      .values({
        path: '/x',
        isBot: false,
        cfAsn: 7922,
        userAgentHash: `ua-${day}-${cls}`,
        createdAt: `${day}T10:00:00.000Z`,
        ...extra,
      })
      .returning({ id: pageViews.id });
    t.raw
      .prepare(
        `INSERT INTO page_view_classifications
           (page_view_id, class, reason_codes, classifier_version, evaluated_at,
            evidence_from, evidence_to, view_day, created_at)
         VALUES (?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row!.id,
        cls,
        version,
        `${day}T23:59:00.000Z`,
        `${day}T00:00:00.000Z`,
        `${day}T00:00:00.000Z`,
        day,
        `${day}T23:59:00.000Z`,
      );
  }
  const delta = (body: AdminOverviewResponse, cls: string) =>
    body.classification.counts.find((c) => c.class === cls)?.delta_day;

  it('computes a views delta per class against the prior day on the same version', async () => {
    await classified('2026-08-09', 'unresolved', 'v1');
    await classified(DAY, 'unresolved', 'v1');
    await classified(DAY, 'unresolved', 'v1', { userAgentHash: 'other' });
    await classified(DAY, 'identified_automation', 'v1');

    const body = await overview();
    expect(delta(body, 'unresolved')).toEqual({ current: 2, prior: 1, diff: 1, pct: 100 });
    expect(delta(body, 'identified_automation')).toEqual({
      current: 1,
      prior: 0,
      diff: 1,
      pct: null,
    });
    expect(body.classification.version_seam).toBeNull();
    expect(codes(body)).not.toContain('collection_method_seam');
    expect(body.classification.method_seams).toEqual([]);
  });

  it('nulls every class delta when the prior day was not classified', async () => {
    await classified(DAY, 'unresolved', 'v1');
    const body = await overview();
    expect(body.classification.counts.map((c) => c.delta_day)).toEqual([null, null, null, null]);
  });

  it('nulls every class delta across a version change, and the 30-day seam fires the note', async () => {
    await classified('2026-08-09', 'unresolved', 'v1');
    await classified(DAY, 'unresolved', 'v2');
    const body = await overview();
    expect(body.classification.counts.map((c) => c.delta_day)).toEqual([null, null, null, null]);
    expect(body.classification.version_seam).toEqual({
      from_version: 'v1',
      to_version: 'v2',
      changed_on: DAY,
    });
    expect(codes(body)).toContain('classification_version_seam');
  });

  it('fires the seam note for a change anywhere in the chart window, deltas kept', async () => {
    // The change is three weeks back. The reported pair is on one version.
    await classified('2026-07-20', 'unresolved', 'v1');
    await classified('2026-08-09', 'unresolved', 'v2');
    await classified(DAY, 'unresolved', 'v2');
    const body = await overview();
    expect(body.classification.version_seam).toMatchObject({
      from_version: 'v1',
      to_version: 'v2',
    });
    expect(codes(body)).toContain('classification_version_seam');
    expect(delta(body, 'unresolved')).toEqual({ current: 1, prior: 1, diff: 0, pct: 0 });
  });

  it('zero-fills the class series by day, with null counts on unclassified days', async () => {
    await classified('2026-08-09', 'suspected_automation', 'v1');
    await classified(DAY, 'unresolved', 'v1');
    const body = await overview();
    const series = body.classification_series_30d;
    expect(series).toHaveLength(30);
    expect(series[0]!.day).toBe('2026-07-12');
    expect(series.at(-1)).toEqual({
      day: DAY,
      classifier_version: 'v1',
      counts: {
        identified_automation: 0,
        suspected_automation: 0,
        browser_with_human_evidence: 0,
        unresolved: 1,
      },
      method_change: null,
    });
    expect(series.at(-2)?.counts?.suspected_automation).toBe(1);
    // Unclassified days are null, never four zeros.
    expect(series[0]).toEqual({
      day: '2026-07-12',
      classifier_version: null,
      counts: null,
      method_change: null,
    });
  });

  it('keeps internal traffic out of the class series', async () => {
    await classified(DAY, 'unresolved', 'v1');
    await classified(DAY, 'unresolved', 'v1', { isOperator: true, userAgentHash: 'op' });
    const body = await overview();
    expect(body.classification_series_30d.at(-1)?.counts?.unresolved).toBe(1);
  });

  it('a non-comparable §3d row (staging 2026-10-21) nulls the class deltas', async () => {
    const day = '2026-10-21';
    await classified('2026-10-20', 'unresolved', 'v1');
    await classified(day, 'unresolved', 'v1');
    const body = await overview(`/api/admin/overview?day=${day}`, { ...TEST_ENV, ENV: 'staging' });

    expect(body.classification.counts.map((c) => c.delta_day)).toEqual([null, null, null, null]);
    const n = body.notes.find((x) => x.code === 'collection_method_seam');
    expect(n).toMatchObject({
      severity: 'info',
      params: {
        changed_at: '2026-10-21T10:38:00.000Z',
        tier: 'staging',
        comparable: 'false',
      },
    });
    expect(body.classification.method_seams).toEqual([
      {
        changed_at: '2026-10-21T10:38:00.000Z',
        summary: expect.any(String),
        arrivals_comparable: false,
      },
    ]);
    expect(body.classification_series_30d.at(-1)?.method_change).toEqual({
      summary: expect.any(String),
      arrivals_comparable: false,
    });
  });

  it('a comparable §3d row (production 2026-10-22) is informational: deltas kept', async () => {
    const day = '2026-10-22';
    await classified('2026-10-21', 'unresolved', 'v1');
    await classified(day, 'unresolved', 'v1');
    const body = await overview(`/api/admin/overview?day=${day}`, {
      ...TEST_ENV,
      ENV: 'production',
    });
    expect(delta(body, 'unresolved')).toEqual({ current: 1, prior: 1, diff: 0, pct: 0 });
    expect(body.notes.find((x) => x.code === 'collection_method_seam')?.params).toMatchObject({
      tier: 'production',
      comparable: 'true',
    });
  });

  it('keeps the staging row in the chart window weeks later, with the deltas restored', async () => {
    const day = '2026-11-10';
    await classified('2026-11-09', 'unresolved', 'v1');
    await classified(day, 'unresolved', 'v1');
    const body = await overview(`/api/admin/overview?day=${day}`, {
      ...TEST_ENV,
      ENV: 'staging',
    });
    expect(codes(body)).toContain('collection_method_seam');
    expect(delta(body, 'unresolved')).not.toBeNull();
  });

  it('flags a comparable AECI-1460 row and leaves every class delta standing', async () => {
    const day = '2026-10-26';
    await classified('2026-10-25', 'unresolved', 'v1');
    await classified('2026-10-25', 'identified_automation', 'v1');
    await classified(day, 'unresolved', 'v1');
    await classified(day, 'identified_automation', 'v1');
    const body = await overview(`/api/admin/overview?day=${day}`, {
      ...TEST_ENV,
      ENV: 'production',
    });
    // The chart window also holds the real AECI-1443 production row (2026-10-22).
    const seam = body.notes.find(
      (x) => x.code === 'collection_method_seam' && x.params?.changed_at === AECI_1460_ROW.at,
    );
    expect(seam).toMatchObject({
      severity: 'info',
      params: {
        changed_at: AECI_1460_ROW.at,
        tier: 'production',
        summary: AECI_1460_ROW.summary,
        comparable: 'true',
      },
    });
    expect(body.classification.method_seams).toContainEqual({
      changed_at: AECI_1460_ROW.at,
      summary: AECI_1460_ROW.summary,
      arrivals_comparable: true,
    });
    expect(delta(body, 'unresolved')).toEqual({ current: 1, prior: 1, diff: 0, pct: 0 });
    expect(delta(body, 'identified_automation')).toEqual({
      current: 1,
      prior: 1,
      diff: 0,
      pct: 0,
    });
    expect(body.classification.counts.every((c) => c.delta_day !== null)).toBe(true);
  });

  it('matches no §3d row on a local run', async () => {
    const body = await overview('/api/admin/overview?day=2026-10-21');
    expect(codes(body)).not.toContain('collection_method_seam');
  });

  it('reports the same class figures the digest collector read', async () => {
    await classified('2026-08-09', 'unresolved', 'v1');
    await classified(DAY, 'browser_with_human_evidence', 'v1');
    const body = await overview();
    const metrics = await collectAnalyticsMetrics(t.db, windowsForDay(DAY));
    expect(
      body.classification.counts.map(({ class: c, views, visitors }) => ({ c, views, visitors })),
    ).toEqual(
      metrics.classification!.day.summary.counts.map(({ class: c, views, visitors }) => ({
        c,
        views,
        visitors,
      })),
    );
  });
});
