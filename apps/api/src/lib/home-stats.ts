/**
 * Home-stats compute core (AECI-178 / Phase 4.3 — the §10 "Stats Pipeline"
 * producer).
 *
 * The daily scheduled job (`../scheduled.ts`, ADR 0013 cron→queue→consumer)
 * recomputes the seven `home.*` `stats_cache` keys and upserts each as its own
 * row. The read endpoint (4.4) and home UI (4.8) consume these via `@aeci/shared`
 * — this module is the only writer.
 *
 * Contract (docs/STAGE_1_SPEC.md §10, §4.1; types/schemas from AECI-176):
 *   - Seven keys: total_integrations, integrations_added_30d,
 *     most_integrated_product, most_active_category, recent_integrations (≤10),
 *     trending_products (top 5 by page_views, last 7d), recently_added_products
 *     (≤10, last 30d).
 *   - **Every value is validated against `statsCacheValueSchemas[key]` before the
 *     write** — the job and the read endpoint share one source of truth, so the
 *     cache can never hold a shape the reader rejects.
 *   - Idempotent (upsert per key); **partial failure of one key must not abort
 *     the others** — each key computes/validates/writes inside its own try/catch
 *     and `runHomeStats` never throws (the crash surface is the caller).
 *   - Empty `page_views` → empty `trending_products` (`[]`), never a throw.
 *
 * No promotion filter — mirrors `GET /api/products` / `GET /api/integrations`,
 * which apply none either (the DB only holds promoted rows; the promote pipeline
 * is the gate). Counting here the same way keeps the home stats consistent with
 * the list endpoints.
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
import type { Prisma } from '@prisma/client/edge';

import {
  integrationListSelect,
  productListSelect,
  toIntegrationListItem,
  toProductListItem,
  type RawProductListRow,
} from './prisma-helpers';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Selects (the lean shapes each compute fn needs beyond the shared hydration)
// ---------------------------------------------------------------------------

/** `home.most_integrated_product` — the single product + its denormalized count. */
const mostIntegratedSelect = {
  id: true,
  name: true,
  slug: true,
  logoUrl: true,
  integrationCount: true,
} as const satisfies Prisma.ProductSelect;

/** `home.most_active_category` — both endpoints' category-id edges per integration. */
const categoryEdgeSelect = {
  id: true,
  sourceProduct: { select: { productCategories: { select: { categoryId: true } } } },
  targetProduct: { select: { productCategories: { select: { categoryId: true } } } },
} as const satisfies Prisma.IntegrationSelect;

/** Category display ref (`TaxonomyRef` = id + name + slug). */
const categoryRefSelect = {
  id: true,
  name: true,
  slug: true,
} as const satisfies Prisma.TaxonomyCategorySelect;

type CategoryRefRow = Prisma.TaxonomyCategoryGetPayload<{ select: typeof categoryRefSelect }>;

// ---------------------------------------------------------------------------
// Narrow Prisma type (structural, so tests inject a recording fake — mirrors
// `AlgoliaSyncPrisma`). Generic over `select` so the two integration/product
// queries each keep their precise `*GetPayload` return type. The accelerated
// client is cast to this via `getPrisma(env) as unknown as HomeStatsPrisma`.
// ---------------------------------------------------------------------------

export type HomeStatsPrisma = {
  integration: {
    count(args?: { where?: Prisma.IntegrationWhereInput }): Promise<number>;
    findMany<S extends Prisma.IntegrationSelect>(args: {
      where?: Prisma.IntegrationWhereInput;
      orderBy?:
        | Prisma.IntegrationOrderByWithRelationInput
        | Prisma.IntegrationOrderByWithRelationInput[];
      take?: number;
      select: S;
    }): Promise<Array<Prisma.IntegrationGetPayload<{ select: S }>>>;
  };
  product: {
    findFirst<S extends Prisma.ProductSelect>(args: {
      where?: Prisma.ProductWhereInput;
      orderBy?: Prisma.ProductOrderByWithRelationInput | Prisma.ProductOrderByWithRelationInput[];
      select: S;
    }): Promise<Prisma.ProductGetPayload<{ select: S }> | null>;
    findMany<S extends Prisma.ProductSelect>(args: {
      where?: Prisma.ProductWhereInput;
      orderBy?: Prisma.ProductOrderByWithRelationInput | Prisma.ProductOrderByWithRelationInput[];
      take?: number;
      select: S;
    }): Promise<Array<Prisma.ProductGetPayload<{ select: S }>>>;
  };
  pageView: {
    groupBy(args: {
      by: ['productId'];
      where?: Prisma.PageViewWhereInput;
      _count?: { _all: true };
      orderBy?:
        | Prisma.PageViewOrderByWithAggregationInput
        | Prisma.PageViewOrderByWithAggregationInput[];
      take?: number;
    }): Promise<Array<{ productId: string | null; _count: { _all: number } }>>;
  };
  taxonomyCategory: {
    findMany<S extends Prisma.TaxonomyCategorySelect>(args: {
      select: S;
    }): Promise<Array<Prisma.TaxonomyCategoryGetPayload<{ select: S }>>>;
  };
  statsCache: {
    upsert(args: {
      where: { key: string };
      create: { key: string; value: Prisma.InputJsonValue };
      update: { value: Prisma.InputJsonValue; computedAt: Date };
    }): Promise<unknown>;
  };
};

// ---------------------------------------------------------------------------
// Per-key compute functions (pure; exported for unit tests). A function returns
// `null` to signal "skip this key" (e.g. an empty DB has no most-integrated
// product) — no `home.*` value schema accepts `null`, so the sentinel is
// unambiguous. Scalar/array keys always return a value (a number / `[]`).
// ---------------------------------------------------------------------------

export function computeTotalIntegrations(prisma: HomeStatsPrisma): Promise<number> {
  return prisma.integration.count();
}

export function computeIntegrationsAdded30d(prisma: HomeStatsPrisma, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 30 * DAY_MS);
  return prisma.integration.count({ where: { createdAt: { gte: since } } });
}

export async function computeMostIntegratedProduct(
  prisma: HomeStatsPrisma,
): Promise<MostIntegratedProduct | null> {
  // `as const` on the sort values keeps Prisma's `select` narrowing intact (an
  // inline `'desc'` widens to `string` and drops the typed payload — repo memory).
  const row = await prisma.product.findFirst({
    orderBy: [{ integrationCount: 'desc' as const }, { name: 'asc' as const }],
    select: mostIntegratedSelect,
  });
  if (!row) return null;
  return {
    product: { id: row.id, name: row.name, slug: row.slug, logo_url: row.logoUrl },
    integration_count: row.integrationCount,
  };
}

export async function computeMostActiveCategory(
  prisma: HomeStatsPrisma,
): Promise<MostActiveCategory | null> {
  const edges = await prisma.integration.findMany({ select: categoryEdgeSelect });
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

  const categories = await prisma.taxonomyCategory.findMany({ select: categoryRefSelect });
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

export async function computeRecentIntegrations(
  prisma: HomeStatsPrisma,
): Promise<IntegrationListItem[]> {
  const rows = await prisma.integration.findMany({
    orderBy: { createdAt: 'desc' as const },
    take: 10,
    select: integrationListSelect,
  });
  return rows.map(toIntegrationListItem);
}

export async function computeTrendingProducts(
  prisma: HomeStatsPrisma,
  now: Date,
): Promise<ProductListItem[]> {
  const since = new Date(now.getTime() - 7 * DAY_MS);
  const groups = await prisma.pageView.groupBy({
    by: ['productId'],
    where: { createdAt: { gte: since }, productId: { not: null } },
    _count: { _all: true },
    orderBy: [{ _count: { productId: 'desc' as const } }, { productId: 'asc' as const }],
    take: 5,
  });
  const ids = groups.map((g) => g.productId).filter((id): id is string => id !== null);
  if (ids.length === 0) return []; // no traffic yet — expected, not a failure
  const rows = await prisma.product.findMany({
    where: { id: { in: ids } },
    select: productListSelect,
  });
  const byId = new Map<string, RawProductListRow>(rows.map((r) => [r.id, r]));
  // Reorder to the page-view ranking; drop any id whose product no longer exists.
  return ids
    .map((id) => byId.get(id))
    .filter((r): r is RawProductListRow => r !== undefined)
    .map(toProductListItem);
}

export async function computeRecentlyAddedProducts(
  prisma: HomeStatsPrisma,
  now: Date,
): Promise<ProductListItem[]> {
  const since = new Date(now.getTime() - 30 * DAY_MS);
  const rows = await prisma.product.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' as const },
    take: 10,
    select: productListSelect,
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
  'home.most_integrated_product',
  'home.most_active_category',
  'home.recent_integrations',
  'home.trending_products',
  'home.recently_added_products',
] as const satisfies readonly StatsCacheKey[];

export type HomeStatsKey = (typeof HOME_STAT_KEYS)[number];

/** Returns the value to validate + cache, or `null` to skip the key. */
type StatCompute = (prisma: HomeStatsPrisma, now: Date) => Promise<unknown>;

/** One compute fn per key. Typed `Record<HomeStatsKey, …>` so a key added to
 *  `HOME_STAT_KEYS` without a producer (or vice-versa) is a compile error;
 *  `HOME_STAT_KEYS` drives the deterministic write order in `runHomeStats`. */
const PRODUCERS: Record<HomeStatsKey, StatCompute> = {
  'home.total_integrations': (p) => computeTotalIntegrations(p),
  'home.integrations_added_30d': (p, now) => computeIntegrationsAdded30d(p, now),
  'home.most_integrated_product': (p) => computeMostIntegratedProduct(p),
  'home.most_active_category': (p) => computeMostActiveCategory(p),
  'home.recent_integrations': (p) => computeRecentIntegrations(p),
  'home.trending_products': (p, now) => computeTrendingProducts(p, now),
  'home.recently_added_products': (p, now) => computeRecentlyAddedProducts(p, now),
};

export type HomeStatKeyStatus = 'written' | 'skipped' | 'failed';

export type HomeStatKeyOutcome = {
  key: HomeStatsKey;
  status: HomeStatKeyStatus;
  /** Present on `failed` — a compute throw, or the Zod validation message. */
  error?: string;
};

export type HomeStatsResult = { keys: HomeStatKeyOutcome[] };

/** Upsert one cached key (mirrors `writeWatermark` in `algolia-sync.ts`): the
 *  row is the key, `value` the jsonb, `computedAt` advanced on every write. */
async function upsertStat(
  prisma: HomeStatsPrisma,
  key: StatsCacheKey,
  value: Prisma.InputJsonValue,
  now: Date,
): Promise<void> {
  await prisma.statsCache.upsert({
    where: { key },
    create: { key, value },
    update: { value, computedAt: now },
  });
}

/**
 * Compute → validate → upsert each `home.*` key. Each key runs inside its own
 * try/catch so a single failing key (a compute throw, or a value that fails its
 * `statsCacheValueSchemas` check) is logged as `failed` and the remaining keys
 * still write. Never throws — the orchestration returns a per-key outcome list
 * the caller turns into Datadog logs/metrics (4.5).
 */
export async function runHomeStats(prisma: HomeStatsPrisma, now: Date): Promise<HomeStatsResult> {
  const keys: HomeStatKeyOutcome[] = [];
  for (const key of HOME_STAT_KEYS) {
    try {
      const value = await PRODUCERS[key](prisma, now);
      if (value === null || value === undefined) {
        keys.push({ key, status: 'skipped' });
        continue;
      }
      const parsed = statsCacheValueSchemas[key].safeParse(value);
      if (!parsed.success) {
        keys.push({ key, status: 'failed', error: `validation failed: ${parsed.error.message}` });
        continue;
      }
      await upsertStat(prisma, key, parsed.data as Prisma.InputJsonValue, now);
      keys.push({ key, status: 'written' });
    } catch (error) {
      keys.push({
        key,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { keys };
}
