/**
 * `GET /api/admin/seo/queue` and `GET /api/admin/seo/trend` (AECI-818): Panels 1
 * and 2 of the search console. `GET /api/admin/seo/funnel` (AECI-823): Panel 3.
 * Source of truth: `docs/ADMIN_PANEL_SPEC.md` §5.24, `docs/API_CONTRACTS.md` §6.10
 * "Search console". Contracts: `packages/shared/src/api/admin-seo.ts`.
 * Derivations: `lib/seo-queue.ts` and `lib/seo-funnel.ts`.
 *
 * All three are reads behind `requireAdmin()`. No `audit_log` row (ADR 0022), no
 * `rateLimit()` (ADR 0026, reads are never limited), no `Cache-Tag`: `/admin/*`
 * is uncacheable. Every URL is absolute, built on `publicSiteBase(env)`, so it
 * pastes straight into URL Inspection.
 *
 * Every lane is computed live on each request. The catalog is about 1,500 URLs, so
 * the set is built in memory and sliced into the page. The 00:15 snapshot stores
 * the counts, which is what `/trend` reads for lane depth.
 */
import {
  SeoFunnelResponseSchema,
  SeoQueueQuerySchema,
  SeoQueueResponseSchema,
  SeoTrendQuerySchema,
  SeoTrendResponseSchema,
  type AdminSnapshotMetricKey,
  type SeoEngine,
  type SeoFunnelResponse,
  type SeoQueueItem,
  type SeoQueueLane,
  type SeoQueueResponse,
  type SeoTrendLanes,
  type SeoTrendResponse,
  type SeoTrendWeek,
} from '@aeci/shared';
import { and, gte, inArray, lte } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { metricsDaily } from '../db/schema';
import type { Env } from '../env';
import { json } from '../http';
import { note, shiftDay } from '../lib/admin-analytics';
import type { AuthzVariables } from '../lib/authz';
import { listCatalogUrls } from '../lib/catalog-urls';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { publicSiteBase } from '../lib/public-urls';
import { reindexAgeOnDay, type StampedReading } from '../lib/metrics-snapshot';
import { readSeoFunnel } from '../lib/seo-funnel';
import {
  EDGE_VERIFIED_SINCE,
  SEO_CRAWL_COHORT_DAYS,
  computeSeoLanes,
  crawlNotes,
  crawlWindow,
  queueReachesUnsplit,
  readCohortFetches,
  readReindexLane,
  readSelfReportedRequestsByDay,
  toCrawlAdminWindow,
  trendReachesUnsplit,
  wholeDaysSince,
  type SeoLaneEntry,
} from '../lib/seo-queue';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

const DAY_MS = 86_400_000;

/** The admin route the re-index lane links to. Its rows live there (§5.24.5). */
const REINDEX_HREF = '/admin/reindex';

export function createAdminSeoQueueHandler(
  dbFor: DbFactory = getDb,
  clock: () => Date = () => new Date(),
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const query = SeoQueueQuerySchema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const engine: SeoEngine = query.engine;
    const now = clock();
    const { db } = dbFor(c.env);
    const base = publicSiteBase(c.env);

    const emptyItems = {
      lane: query.lane,
      engine,
      data: [] as SeoQueueItem[],
      page: query.page,
      perPage: query.perPage,
      total: 0,
    };

    let body: SeoQueueResponse;
    if (base === null) {
      // §5.24.11: no public origin, so no URL can be built on this tier.
      // The window is pure, so the envelope keeps its shape without the lanes.
      body = {
        generated_at: now.toISOString(),
        window: toCrawlAdminWindow(crawlWindow(now)),
        lanes: [],
        items: emptyItems,
        notes: [
          note(
            'public_site_url_unset',
            'PUBLIC_SITE_URL is unset or unparseable, so no public URL can be built on this tier.',
          ),
        ],
      };
    } else {
      const lanes = await computeSeoLanes(db, now);
      const reindex = await readReindexLane(db, now);

      const summary: SeoQueueLane[] = [
        {
          lane: 'reindex',
          engine: 'google',
          count: reindex.count,
          oldest_tier12_age_days: reindex.oldestTier12AgeDays,
          href: REINDEX_HREF,
        },
        laneSummary('uncrawled', 'google', lanes.uncrawled.google.length),
        laneSummary('uncrawled', 'bing', lanes.uncrawled.bing.length),
      ];

      // Pair pages with no reviews are not a lane here (Chris, 2026-11-24). Their
      // count is on `/trend`, from the `seo.pairs_without_reviews` snapshot key.
      const selected: SeoLaneEntry[] = lanes.uncrawled[engine];
      const start = (query.page - 1) * query.perPage;
      const page = selected.slice(start, start + query.perPage).map(
        (e): SeoQueueItem => ({
          url: `${base}${e.path}`,
          page_type: e.pageType,
          published_at: e.publishedAt,
          age_days: wholeDaysSince(e.publishedAt, now),
          last_fetch_at: e.lastFetchAt,
        }),
      );

      body = {
        generated_at: now.toISOString(),
        window: toCrawlAdminWindow(lanes.window),
        lanes: summary,
        items: { ...emptyItems, data: page, total: selected.length },
        notes: crawlNotes({
          ...(lanes.window.clamped ? { clampedFrom: lanes.window.from } : {}),
          reachesUnverified: lanes.window.reachesUnverified,
          reachesUnsplit: queueReachesUnsplit(lanes),
        }),
      };
    }

    validateResponseInDev(c.env, () => {
      SeoQueueResponseSchema.parse(body);
    });
    return json(body);
  };
}

function laneSummary(lane: SeoQueueLane['lane'], engine: SeoEngine, count: number): SeoQueueLane {
  return { lane, engine, count, oldest_tier12_age_days: null, href: null };
}

// ─── Panel 2 ─────────────────────────────────────────────────────────────────

/** The `metrics_daily` key behind each Panel 2 lane field. */
const TREND_LANE_KEYS: Record<keyof SeoTrendLanes, AdminSnapshotMetricKey> = {
  reindex_pending: 'queue.reindex_pending',
  reindex_oldest_tier12_age_days: 'queue.reindex_oldest_tier12_age_days',
  uncrawled_google: 'seo.uncrawled_urls_google',
  uncrawled_bing: 'seo.uncrawled_urls_bing',
  pairs_without_reviews: 'seo.pairs_without_reviews',
};

/** A supporting key, never a row of its own: it decides how the age reads. */
const TIER12_COUNT_KEY = 'queue.reindex_tier12_pending' satisfies AdminSnapshotMetricKey;

/** The Monday of `now`'s ISO week, `YYYY-MM-DD`, UTC. */
export function isoWeekMonday(now: Date): string {
  const today = now.toISOString().slice(0, 10);
  const dow = now.getUTCDay(); // 0 = Sunday
  return shiftDay(today, -((dow + 6) % 7));
}

function rate(crawled: number, published: number): number | null {
  if (published === 0) return null;
  return Math.round((crawled / published) * 10_000) / 10_000;
}

export function createAdminSeoTrendHandler(
  dbFor: DbFactory = getDb,
  clock: () => Date = () => new Date(),
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const { weeks: weekCount } = SeoTrendQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const now = clock();
    const nowIso = now.toISOString();
    const { db } = dbFor(c.env);

    // Complete ISO weeks only: the current week is partial, so it is excluded.
    const currentMonday = isoWeekMonday(now);
    const mondays = Array.from({ length: weekCount }, (_, i) =>
      shiftDay(currentMonday, -7 * (i + 1)),
    );
    const oldestMonday = mondays[mondays.length - 1]!;
    const fromIso = `${oldestMonday}T00:00:00.000Z`;
    const toIso = `${currentMonday}T00:00:00.000Z`;

    const [stored, catalog, hits, requests] = await Promise.all([
      db
        .select({
          day: metricsDaily.day,
          metric: metricsDaily.metric,
          value: metricsDaily.value,
          computedAt: metricsDaily.computedAt,
        })
        .from(metricsDaily)
        .where(
          and(
            inArray(metricsDaily.metric, [...Object.values(TREND_LANE_KEYS), TIER12_COUNT_KEY]),
            gte(metricsDaily.day, oldestMonday),
            lte(metricsDaily.day, shiftDay(currentMonday, -1)),
          ),
        ),
      listCatalogUrls(db),
      readCohortFetches(db, fromIso, nowIso),
      readSelfReportedRequestsByDay(db, fromIso, toIso),
    ]);

    const byKeyDay = new Map<string, StampedReading>();
    for (const r of stored) {
      byKeyDay.set(`${r.metric}|${r.day}`, { value: r.value, computedAt: r.computedAt });
    }

    const out: SeoTrendWeek[] = mondays.map((monday) => {
      const days = Array.from({ length: 7 }, (_, i) => shiftDay(monday, i));
      const weekEndIso = `${shiftDay(monday, 7)}T00:00:00.000Z`;
      const weekStartIso = `${monday}T00:00:00.000Z`;

      // The week's Sunday, else the latest day in the week with a row. Per key, so
      // one missing key does not null the others.
      const latestIn = (key: AdminSnapshotMetricKey): { day: string; value: number } | null => {
        for (let i = days.length - 1; i >= 0; i -= 1) {
          const v = byKeyDay.get(`${key}|${days[i]}`);
          if (v !== undefined) return { day: days[i]!, value: v.value };
        }
        return null;
      };
      const depth = (field: Exclude<keyof SeoTrendLanes, 'reindex_oldest_tier12_age_days'>) =>
        latestIn(TREND_LANE_KEYS[field])?.value ?? null;

      // The oldest-age key writes NO row on a day with no tier-1 or tier-2 row, so
      // it must not fall back to an earlier day: a queue that empties on Friday
      // would still show Wednesday's age. It is read on the latest day in the week
      // with a tier-1 and tier-2 count row, against that row (`reindexAgeOnDay`).
      // A count of 0 is `'none'`. A missing or stale age row under a positive
      // count is null, not recorded. A week with no count row is null.
      const sampled = latestIn(TIER12_COUNT_KEY);
      const age = sampled
        ? reindexAgeOnDay(
            byKeyDay.get(`${TIER12_COUNT_KEY}|${sampled.day}`),
            byKeyDay.get(`${TREND_LANE_KEYS.reindex_oldest_tier12_age_days}|${sampled.day}`),
          )
        : null;

      const lanes: SeoTrendLanes = {
        reindex_pending: depth('reindex_pending'),
        reindex_oldest_tier12_age_days: age,
        uncrawled_google: depth('uncrawled_google'),
        uncrawled_bing: depth('uncrawled_bing'),
        pairs_without_reviews: depth('pairs_without_reviews'),
      };

      // Product and vendor pages only. A pair's anchor moves when its row moves
      // between tables, so a pair cohort would mix publications with moves.
      const cohort = catalog.filter(
        (u) =>
          (u.pageType === 'product' || u.pageType === 'vendor') &&
          u.publishedAt !== null &&
          u.publishedAt >= weekStartIso &&
          u.publishedAt < weekEndIso,
      );
      const crawled = (engine: SeoEngine) =>
        cohort.filter((u) => u.entityId !== undefined && hits.has(`${engine}:${u.entityId}`))
          .length;
      const google = crawled('google');
      const bing = crawled('bing');
      const closesAt = Date.parse(weekEndIso) + SEO_CRAWL_COHORT_DAYS * DAY_MS;

      return {
        week_start: monday,
        lanes,
        cohort: {
          published: cohort.length,
          crawled_within_days: SEO_CRAWL_COHORT_DAYS,
          open: closesAt > now.getTime(),
          google: { crawled: google, rate: rate(google, cohort.length) },
          bing: { crawled: bing, rate: rate(bing, cohort.length) },
        },
        requests_self_reported: days.reduce((n, d) => n + (requests.get(d) ?? 0), 0),
      };
    });

    const body: SeoTrendResponse = {
      generated_at: nowIso,
      weeks: out,
      // The cohort is matched on entity id, not `concrete_path`, so the
      // `CONCRETE_PATH_SINCE` clamp does not apply to it.
      notes: crawlNotes({
        reachesUnverified: fromIso < EDGE_VERIFIED_SINCE,
        reachesUnsplit: trendReachesUnsplit(fromIso),
      }),
    };

    validateResponseInDev(c.env, () => {
      SeoTrendResponseSchema.parse(body);
    });
    return json(body);
  };
}

// ─── Panel 3 ─────────────────────────────────────────────────────────────────

/**
 * `GET /api/admin/seo/funnel` (AECI-823): the per-engine funnel over the trailing
 * 28 days. Takes no query parameters: the funnel is `www_page` only for Google,
 * and the `property` figures ride the Google entry's `baseline`. The windows, and
 * how Pacific ingest dates and UTC snapshot days are each treated, are in
 * `lib/seo-funnel.ts`.
 */
export function createAdminSeoFunnelHandler(
  dbFor: DbFactory = getDb,
  clock: () => Date = () => new Date(),
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const { db } = dbFor(c.env);
    const body: SeoFunnelResponse = await readSeoFunnel(db, clock());
    validateResponseInDev(c.env, () => {
      SeoFunnelResponseSchema.parse(body);
    });
    return json(body);
  };
}
