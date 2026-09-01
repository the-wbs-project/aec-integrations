/**
 * Home-stats compute core (AECI-178 / Phase 4.3 — the §10 "Stats Pipeline"
 * producer) on the Drizzle/D1 path (ADR 0016 / AECI-253).
 *
 * The daily scheduled job (`../scheduled.ts`, ADR 0013 cron→queue→consumer)
 * recomputes the eleven `home.*` `stats_cache` keys and upserts each as its own
 * row. A successful `POST /api/promote` also fires `runHomeStats` post-commit
 * (`routes/promote.ts`, AECI-305) so the home banner reflects a promotion at once
 * instead of lagging until the next cron. The read endpoint (4.4) and home UI
 * (4.8) consume these via `@aeci/shared` — this module is the only writer.
 *
 * Contract (docs/STAGE_1_SPEC.md §10, §4.1; types/schemas from AECI-176):
 *   - Eleven keys: total_integrations, integrations_added_30d, total_products,
 *     total_vendors, total_reviews + total_contributing_firms (the AECI-271 +
 *     AECI-284 credibility-strip coverage counts), most_integrated_product,
 *     most_active_category, recent_integrations (≤10), trending_products (top 5
 *     by page_views, last 7d, with a `TRENDING_MIN_VIEWS` floor — AECI-280),
 *     recently_added_products (≤10, last 30d).
 *   - **Every value is validated against `statsCacheValueSchemas[key]` before the
 *     write** — the job and the read endpoint share one source of truth, so the
 *     cache can never hold a shape the reader rejects.
 *   - Idempotent (upsert per key); **partial failure of one key must not abort
 *     the others** — each key computes/validates/writes inside its own try/catch
 *     and `runHomeStats` never throws (the crash surface is the caller).
 *   - Empty `page_views` → empty `trending_products` (`[]`), never a throw.
 *
 * No promotion filter on products/vendors/integrations — mirrors `GET /api/products`
 * / `GET /api/integrations`, which apply none either (the DB only holds promoted
 * rows; the promote pipeline is the gate). Counting here the same way keeps the
 * home stats consistent with the list endpoints. Reviews are the one exception:
 * `total_reviews` counts only `approved` rows (the canonical `COUNTED_REVIEW_STATUS`),
 * matching the public review APIs and `products.review_count`.
 *
 * Deferred (NOT computed here): `category_counts` / `audience_counts` /
 * `phase_counts`. Per the §10 Phase 4 reconciliation the home "Browse by …" grids
 * read the live taxonomy endpoints (`GET /api/taxonomy`, `/api/categories`, …),
 * which already return `product_count`, rather than this cache. They remain
 * enumerated `stats_cache` keys in `@aeci/shared` for the future, just unwritten.
 */

import {
  statsCacheValueSchemas,
  type IntegrationListItem,
  type MostActiveCategory,
  type MostIntegratedProduct,
  type ProductListItem,
  type StatsCacheKey,
} from '@aeci/shared';
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  ne,
  sql,
} from 'drizzle-orm';

import type { Db } from '../db/client';
import { integrations, pageViews, products, reviews, statsCache, vendors } from '../db/schema';
import { HUMAN, NOT_INTERNAL } from './page-view-predicates';
import { COUNTED_REVIEW_STATUS } from './recompute-counts';
import {
  integrationListConfig,
  productListConfig,
  toIntegrationListItem,
  toProductListItem,
  type RawProductListRow,
} from './drizzle-helpers';

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO-8601 cutoff `n` days before `now`. `*_at` columns are ISO text, which sorts
 *  lexically = chronologically, so `gte(col, cutoff)` is the "last n days" window. */
function sinceIso(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

// ---------------------------------------------------------------------------
// Trending tunables (AECI-280 / Phase 8.2). Extracted from inline literals so the
// window / top-N / floor are one documented surface, mirrored in the
// POST_LAUNCH_MONITORING §3 launch-tunable table. The 2026-07-12 prod pull
// validated the window + top-N (7d had 646 product-page views across 124 products;
// the top-5 sat at 17/17/17/12/12 — clear, well-separated signal). Revisit against
// ~30d of traffic and once the PostHog join lands (AECI-239) per the follow-up.
// ---------------------------------------------------------------------------

/** "last N days" window for the trending computation (spec §10). */
const TRENDING_WINDOW_DAYS = 7;

/** How many trending products the card shows (spec §10; mirrored by the
 *  `home.trending_products` Zod `.max(5)` cap in `@aeci/shared`). */
const TRENDING_LIMIT = 5;

/** A product must clear this many page-views in the window to be called "trending".
 *  A low honesty floor that rejects 1–2-view noise — the only quality guard on
 *  trending, because the CF Pro plan yields no bot score so `page_views` has no
 *  ingest-time bot filter (`PAGE_VIEWS_MIN_BOT_SCORE` is inert in prod). Inert at
 *  healthy traffic (the top-5 clear it many-fold); it only bites in low-traffic
 *  windows, where `computeTrendingProducts` returns `[]` and the home UI falls back
 *  to recently-added products. Raising it never exceeds `TRENDING_LIMIT`, so the
 *  `.max(5)` schema cap is unaffected. */
const TRENDING_MIN_VIEWS = 3;

// ---------------------------------------------------------------------------
// Per-key compute functions (pure; exported for unit tests). A function returns
// `null` to signal "skip this key" (e.g. an empty DB has no most-integrated
// product) — no `home.*` value schema accepts `null`, so the sentinel is
// unambiguous. Scalar/array keys always return a value (a number / `[]`).
// ---------------------------------------------------------------------------

export async function computeTotalIntegrations(db: Db): Promise<number> {
  const [row] = await db.select({ value: count() }).from(integrations);
  return row?.value ?? 0;
}

export async function computeIntegrationsAdded30d(db: Db, now: Date): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(integrations)
    .where(gte(integrations.createdAt, sinceIso(now, 30)));
  return row?.value ?? 0;
}

/** Coverage counts for the home credibility strip (AECI-271). Products and
 *  vendors apply no filter — same convention as `computeTotalIntegrations` and
 *  the public list endpoints (the DB only holds promoted rows; the promote
 *  pipeline is the gate). */
export async function computeTotalProducts(db: Db): Promise<number> {
  const [row] = await db.select({ value: count() }).from(products);
  return row?.value ?? 0;
}

export async function computeTotalVendors(db: Db): Promise<number> {
  const [row] = await db.select({ value: count() }).from(vendors);
  return row?.value ?? 0;
}

/** Unlike products/vendors/integrations, reviews ARE filtered: only `approved`
 *  reviews count (the canonical `COUNTED_REVIEW_STATUS`), matching the public
 *  review APIs and the denormalized `products.review_count`. */
export async function computeTotalReviews(db: Db): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(reviews)
    .where(eq(reviews.status, COUNTED_REVIEW_STATUS));
  return row?.value ?? 0;
}

/** Distinct contributing firms among **approved** reviews (AECI-284). The
 *  free-text `reviewer_firm` is normalized `lower(trim(...))` so case/whitespace
 *  variants collapse to one firm; blank/whitespace-only firms are excluded by the
 *  `trim(...) <> ''` filter, and null firms by `isNotNull` (and `COUNT(DISTINCT)`
 *  ignores nulls anyway). Like `total_reviews`, only `approved` rows count. Feeds
 *  the home credibility strip's suppressed-until-meaningful firms metric. */
export async function computeTotalContributingFirms(db: Db): Promise<number> {
  const [row] = await db
    .select({ value: countDistinct(sql`lower(trim(${reviews.reviewerFirm}))`) })
    .from(reviews)
    .where(
      and(
        eq(reviews.status, COUNTED_REVIEW_STATUS),
        isNotNull(reviews.reviewerFirm),
        ne(sql`trim(${reviews.reviewerFirm})`, ''),
      ),
    );
  return row?.value ?? 0;
}

export async function computeMostIntegratedProduct(db: Db): Promise<MostIntegratedProduct | null> {
  // Ordering is delegated to the DB: highest `integration_count` wins, name
  // ascending as the deterministic tiebreak.
  const row = await db.query.products.findFirst({
    columns: { id: true, name: true, slug: true, logoUrl: true, integrationCount: true },
    orderBy: [desc(products.integrationCount), asc(products.name)],
  });
  if (!row) return null;
  return {
    product: { id: row.id, name: row.name, slug: row.slug, logo_url: row.logoUrl },
    integration_count: row.integrationCount,
  };
}

type CategoryRefRow = { id: string; name: string; slug: string };

export async function computeMostActiveCategory(db: Db): Promise<MostActiveCategory | null> {
  // Both endpoints' category-id edges per integration (the source + target
  // products' category joins), hydrated via the relational query builder.
  const edges = await db.query.integrations.findMany({
    columns: { id: true },
    with: {
      sourceProduct: {
        columns: {},
        with: { productCategories: { columns: { categoryId: true } } },
      },
      targetProduct: {
        columns: {},
        with: { productCategories: { columns: { categoryId: true } } },
      },
    },
  });
  if (edges.length === 0) return null;

  // "Integrations in this category" = count of distinct integrations whose
  // source OR target product is in the category. Per integration we take the
  // set-union of both products' category ids so an integration internal to a
  // single category is counted once, not twice.
  const counts = new Map<string, number>();
  for (const edge of edges) {
    const ids = new Set<string>();
    for (const pc of edge.sourceProduct.productCategories) ids.add(pc.categoryId);
    for (const pc of edge.targetProduct.productCategories) ids.add(pc.categoryId);
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  const categories: CategoryRefRow[] = await db.query.taxonomyCategories.findMany({
    columns: { id: true, name: true, slug: true },
  });
  const byId = new Map<string, CategoryRefRow>(categories.map((c) => [c.id, c]));

  // Max count wins; alphabetical name tiebreak for determinism.
  let best: { ref: CategoryRefRow; count: number } | null = null;
  for (const [id, count] of counts) {
    const ref = byId.get(id);
    if (!ref) continue; // counted id with no taxonomy row (shouldn't happen) — skip
    if (
      best === null ||
      count > best.count ||
      (count === best.count && ref.name.localeCompare(best.ref.name) < 0)
    ) {
      best = { ref, count };
    }
  }
  if (best === null) return null;
  return {
    category: { id: best.ref.id, name: best.ref.name, slug: best.ref.slug },
    integration_count: best.count,
  };
}

export async function computeRecentIntegrations(db: Db): Promise<IntegrationListItem[]> {
  const rows = await db.query.integrations.findMany({
    ...integrationListConfig,
    orderBy: [desc(integrations.createdAt)],
    limit: 10,
  });
  return rows.map(toIntegrationListItem);
}

export async function computeTrendingProducts(db: Db, now: Date): Promise<ProductListItem[]> {
  // Top products by page-view volume in the last `TRENDING_WINDOW_DAYS`, ranked
  // `desc(count())` with `productId` ascending as a deterministic tiebreak. Null
  // `product_id` rows (non-product paths) are excluded, and the `HAVING` floor drops
  // any product below `TRENDING_MIN_VIEWS` so 1–2-view noise is never called
  // "trending" (AECI-280 / Phase 8.2). Fewer than `TRENDING_LIMIT` clearing the floor
  // → fewer shown; none clearing it → `[]`, and the home UI falls back to recently-added.
  //
  // `HUMAN` is the digest's own predicate (AECI-582), so the public card and the
  // operator's numbers rank the same population. Crawlers dominate raw page-view
  // volume — on the day this filter landed, 1,121 product views in the trailing
  // 7 days were only 74 human — so counting them ranked products by how hard they
  // were being scraped rather than by what people read.
  //
  // `NOT_INTERNAL` is imported for the same reason, and specifically for its
  // `is_operator` half (§13 D13). `ADMIN_PANEL_SPEC.md` D12 recorded this query as
  // immune to the `/admin/*` exclusion, correctly: an admin-path row carries no
  // `product_id`, so `isNotNull` already dropped it. That reasoning does NOT extend
  // to an operator SESSION, which lands on `/products/:slug` and carries the FK like
  // any other view. Without this the operator re-checking one product a few times
  // would rank it on the PUBLIC home page — `TRENDING_MIN_VIEWS` is 3, against a
  // human population of roughly 2,100 all-time views, so the floor is no protection.
  const groups = await db
    .select({ productId: pageViews.productId, value: count() })
    .from(pageViews)
    .where(
      and(
        gte(pageViews.createdAt, sinceIso(now, TRENDING_WINDOW_DAYS)),
        isNotNull(pageViews.productId),
        HUMAN,
        NOT_INTERNAL,
      ),
    )
    .groupBy(pageViews.productId)
    .having(sql`count(*) >= ${TRENDING_MIN_VIEWS}`)
    .orderBy(desc(count()), asc(pageViews.productId))
    .limit(TRENDING_LIMIT);
  const ids = groups.map((g) => g.productId).filter((id): id is string => id !== null);
  if (ids.length === 0) return []; // no product clears the floor — expected, not a failure
  const rows: RawProductListRow[] = await db.query.products.findMany({
    ...productListConfig,
    where: inArray(products.id, ids),
  });
  const byId = new Map<string, RawProductListRow>(rows.map((r) => [r.id, r]));
  // Reorder to the page-view ranking; drop any id whose product no longer exists.
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is RawProductListRow => r !== undefined)
    .map(toProductListItem);
}

export async function computeRecentlyAddedProducts(db: Db, now: Date): Promise<ProductListItem[]> {
  const rows: RawProductListRow[] = await db.query.products.findMany({
    ...productListConfig,
    where: gte(products.createdAt, sinceIso(now, 30)),
    orderBy: [desc(products.createdAt)],
    limit: 10,
  });
  return rows.map(toProductListItem);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** The `home.*` subset of `StatsCacheKey` this job writes (the `*_counts` keys
 *  are deferred — see the module header). */
const HOME_STAT_KEYS = [
  'home.total_integrations',
  'home.integrations_added_30d',
  'home.total_products',
  'home.total_vendors',
  'home.total_reviews',
  'home.total_contributing_firms',
  'home.most_integrated_product',
  'home.most_active_category',
  'home.recent_integrations',
  'home.trending_products',
  'home.recently_added_products',
] as const satisfies readonly StatsCacheKey[];

export type HomeStatsKey = (typeof HOME_STAT_KEYS)[number];

/** Returns the value to validate + cache, or `null` to skip the key. */
type StatCompute = (db: Db, now: Date) => Promise<unknown>;

/** One compute fn per key. Typed `Record<HomeStatsKey, …>` so a key added to
 *  `HOME_STAT_KEYS` without a producer (or vice-versa) is a compile error;
 *  `HOME_STAT_KEYS` drives the deterministic write order in `runHomeStats`. */
const PRODUCERS: Record<HomeStatsKey, StatCompute> = {
  'home.total_integrations': (db) => computeTotalIntegrations(db),
  'home.integrations_added_30d': (db, now) => computeIntegrationsAdded30d(db, now),
  'home.total_products': (db) => computeTotalProducts(db),
  'home.total_vendors': (db) => computeTotalVendors(db),
  'home.total_reviews': (db) => computeTotalReviews(db),
  'home.total_contributing_firms': (db) => computeTotalContributingFirms(db),
  'home.most_integrated_product': (db) => computeMostIntegratedProduct(db),
  'home.most_active_category': (db) => computeMostActiveCategory(db),
  'home.recent_integrations': (db) => computeRecentIntegrations(db),
  'home.trending_products': (db, now) => computeTrendingProducts(db, now),
  'home.recently_added_products': (db, now) => computeRecentlyAddedProducts(db, now),
};

export type HomeStatKeyStatus = 'written' | 'skipped' | 'failed';

export type HomeStatKeyOutcome = {
  key: HomeStatsKey;
  status: HomeStatKeyStatus;
  /** Wall-clock ms for this key's compute → validate → upsert. The caller emits
   *  it as the per-key `aeci.stats.compute.key.duration_ms` distribution (AECI-180
   *  / 4.5 observability). */
  durationMs: number;
  /** Present on `failed` — a compute throw, or the Zod validation message. */
  error?: string;
};

export type HomeStatsResult = { keys: HomeStatKeyOutcome[] };

/** Upsert one cached key (mirrors `writeWatermark` in `algolia-sync.ts`): the
 *  row is the key, `value` the json, `computedAt` advanced on every write. */
async function upsertStat(db: Db, key: StatsCacheKey, value: unknown, now: Date): Promise<void> {
  await db
    .insert(statsCache)
    .values({ key, value, computedAt: now.toISOString() })
    .onConflictDoUpdate({
      target: statsCache.key,
      set: { value, computedAt: now.toISOString() },
    });
}

/** Compute → validate → upsert one key. Never throws — a compute throw or a
 *  value that fails its `statsCacheValueSchemas` check returns `failed` so the
 *  caller can keep going. Timing is the caller's concern (it wraps this call). */
async function computeOneKey(
  db: Db,
  key: HomeStatsKey,
  now: Date,
): Promise<Pick<HomeStatKeyOutcome, 'status' | 'error'>> {
  try {
    const value = await PRODUCERS[key](db, now);
    if (value === null || value === undefined) {
      return { status: 'skipped' };
    }
    const parsed = statsCacheValueSchemas[key].safeParse(value);
    if (!parsed.success) {
      return { status: 'failed', error: `validation failed: ${parsed.error.message}` };
    }
    await upsertStat(db, key, parsed.data, now);
    return { status: 'written' };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Compute → validate → upsert each `home.*` key. Each key runs inside its own
 * try/catch so a single failing key (a compute throw, or a value that fails its
 * `statsCacheValueSchemas` check) is recorded as `failed` and the remaining keys
 * still write. Never throws — the orchestration returns a per-key outcome list
 * (with per-key wall-clock `durationMs`) the caller turns into Datadog
 * logs/metrics (4.5 / AECI-180).
 */
export async function runHomeStats(db: Db, now: Date): Promise<HomeStatsResult> {
  const keys: HomeStatKeyOutcome[] = [];
  for (const key of HOME_STAT_KEYS) {
    const startedAt = Date.now();
    const outcome = await computeOneKey(db, key, now);
    keys.push({ key, durationMs: Date.now() - startedAt, ...outcome });
  }
  return { keys };
}
