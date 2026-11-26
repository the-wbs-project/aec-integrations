/**
 * The search console's derivations (AECI-818, `ADMIN_PANEL_SPEC.md` §5.24): the
 * Panel 1 lanes, the Panel 2 cohort and request counts, and the `seo.*` and
 * `queue.*` snapshot stocks.
 *
 * Three callers share it, so the three can never count one lane two ways:
 * `GET /api/admin/seo/queue` and `/trend` (`routes/admin-seo.ts`) and the 00:15
 * snapshot (`./metrics-snapshot`). The funnel (`./seo-funnel`) reuses the lane
 * computation when the snapshot has not yet filed a day.
 *
 * Everything here is a read. No `audit_log` row (ADR 0022). The snapshot rows the
 * stocks feed are derived, log-class writes, exempt for the same reason.
 *
 * ─── The universe ─────────────────────────────────────────────────────────────
 *
 * Every lane is computed over `listCatalogUrls` (`./catalog-urls`), the catalog
 * half of the sitemap. The visibility filter, the retired-slug rule and the trade
 * gate are not restated here. Static and docs pages are not in D1, so no lane
 * covers them.
 *
 * ─── The crawl predicate (§5.24.4) ────────────────────────────────────────────
 *
 * A catalog URL counts as fetched by an engine when a `page_views` row has
 * `is_bot = 1`, `bot_name` equal to that engine's label, a non-NULL
 * `cf_verified_bot_category` (Cloudflare verified the bot), a `concrete_path`
 * equal to the URL's path (a pair URL also matches its other orientation), and a
 * `created_at` inside the window. A NULL `concrete_path` never matches.
 *
 * The crawled path set is fetched ONCE per call and joined in memory. There is no
 * query with one bound parameter per URL: the catalog is about 1,500 URLs, and D1
 * caps bound parameters far below that, a limit the test harness does not enforce.
 */
import { type AdminNote, type AdminWindow, type SeoEngine } from '@aeci/shared';
import {
  and,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  min,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { Db } from '../db/client';
import { gscRecrawlQueue, pageViews, products, recrawlSubmissions, vendors } from '../db/schema';
import { note } from './admin-analytics';
import { listCatalogUrls, type CatalogUrl } from './catalog-urls';

// ─── Tunables (§5.24.12, `POST_LAUNCH_MONITORING.md` §3) ─────────────────────

/** The crawl lookback. Search Console's own reports use 28 days. */
export const SEO_CRAWL_LOOKBACK_DAYS = 28;
/** A page younger than this is not overdue, so it is not in a "Not crawled" lane. */
export const SEO_UNCRAWLED_GRACE_DAYS = 7;
/** Panel 2's "crawled within 7 days" window, measured from the publish anchor. */
export const SEO_CRAWL_COHORT_DAYS = 7;

/**
 * A fact, not a tunable: the first production row with a `concrete_path`
 * (`ANALYTICS_BASELINE.md`, "What AECI-585 started recording"). A window that
 * starts earlier is clamped here, and the response carries `crawl_window_clamped`.
 * A pre-AECI-585 row can therefore never make a page read as uncrawled: the clamp
 * removes it from the window rather than counting it as a miss.
 */
export const CONCRETE_PATH_SINCE = '2026-08-18T03:49:00.000Z';

/**
 * When `cf_verified_bot_category` began to be written in production (AECI-1301,
 * migration `0072`). Rows before it carry no edge verdict, so they count on the
 * user-agent label alone and the response carries `crawler_label_unverified`.
 *
 * A fact, not a tunable. Read from production on 2026-11-24 by the operator, with
 * `SELECT min(created_at) FROM page_views WHERE cf_verified_bot_category IS NOT NULL`.
 * It is the first production row with an edge verdict. Never move it.
 */
export const EDGE_VERIFIED_SINCE = '2026-10-13T08:02:33.500Z';

/**
 * When Google-InspectionTool got its own `bot_name` in production (AECI-2061).
 * Rows before it file a URL Inspection live test under `Googlebot`, and the raw
 * user agent is gone, so they cannot be split. A window that reaches before it
 * carries `crawler_label_includes_inspection_tool`.
 *
 * A fact, not a tunable. `null` until the operator records the production date (AECI-2222)
 * (`POST_LAUNCH_MONITORING.md` §3, "Search console tunables"). While it is null,
 * every window counts as reaching before it. Never move it once set.
 */
export const INSPECTION_TOOL_SPLIT_SINCE: string | null = null;

/** Whether a row or window starting at `fromIso` is from before the split. */
export function reachesUnsplitLabel(
  fromIso: string,
  since: string | null = INSPECTION_TOOL_SPLIT_SINCE,
): boolean {
  return since === null || fromIso < since;
}

/**
 * Whether the queue needs the split caveat. Its window can start after the split
 * while a Google lane entry's `lastFetchAt`, read from all history, is a
 * pre-split `Googlebot` row that may be a URL Inspection test.
 */
export function queueReachesUnsplit(
  lanes: { window: CrawlWindow; uncrawled: Record<SeoEngine, SeoLaneEntry[]> },
  since: string | null = INSPECTION_TOOL_SPLIT_SINCE,
): boolean {
  return (
    reachesUnsplitLabel(lanes.window.from, since) ||
    lanes.uncrawled.google.some(
      (e) => e.lastFetchAt !== null && reachesUnsplitLabel(e.lastFetchAt, since),
    )
  );
}

/**
 * Whether the trend needs the split caveat. The oldest week's lane snapshots
 * count fetches over `SEO_CRAWL_LOOKBACK_DAYS` before it, so the reach starts
 * that far before `fromIso`.
 */
export function trendReachesUnsplit(
  fromIso: string,
  since: string | null = INSPECTION_TOOL_SPLIT_SINCE,
): boolean {
  const lookbackFrom = new Date(Date.parse(fromIso) - SEO_CRAWL_LOOKBACK_DAYS * DAY_MS);
  return reachesUnsplitLabel(lookbackFrom.toISOString(), since);
}

/** The ingest-time `NAMED_BOTS` label per engine (`lib/bot-classification.ts`). No
 *  other crawler counts, including the `Datacenter (Google)` ASN verdict. */
export const ENGINE_BOT_NAME: Record<SeoEngine, string> = {
  google: 'Googlebot',
  bing: 'Bingbot',
};

const ENGINES: readonly SeoEngine[] = ['google', 'bing'];
const DAY_MS = 86_400_000;

// ─── The window ──────────────────────────────────────────────────────────────

export interface CrawlWindow {
  /** Inclusive start, ISO. Never before {@link CONCRETE_PATH_SINCE}. */
  from: string;
  /** Exclusive end, ISO. */
  to: string;
  /** The unclamped start was before `CONCRETE_PATH_SINCE`. */
  clamped: boolean;
  /** The window reaches before {@link EDGE_VERIFIED_SINCE}. */
  reachesUnverified: boolean;
  /** The window reaches before {@link INSPECTION_TOOL_SPLIT_SINCE}. */
  reachesUnsplit: boolean;
}

/** `SEO_CRAWL_LOOKBACK_DAYS` ending at `to`, clamped to `CONCRETE_PATH_SINCE`. */
export function crawlWindow(to: Date, days = SEO_CRAWL_LOOKBACK_DAYS): CrawlWindow {
  const toIso = to.toISOString();
  const raw = new Date(to.getTime() - days * DAY_MS).toISOString();
  const clamped = raw < CONCRETE_PATH_SINCE;
  // A window ending before `CONCRETE_PATH_SINCE` is empty, never inverted.
  const from = clamped ? (toIso < CONCRETE_PATH_SINCE ? toIso : CONCRETE_PATH_SINCE) : raw;
  return {
    from,
    to: toIso,
    clamped,
    reachesUnverified: from < EDGE_VERIFIED_SINCE,
    reachesUnsplit: reachesUnsplitLabel(from),
  };
}

/** The window as the console envelope reports it. */
export function toCrawlAdminWindow(w: CrawlWindow): AdminWindow {
  const days = Math.max(1, Math.ceil((Date.parse(w.to) - Date.parse(w.from)) / DAY_MS));
  return { from: w.from, to: w.to, timezone: 'UTC', days };
}

// ─── The crawl predicate ─────────────────────────────────────────────────────

/** Verified by Cloudflare, or written before edge verification existed. */
const VERIFIED_OR_PRE_EDGE: SQL = or(
  isNotNull(pageViews.cfVerifiedBotCategory),
  lt(pageViews.createdAt, EDGE_VERIFIED_SINCE),
)!;

/**
 * The crawler predicate. `is_bot = 1` is a LITERAL, never a bound parameter: the
 * crawled-path read relies on the partial `page_views_crawl_path_idx`, and SQLite
 * uses a partial index only when the query's WHERE provably implies the index's
 * WHERE. A bound `is_bot = ?` does not.
 */
const IS_BOT: SQL = sql`${pageViews.isBot} = 1`;

function searchCrawlerWhere(fromIso: string, toIso: string): SQL {
  return and(
    IS_BOT,
    gte(pageViews.createdAt, fromIso),
    lt(pageViews.createdAt, toIso),
    inArray(pageViews.botName, Object.values(ENGINE_BOT_NAME)),
    VERIFIED_OR_PRE_EDGE,
  )!;
}

function engineOf(botName: string | null): SeoEngine | null {
  for (const engine of ENGINES) if (ENGINE_BOT_NAME[engine] === botName) return engine;
  return null;
}

/** One trailing slash is tolerated, as `parseLandingPath` tolerates it. */
function normalizePath(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

export type LastFetchByPath = Record<SeoEngine, Map<string, string>>;

/**
 * Crawl coverage counts the `page_views` arrival rows the SSR gateway writes.
 * Production runs native Workers Cache (AECI-1443), and the gateway still writes
 * the row on a HIT (AECI-1297). Three changes would make this count silently
 * under-report, which would look like a crawl collapse and would not be one:
 * moving the arrival write into `Renderer`, putting any cache or redirect in
 * front of the gateway, or narrowing `recordGatewayArrival`'s filter (GET,
 * status 200, `text/html`, cacheable route). A crawl that got a 404, a 5xx or a
 * redirect is not recorded, so it is not counted. That is deliberate.
 *
 * (`ADMIN_PANEL_SPEC.md` §5.24.4. Every response that reports coverage carries
 * the `crawl_coverage_is_gateway_arrivals` note for the same reason.)
 *
 * Returns the newest verified fetch per path and engine, from
 * `CONCRETE_PATH_SINCE` up to `toIso`. One grouped read; the caller joins it to
 * the catalog in memory.
 */
export async function readLastFetchByPath(db: Db, toIso: string): Promise<LastFetchByPath> {
  const rows = await crawledPathsQuery(db, toIso);

  const out: LastFetchByPath = { google: new Map(), bing: new Map() };
  for (const r of rows) {
    const engine = engineOf(r.bot);
    if (!engine || !r.path) continue;
    const path = normalizePath(r.path);
    const map = out[engine];
    const prior = map.get(path);
    if (prior === undefined || r.last > prior) map.set(path, r.last);
  }
  return out;
}

/**
 * The grouped read behind {@link readLastFetchByPath}, exported so a spec can
 * `EXPLAIN QUERY PLAN` it. It is served by `page_views_crawl_path_idx` (migration
 * `0134`), a covering scan of Googlebot and Bingbot rows with a concrete path
 * rather than a range scan of every bot row.
 *
 * `INDEXED BY` pins the index. Left to itself, SQLite picks `page_views_bot_idx`,
 * because `(is_bot, created_at)` matches an equality and a range while the
 * partial index matches only `bot_name IN (…)`. It cannot know that `is_bot = 1`
 * is most of the table. The pin is also the tripwire: SQLite refuses the
 * statement ("no query solution") if the index is missing or if the WHERE stops
 * implying its WHERE, so a regression fails loudly instead of scanning. The WHERE
 * therefore carries the index's own two terms, `is_bot = 1` and
 * `concrete_path IS NOT NULL`, verbatim.
 */
export function crawledPathsQuery(db: Db, toIso: string) {
  return (
    db
      // `sql` fields, not column refs: Drizzle refuses a column of a table it does
      // not see in FROM, and `INDEXED BY` makes FROM a raw fragment.
      .select({
        path: sql<string | null>`${pageViews.concretePath}`,
        bot: sql<string | null>`${pageViews.botName}`,
        last: sql<string>`max(${pageViews.createdAt})`,
      })
      .from(sql`${pageViews} INDEXED BY page_views_crawl_path_idx`)
      .where(and(searchCrawlerWhere(CONCRETE_PATH_SINCE, toIso), isNotNull(pageViews.concretePath)))
      .groupBy(pageViews.botName, pageViews.concretePath)
  );
}

/** The newest fetch of a catalog URL. A pair URL also matches its other
 *  orientation, which 301s to it but is still a fetch of the pair. */
function lastFetchOf(url: CatalogUrl, byPath: Map<string, string>): string | null {
  const direct = byPath.get(url.path) ?? null;
  if (!url.pairSlugs) return direct;
  const [context, other] = url.pairSlugs;
  const reverse = byPath.get(`/products/${other}/integrations/${context}`) ?? null;
  if (direct === null) return reverse;
  if (reverse === null) return direct;
  return direct > reverse ? direct : reverse;
}

// ─── The lanes ───────────────────────────────────────────────────────────────

/** One URL in a lane, before the public origin is applied. */
export interface SeoLaneEntry {
  path: string;
  pageType: string;
  publishedAt: string | null;
  /** Newest verified fetch by the lane's engine since `CONCRETE_PATH_SINCE`. Null
   *  on the pair list, which is not matched against crawls. */
  lastFetchAt: string | null;
}

export interface SeoLaneSet {
  window: CrawlWindow;
  catalogUrls: number;
  /** Catalog URLs with a verified fetch inside the window, per engine. */
  crawled: Record<SeoEngine, number>;
  /** Panel 1's "Not crawled" lanes, sorted. Pages inside the grace period are
   *  left out, so this is not `catalogUrls − crawled`. */
  uncrawled: Record<SeoEngine, SeoLaneEntry[]>;
  /** Catalog pair URLs where neither endpoint product has a review, sorted. Only
   *  its length is used: the `seo.pairs_without_reviews` snapshot key, shown on
   *  Panel 2. Chris ruled on 2026-11-24 that it is a count, not a Panel 1 lane,
   *  because a row clears only when a reviewer writes a review. */
  pairsWithoutReviews: SeoLaneEntry[];
}

/**
 * Oldest publish anchor first, then null anchors, then path ascending. Every term
 * is a timestamp or a URL, so all compare BINARY (`API_CONTRACTS.md` §3.2). The
 * path decides the URL order because every URL shares one origin.
 */
export function compareLaneEntries(a: SeoLaneEntry, b: SeoLaneEntry): number {
  if (a.publishedAt !== b.publishedAt) {
    if (a.publishedAt === null) return 1;
    if (b.publishedAt === null) return -1;
    return a.publishedAt < b.publishedAt ? -1 : 1;
  }
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

/**
 * Every D1-derived lane, ending at `to`. The API passes the request time, so a
 * page crawled an hour ago leaves the list now. The snapshot passes the end of
 * the day it files under.
 */
export async function computeSeoLanes(db: Db, to: Date): Promise<SeoLaneSet> {
  const window = crawlWindow(to);
  const [catalog, lastFetch] = await Promise.all([
    listCatalogUrls(db),
    readLastFetchByPath(db, window.to),
  ]);
  const graceCutoff = new Date(to.getTime() - SEO_UNCRAWLED_GRACE_DAYS * DAY_MS).toISOString();

  const crawled: Record<SeoEngine, number> = { google: 0, bing: 0 };
  const uncrawled: Record<SeoEngine, SeoLaneEntry[]> = { google: [], bing: [] };
  const pairsWithoutReviews: SeoLaneEntry[] = [];

  for (const url of catalog) {
    const overdue = url.publishedAt === null || url.publishedAt < graceCutoff;
    for (const engine of ENGINES) {
      const last = lastFetchOf(url, lastFetch[engine]);
      const inWindow = last !== null && last >= window.from;
      if (inWindow) crawled[engine] += 1;
      else if (overdue) {
        uncrawled[engine].push({
          path: url.path,
          pageType: url.pageType,
          publishedAt: url.publishedAt,
          lastFetchAt: last,
        });
      }
    }
    if (url.pageType === 'pair' && url.pairHasReviews === false) {
      pairsWithoutReviews.push({
        path: url.path,
        pageType: url.pageType,
        publishedAt: url.publishedAt,
        lastFetchAt: null,
      });
    }
  }

  for (const engine of ENGINES) uncrawled[engine].sort(compareLaneEntries);
  pairsWithoutReviews.sort(compareLaneEntries);

  return { window, catalogUrls: catalog.length, crawled, uncrawled, pairsWithoutReviews };
}

export interface ReindexLane {
  count: number;
  /** Rows with `priority <= 2`. Read in the same statement as the age, so the
   *  two cannot disagree. */
  tier12Count: number;
  /** Days since the oldest tier-1 or tier-2 row was queued, one decimal, or null
   *  when no such row exists. */
  oldestTier12AgeDays: number | null;
}

/** The re-index lane: a count and an age, never a URL list (Chris, 2026-11-24). */
export async function readReindexLane(db: Db, now: Date): Promise<ReindexLane> {
  const [totals, oldest] = await db.batch([
    db.select({ value: count() }).from(gscRecrawlQueue),
    db
      .select({ tier12: count(), queuedAt: min(gscRecrawlQueue.queuedAt) })
      .from(gscRecrawlQueue)
      .where(lte(gscRecrawlQueue.priority, 2)),
  ]);
  const queuedAt = oldest[0]?.queuedAt ?? null;
  return {
    count: totals[0]?.value ?? 0,
    tier12Count: oldest[0]?.tier12 ?? 0,
    oldestTier12AgeDays: queuedAt === null ? null : ageInDays(queuedAt, now),
  };
}

/** Non-negative days between `iso` and `now`, one decimal. */
function ageInDays(iso: string, now: Date): number {
  const days = Math.max(0, (now.getTime() - Date.parse(iso)) / DAY_MS);
  return Math.round(days * 10) / 10;
}

/** Whole days since `iso`, or null. */
export function wholeDaysSince(iso: string | null, now: Date): number | null {
  if (iso === null) return null;
  return Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / DAY_MS));
}

// ─── Notes ───────────────────────────────────────────────────────────────────

/**
 * The notes on any read that reports crawl coverage. The gateway caveat is
 * unconditional. The three date caveats fire only when the window reaches back
 * past their date.
 */
export function crawlNotes(opts: {
  clampedFrom?: string;
  reachesUnverified: boolean;
  reachesUnsplit: boolean;
}): AdminNote[] {
  const notes: AdminNote[] = [
    note(
      'crawl_coverage_is_gateway_arrivals',
      'Crawl coverage counts the page views the SSR gateway records. A crawl that got a 404, a 5xx or a redirect is not counted.',
    ),
  ];
  if (opts.reachesUnsplit) {
    notes.push(
      INSPECTION_TOOL_SPLIT_SINCE === null
        ? note(
            'crawler_label_includes_inspection_tool',
            'Rows written before Google-InspectionTool got its own label count it as Googlebot, so a live test in URL Inspection reads as a crawl.',
          )
        : note(
            'crawler_label_includes_inspection_tool',
            `Rows before ${INSPECTION_TOOL_SPLIT_SINCE} count Google-InspectionTool as Googlebot, so a live test in URL Inspection reads as a crawl.`,
            { since: INSPECTION_TOOL_SPLIT_SINCE },
          ),
    );
  }
  if (opts.clampedFrom !== undefined) {
    notes.push(
      note(
        'crawl_window_clamped',
        `The crawl window starts at ${opts.clampedFrom}, the first row that records a concrete path.`,
        { from: opts.clampedFrom },
      ),
    );
  }
  if (opts.reachesUnverified) {
    notes.push(
      note(
        'crawler_label_unverified',
        `Rows before ${EDGE_VERIFIED_SINCE} carry no Cloudflare bot verification, so they count on the user agent alone.`,
        { since: EDGE_VERIFIED_SINCE },
      ),
    );
  }
  return notes;
}

// ─── Panel 2: the cohort and the self-reported requests ──────────────────────

/** `strftime` form that matches `toISOString()`, so the bound compares as text. */
const ISO_FMT = '%Y-%m-%dT%H:%M:%fZ';

const PRODUCT_ANCHOR = sql<string>`coalesce(${products.promotedAt}, ${products.createdAt})`;

/**
 * Which products and vendors published since `fromIso` had a verified fetch, per
 * engine, within `SEO_CRAWL_COHORT_DAYS` of their anchor and before `nowIso`.
 * Keys are `${engine}:${id}`.
 *
 * Matched on `page_views.product_id` or `vendor_id`, not on path, so a slug change
 * does not lose the fetch (§5.24.6). Narrowed to the detail route pattern too
 * (§5.24.14 item 8): ingest sets `product_id` from an explicit `entity_type` as
 * well as from a detail-page arrival, so the pattern keeps a fetch of any other
 * page about the product out of the count.
 */
export async function readCohortFetches(
  db: Db,
  fromIso: string,
  nowIso: string,
): Promise<Set<string>> {
  const offset = `+${SEO_CRAWL_COHORT_DAYS} days`;
  const [productHits, vendorHits] = await db.batch([
    db
      .select({ id: pageViews.productId, bot: pageViews.botName })
      .from(pageViews)
      .innerJoin(products, eq(products.id, pageViews.productId))
      .where(
        and(
          searchCrawlerWhere(fromIso, nowIso),
          eq(pageViews.path, '/products/:slug'),
          gte(PRODUCT_ANCHOR, fromIso),
          gte(pageViews.createdAt, PRODUCT_ANCHOR),
          lt(pageViews.createdAt, sql`strftime(${ISO_FMT}, ${PRODUCT_ANCHOR}, ${offset})`),
        ),
      )
      .groupBy(pageViews.productId, pageViews.botName),
    db
      .select({ id: pageViews.vendorId, bot: pageViews.botName })
      .from(pageViews)
      .innerJoin(vendors, eq(vendors.id, pageViews.vendorId))
      .where(
        and(
          searchCrawlerWhere(fromIso, nowIso),
          eq(pageViews.path, '/vendors/:slug'),
          gte(vendors.createdAt, fromIso),
          gte(pageViews.createdAt, vendors.createdAt),
          lt(pageViews.createdAt, sql`strftime(${ISO_FMT}, ${vendors.createdAt}, ${offset})`),
        ),
      )
      .groupBy(pageViews.vendorId, pageViews.botName),
  ]);
  const hits = new Set<string>();
  for (const r of [...productHits, ...vendorHits]) {
    const engine = engineOf(r.bot);
    if (engine && r.id) hits.add(`${engine}:${r.id}`);
  }
  return hits;
}

/** `gsc_manual` `requested` rows per UTC day in `[fromIso, toIso)`. */
export async function readSelfReportedRequestsByDay(
  db: Db,
  fromIso: string,
  toIso: string,
): Promise<Map<string, number>> {
  const day = sql<string>`substr(${recrawlSubmissions.submittedAt}, 1, 10)`;
  const rows = await db
    .select({ day, n: count() })
    .from(recrawlSubmissions)
    .where(
      and(
        eq(recrawlSubmissions.channel, 'gsc_manual'),
        eq(recrawlSubmissions.outcome, 'requested'),
        gte(recrawlSubmissions.submittedAt, fromIso),
        lt(recrawlSubmissions.submittedAt, toIso),
      ),
    )
    .groupBy(day);
  return new Map(rows.map((r) => [r.day, r.n]));
}
