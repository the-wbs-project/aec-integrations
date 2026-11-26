/**
 * AECI-818 — the search console derivations (`ADMIN_PANEL_SPEC.md` §5.24),
 * against the real migrated schema.
 *
 * The invariants pinned here:
 *
 *   1. **Only a verified fetch by the engine's own label counts** (§5.24.4). A
 *      spoofed user agent after edge verification began, an ASN verdict such as
 *      `Datacenter (Google)`, and a NULL `concrete_path` are not crawls.
 *   2. **A pre-AECI-585 row can never make a page read as uncrawled.** The window
 *      is clamped to `CONCRETE_PATH_SINCE` and the clamp is reported.
 *   3. **The grace period keeps a new page off the list**, so the uncrawled lane
 *      is not `catalog − crawled`.
 *   4. **A pair URL matches its other orientation.**
 *   5. **Order is oldest anchor first, nulls last, then URL, BINARY.**
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  gscRecrawlQueue,
  integrations,
  pageViews,
  products,
  recrawlSubmissions,
  taxonomyCategories,
  vendors,
} from '../db/schema';
import { type TestDb, makeTestDb } from '../test/d1';
import {
  CONCRETE_PATH_SINCE,
  EDGE_VERIFIED_SINCE,
  compareLaneEntries,
  computeSeoLanes,
  crawlNotes,
  crawlWindow,
  readCohortFetches,
  readReindexLane,
  readSelfReportedRequestsByDay,
  toCrawlAdminWindow,
} from './seo-queue';

const NOW = new Date('2026-11-24T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const VERIFIED = 'Search Engine Crawler';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

type Fetch = {
  concretePath: string | null;
  botName?: string;
  verified?: boolean;
  createdAt: string;
  path?: string;
  productId?: string;
  vendorId?: string;
};

const fetches = (rows: readonly Fetch[]) =>
  t.db.insert(pageViews).values(
    rows.map((r) => ({
      path: r.path ?? r.concretePath ?? '/unknown',
      concretePath: r.concretePath,
      isBot: true,
      botName: r.botName ?? 'Googlebot',
      cfVerifiedBotCategory: r.verified === false ? null : VERIFIED,
      createdAt: r.createdAt,
      productId: r.productId ?? null,
      vendorId: r.vendorId ?? null,
    })),
  );

describe('crawlWindow', () => {
  it('is SEO_CRAWL_LOOKBACK_DAYS ending at `to`, unclamped today', () => {
    const w = crawlWindow(NOW);
    expect(w).toEqual({
      from: daysAgo(28),
      to: NOW.toISOString(),
      clamped: false,
      reachesUnverified: false,
    });
    expect(toCrawlAdminWindow(w).days).toBe(28);
  });

  it('clamps to CONCRETE_PATH_SINCE and flags the unverified reach', () => {
    const w = crawlWindow(new Date('2026-09-01T00:00:00.000Z'));
    expect(w.from).toBe(CONCRETE_PATH_SINCE);
    expect(w.clamped).toBe(true);
    expect(w.reachesUnverified).toBe(true);
    expect(toCrawlAdminWindow(w).days).toBe(14);
  });
});

describe('crawlNotes', () => {
  it('always carries the two standing caveats', () => {
    expect(crawlNotes({ reachesUnverified: false }).map((n) => n.code)).toEqual([
      'crawl_coverage_is_gateway_arrivals',
      'crawler_label_includes_inspection_tool',
    ]);
  });

  it('adds the clamp and the unverified notes with their dates', () => {
    const notes = crawlNotes({ clampedFrom: CONCRETE_PATH_SINCE, reachesUnverified: true });
    expect(notes.find((n) => n.code === 'crawl_window_clamped')?.params).toEqual({
      from: CONCRETE_PATH_SINCE,
    });
    const unverified = notes.find((n) => n.code === 'crawler_label_unverified');
    expect(unverified?.severity).toBe('warn');
    expect(unverified?.params).toEqual({ since: EDGE_VERIFIED_SINCE });
  });
});

describe('computeSeoLanes', () => {
  it('reads an empty catalog as zero everywhere', async () => {
    const lanes = await computeSeoLanes(t.db, NOW);
    expect(lanes.catalogUrls).toBe(0);
    expect(lanes.crawled).toEqual({ google: 0, bing: 0 });
    expect(lanes.uncrawled).toEqual({ google: [], bing: [] });
    expect(lanes.pairsWithoutReviews).toEqual([]);
  });

  it('counts only a verified fetch by the engine label inside the window', async () => {
    await t.db.insert(products).values([
      { id: 'p1', slug: 'crawled', name: 'Crawled', createdAt: daysAgo(60) },
      { id: 'p2', slug: 'spoofed', name: 'Spoofed', createdAt: daysAgo(60) },
      { id: 'p3', slug: 'asn', name: 'Asn', createdAt: daysAgo(60) },
      { id: 'p4', slug: 'nopath', name: 'NoPath', createdAt: daysAgo(60) },
      { id: 'p5', slug: 'stale', name: 'Stale', createdAt: daysAgo(60) },
    ]);
    await fetches([
      { concretePath: '/products/crawled', createdAt: daysAgo(3) },
      // A Googlebot user agent Cloudflare did not verify, after verification began.
      { concretePath: '/products/spoofed', verified: false, createdAt: daysAgo(3) },
      // An ASN verdict, not a search crawler.
      { concretePath: '/products/asn', botName: 'Datacenter (Google)', createdAt: daysAgo(3) },
      // No concrete path: never matches any URL.
      { concretePath: null, path: '/products/:slug', createdAt: daysAgo(3) },
      // A verified fetch, but before the 28-day window: a stale crawl.
      { concretePath: '/products/stale', createdAt: daysAgo(40) },
    ]);

    const lanes = await computeSeoLanes(t.db, NOW);
    expect(lanes.catalogUrls).toBe(5);
    expect(lanes.crawled).toEqual({ google: 1, bing: 0 });
    const google = lanes.uncrawled.google.map((e) => [e.path, e.lastFetchAt]);
    expect(google).toEqual(
      expect.arrayContaining([
        ['/products/spoofed', null],
        ['/products/asn', null],
        ['/products/nopath', null],
        ['/products/stale', daysAgo(40)],
      ]),
    );
    expect(google).toHaveLength(4);
    // Bing never fetched anything, so every page is in its lane.
    expect(lanes.uncrawled.bing).toHaveLength(5);
  });

  it('counts an unverified row written before edge verification began', async () => {
    // Inside a window that reaches back past EDGE_VERIFIED_SINCE, the UA label
    // alone counts for the earlier rows (§5.24.4).
    const to = new Date('2026-10-20T00:00:00.000Z');
    await t.db.insert(products).values({
      id: 'p1',
      slug: 'early',
      name: 'Early',
      createdAt: '2026-08-01T00:00:00.000Z',
    });
    await fetches([
      { concretePath: '/products/early', verified: false, createdAt: '2026-10-01T00:00:00.000Z' },
    ]);
    const lanes = await computeSeoLanes(t.db, to);
    expect(lanes.window.reachesUnverified).toBe(true);
    expect(lanes.crawled.google).toBe(1);
  });

  it('pins EDGE_VERIFIED_SINCE to the production reading, to the millisecond', async () => {
    // Read from production on 2026-11-24: the first `page_views` row with a
    // `cf_verified_bot_category`. An unverified row counts only before it.
    expect(EDGE_VERIFIED_SINCE).toBe('2026-10-13T08:02:33.500Z');
    const to = new Date('2026-10-20T00:00:00.000Z');
    await t.db.insert(products).values([
      { id: 'p1', slug: 'before', name: 'Before', createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'p2', slug: 'at', name: 'At', createdAt: '2026-08-01T00:00:00.000Z' },
    ]);
    await fetches([
      { concretePath: '/products/before', verified: false, createdAt: '2026-10-13T08:02:33.499Z' },
      { concretePath: '/products/at', verified: false, createdAt: EDGE_VERIFIED_SINCE },
    ]);
    const lanes = await computeSeoLanes(t.db, to);
    expect(lanes.crawled.google).toBe(1);
    expect(lanes.uncrawled.google.map((e) => e.path)).toEqual(['/products/at']);
  });

  it('never reads a pre-AECI-585 row as a miss: the window is clamped instead', async () => {
    const to = new Date('2026-09-01T00:00:00.000Z');
    await t.db.insert(products).values({
      id: 'p1',
      slug: 'old',
      name: 'Old',
      createdAt: '2026-06-01T00:00:00.000Z',
    });
    // The pre-AECI-585 cohort: a NULL concrete_path before CONCRETE_PATH_SINCE.
    await fetches([
      { concretePath: null, path: '/products/:slug', createdAt: '2026-08-10T00:00:00.000Z' },
      { concretePath: '/products/old', createdAt: '2026-08-20T00:00:00.000Z' },
    ]);
    const lanes = await computeSeoLanes(t.db, to);
    expect(lanes.window.clamped).toBe(true);
    expect(lanes.window.from).toBe(CONCRETE_PATH_SINCE);
    expect(lanes.crawled.google).toBe(1);
    expect(lanes.uncrawled.google).toEqual([]);
  });

  it('keeps a page inside the grace period off the uncrawled lane', async () => {
    await t.db.insert(products).values([
      { id: 'p1', slug: 'new', name: 'New', createdAt: daysAgo(2) },
      { id: 'p2', slug: 'late', name: 'Late', createdAt: daysAgo(8) },
    ]);
    const lanes = await computeSeoLanes(t.db, NOW);
    expect(lanes.catalogUrls).toBe(2);
    expect(lanes.crawled.google).toBe(0);
    expect(lanes.uncrawled.google.map((e) => e.path)).toEqual(['/products/late']);
  });

  it('anchors a product on promoted_at before created_at', async () => {
    await t.db.insert(products).values({
      id: 'p1',
      slug: 'repromoted',
      name: 'Repromoted',
      createdAt: daysAgo(90),
      promotedAt: daysAgo(2),
    });
    const lanes = await computeSeoLanes(t.db, NOW);
    expect(lanes.uncrawled.google).toEqual([]);
  });

  it('matches a pair fetch in either orientation', async () => {
    await t.db.insert(products).values([
      { id: 'pa', slug: 'alpha', name: 'Alpha', createdAt: daysAgo(60) },
      { id: 'pb', slug: 'beta', name: 'Beta', createdAt: daysAgo(60) },
    ]);
    await t.db
      .insert(integrations)
      .values({ id: 'i1', sourceProductId: 'pa', targetProductId: 'pb', createdAt: daysAgo(30) });
    // The non-canonical orientation, which 301s to /products/alpha/integrations/beta.
    await fetches([{ concretePath: '/products/beta/integrations/alpha', createdAt: daysAgo(1) }]);

    const lanes = await computeSeoLanes(t.db, NOW);
    expect(lanes.uncrawled.google.map((e) => e.path)).not.toContain(
      '/products/alpha/integrations/beta',
    );
    expect(lanes.crawled.google).toBe(1);
  });

  it('lists a pair only while neither endpoint has a review', async () => {
    await t.db.insert(products).values([
      { id: 'pa', slug: 'alpha', name: 'Alpha', createdAt: daysAgo(60) },
      { id: 'pb', slug: 'beta', name: 'Beta', createdAt: daysAgo(60) },
      { id: 'pc', slug: 'gamma', name: 'Gamma', createdAt: daysAgo(60), reviewCount: 2 },
    ]);
    await t.db.insert(integrations).values([
      { id: 'i1', sourceProductId: 'pa', targetProductId: 'pb', createdAt: daysAgo(30) },
      { id: 'i2', sourceProductId: 'pa', targetProductId: 'pc', createdAt: daysAgo(20) },
    ]);
    const lanes = await computeSeoLanes(t.db, NOW);
    expect(lanes.pairsWithoutReviews).toEqual([
      {
        path: '/products/alpha/integrations/beta',
        pageType: 'pair',
        publishedAt: daysAgo(30),
        lastFetchAt: null,
      },
    ]);
  });

  it('orders oldest anchor first, null anchors last, then URL', async () => {
    await t.db.insert(vendors).values({
      id: 'v1',
      slug: 'acme',
      companyName: 'Acme',
      createdAt: daysAgo(50),
    });
    await t.db.insert(products).values([
      { id: 'p1', slug: 'zeta', name: 'Zeta', createdAt: daysAgo(50) },
      { id: 'p2', slug: 'Beta', name: 'Beta', createdAt: daysAgo(80) },
    ]);
    await t.db.insert(taxonomyCategories).values({ id: 'c1', slug: 'bim', name: 'BIM' });

    const lanes = await computeSeoLanes(t.db, NOW);
    expect(lanes.uncrawled.google.map((e) => e.path)).toEqual([
      '/products/Beta',
      // Equal anchors: URL ascending, BINARY.
      '/products/zeta',
      '/vendors/acme',
      '/categories/bim',
    ]);
  });
});

describe('compareLaneEntries', () => {
  it('compares BINARY, so case never reorders by accident of locale', () => {
    const e = (path: string) => ({
      path,
      pageType: 'product',
      publishedAt: null,
      lastFetchAt: null,
    });
    expect([e('/b'), e('/B'), e('/a')].sort(compareLaneEntries).map((x) => x.path)).toEqual([
      '/B',
      '/a',
      '/b',
    ]);
  });
});

describe('readReindexLane', () => {
  it('reads no tier-1 or tier-2 row as a null age, not zero', async () => {
    await t.db.insert(gscRecrawlQueue).values({
      url: 'https://x.test/a',
      priority: 3,
      reason: 'product.updated',
      source: 'promote',
      queuedAt: daysAgo(10),
    });
    expect(await readReindexLane(t.db, NOW)).toEqual({
      count: 1,
      tier12Count: 0,
      oldestTier12AgeDays: null,
    });
  });

  it('ages the oldest tier-1 or tier-2 row, one decimal', async () => {
    await t.db.insert(gscRecrawlQueue).values([
      {
        url: 'https://x.test/a',
        priority: 1,
        reason: 'r',
        source: 'promote',
        queuedAt: daysAgo(3.2),
      },
      {
        url: 'https://x.test/b',
        priority: 2,
        reason: 'r',
        source: 'promote',
        queuedAt: daysAgo(1),
      },
      {
        url: 'https://x.test/c',
        priority: 4,
        reason: 'r',
        source: 'promote',
        queuedAt: daysAgo(30),
      },
    ]);
    expect(await readReindexLane(t.db, NOW)).toEqual({
      count: 3,
      tier12Count: 2,
      oldestTier12AgeDays: 3.2,
    });
  });
});

describe('readCohortFetches', () => {
  it('matches on the entity id inside the cohort window, on the detail route only', async () => {
    await t.db.insert(products).values([
      { id: 'p1', slug: 'one', name: 'One', createdAt: daysAgo(20) },
      { id: 'p2', slug: 'two', name: 'Two', createdAt: daysAgo(20) },
      { id: 'p3', slug: 'three', name: 'Three', createdAt: daysAgo(20) },
    ]);
    await t.db.insert(vendors).values({
      id: 'v1',
      slug: 'acme',
      companyName: 'Acme',
      createdAt: daysAgo(20),
    });
    await fetches([
      // Inside 7 days of the anchor, on the detail route.
      {
        concretePath: '/products/one-renamed',
        path: '/products/:slug',
        productId: 'p1',
        createdAt: daysAgo(18),
      },
      // Eight days after the anchor: outside the cohort window.
      {
        concretePath: '/products/two',
        path: '/products/:slug',
        productId: 'p2',
        createdAt: daysAgo(12),
      },
      // Inside the window but on another route about the product.
      {
        concretePath: '/products/three/review',
        path: '/products/three/review',
        productId: 'p3',
        createdAt: daysAgo(19),
      },
      {
        concretePath: '/vendors/acme',
        path: '/vendors/:slug',
        vendorId: 'v1',
        botName: 'Bingbot',
        createdAt: daysAgo(19),
      },
    ]);
    const hits = await readCohortFetches(t.db, daysAgo(30), NOW.toISOString());
    expect([...hits].sort()).toEqual(['bing:v1', 'google:p1']);
  });
});

describe('readSelfReportedRequestsByDay', () => {
  it('counts only gsc_manual requested rows, per UTC day', async () => {
    const row = (channel: string, outcome: string, submittedAt: string) => ({
      url: 'https://x.test/a',
      channel,
      outcome,
      batchId: 'b',
      submittedAt,
    });
    await t.db
      .insert(recrawlSubmissions)
      .values([
        row('gsc_manual', 'requested', '2026-11-17T01:00:00.000Z'),
        row('gsc_manual', 'requested', '2026-11-17T09:00:00.000Z'),
        row('indexnow', 'accepted', '2026-11-17T09:00:00.000Z'),
        row('gsc_manual', 'requested', '2026-11-18T09:00:00.000Z'),
      ]);
    const byDay = await readSelfReportedRequestsByDay(
      t.db,
      '2026-11-17T00:00:00.000Z',
      '2026-11-18T00:00:00.000Z',
    );
    expect([...byDay]).toEqual([['2026-11-17', 2]]);
  });
});
