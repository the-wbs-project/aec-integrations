/**
 * What one plan-change ranking snapshot holds (AECI-1621, ADR 0056; `SEARCH_RANKING.md`
 * "Substantiation and retention").
 *
 * A snapshot is EVIDENCE, never an input. It records a product's ranking inputs and its
 * position in each public list at the moment of a plan start or end, and again 30 days
 * later. Nothing reads a snapshot back into a ranking.
 *
 * Every number is computed from the live catalog through the public code at `taken_at`.
 * Cached responses and the stored Algolia index are not read:
 *  - the listing tier through `productListingTier` (`@aeci/shared/listing-tier`);
 *  - the search record through `toAlgoliaProduct` (`lib/algolia-transforms.ts`);
 *  - each list position through `buildProductsWhere` and `resolveProductOrderBy('created')`,
 *    the `where` and the default order `GET /api/products` uses for `/products` and the
 *    four taxonomy pages. These are live D1 positions, not Algolia search positions:
 *    the `created_desc` replica has different timestamp precision and tie breakers,
 *    and the index can lag D1. No live Algolia query is made (ADR 0056);
 *  - the home "most integrated" rank through `mostIntegratedWhere` and
 *    `mostIntegratedOrderBy` (`lib/home-stats.ts`).
 *
 * `plan_now` is context, read here and nowhere in the ranking code. That is why this
 * module is not named `*rank*`, `*listing*`, `*sort*` or `*search*`:
 * `ranking-firewall.spec.ts` scans those names and forbids plan columns in them.
 *
 * No personal data: no actor, no email, no billing account name. A vendor's company
 * name rides in the search record, as it does on the public page.
 */

import type { AlgoliaProductRecord } from '@aeci/shared/algolia-records';
import { productListingTier, type ListingTier } from '@aeci/shared/listing-tier';
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  fieldHides,
  licenses,
  productAudiences,
  productCategories,
  productPhases,
  products,
  productTrades,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyPhases,
  taxonomyTrades,
} from '../db/schema';
import {
  algoliaProductConfig,
  toAlgoliaProduct,
  type RawAlgoliaProductRow,
} from './algolia-transforms';
import { buildProductsWhere, type ProductFilterParams } from './drizzle-helpers';
import { mostIntegratedOrderBy, mostIntegratedWhere } from './home-stats';
import { resolveProductOrderBy } from './sort';

/** Bump when the snapshot shape changes. A reader branches on it. */
export const PLAN_SNAPSHOT_SCHEMA = 1 as const;

/** The ledger columns a snapshot names. A `plan_change_snapshots` row satisfies it. */
export interface PlanChangeSnapshotRow {
  id: string;
  productId: string;
  kind: 'start' | 'end';
  phase: 'event' | 'followup';
  cause: string;
  licenseId: string;
  eventAt: string;
}

/** One list position. `rank` is 1-based. `rank: null` = the product is not in the list. */
export interface PlanSnapshotPosition {
  list: string;
  sort: 'created' | 'most-integrated';
  rank: number | null;
  of: number;
}

export interface PlanChangeSnapshot {
  schema: typeof PLAN_SNAPSHOT_SCHEMA;
  snapshot_id: string;
  product_id: string;
  kind: 'start' | 'end';
  phase: 'event' | 'followup';
  cause: string;
  license_id: string;
  event_at: string;
  taken_at: string;
  commit_sha: string;
  /** Context, not an input: whether a live license is on the product now. */
  plan_now: { managed: boolean; tier: 'managed' | 'free' };
  /** NULL when the product no longer exists (retracted). `reason` says so. */
  product: { slug: string; name: string; hidden: boolean; promotion_status: string } | null;
  reason?: 'product_missing';
  inputs: {
    listing_tier: ListingTier | null;
    listing_tier_inputs: {
      name: string;
      description: string | null;
      categories: string[];
      website: string | null;
      logo_url: string | null;
    };
    review_count: number;
    ratings: { overall_avg: number | null; onboarding_avg: number | null };
    created_at: string;
    integration_count: number;
    /** The record the Algolia sync would write now. NULL when the sync would delete it
     *  (hidden or not promoted). */
    algolia_record: AlgoliaProductRecord | null;
    /** Set when the transform threw: the sync would skip the record too. */
    algolia_record_error?: string;
  } | null;
  positions: PlanSnapshotPosition[];
}

export interface PlanSnapshotContext {
  takenAt: Date;
  commitSha: string;
}

type TermKind = 'category' | 'audience' | 'phase' | 'trade';

/** The public path of each taxonomy page (`apps/web/src/app/app.routes.ts`). */
const TERM_PATH: Record<TermKind, string> = {
  category: '/categories',
  audience: '/audiences',
  phase: '/phases',
  trade: '/trades',
};

/** 1-based rank of `productId` in the ids `where` selects under `orderBy`, and the
 *  list's size. Reads ids only. */
async function rankIn(
  db: Db,
  productId: string,
  where: SQL | undefined,
  orderBy: SQL[],
): Promise<{ rank: number | null; of: number }> {
  const ids = await db
    .select({ id: products.id })
    .from(products)
    .where(where)
    .orderBy(...orderBy);
  const index = ids.findIndex((r) => r.id === productId);
  return { rank: index === -1 ? null : index + 1, of: ids.length };
}

/** The product's term slugs per facet, binary-ordered so a snapshot is stable. */
async function termSlugs(db: Db, productId: string): Promise<Record<TermKind, string[]>> {
  const [categories, audiences, phases, trades] = await Promise.all([
    db
      .select({ slug: taxonomyCategories.slug })
      .from(productCategories)
      .innerJoin(taxonomyCategories, eq(taxonomyCategories.id, productCategories.categoryId))
      .where(eq(productCategories.productId, productId))
      .orderBy(taxonomyCategories.slug),
    db
      .select({ slug: taxonomyAudiences.slug })
      .from(productAudiences)
      .innerJoin(taxonomyAudiences, eq(taxonomyAudiences.id, productAudiences.audienceId))
      .where(eq(productAudiences.productId, productId))
      .orderBy(taxonomyAudiences.slug),
    db
      .select({ slug: taxonomyPhases.slug })
      .from(productPhases)
      .innerJoin(taxonomyPhases, eq(taxonomyPhases.id, productPhases.phaseId))
      .where(eq(productPhases.productId, productId))
      .orderBy(taxonomyPhases.slug),
    db
      .select({ slug: taxonomyTrades.slug })
      .from(productTrades)
      .innerJoin(taxonomyTrades, eq(taxonomyTrades.id, productTrades.tradeId))
      .where(eq(productTrades.productId, productId))
      .orderBy(taxonomyTrades.slug),
  ]);
  return {
    category: categories.map((r) => r.slug),
    audience: audiences.map((r) => r.slug),
    phase: phases.map((r) => r.slug),
    trade: trades.map((r) => r.slug),
  };
}

/** The product's active value hides, as the Algolia sync reads them (AECI-1238). */
async function activeHides(db: Db, productId: string): Promise<string[]> {
  const rows = await db
    .select({ field: fieldHides.field })
    .from(fieldHides)
    .where(
      and(
        eq(fieldHides.entityType, 'product'),
        eq(fieldHides.entityId, productId),
        isNull(fieldHides.clearedAt),
      ),
    );
  return rows.map((r) => r.field);
}

/** Whether a live license is on the product now. Context only. */
async function managedNow(db: Db, productId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(licenses)
    .where(and(eq(licenses.assignedProductId, productId), isNull(licenses.endedAt)));
  return (row?.n ?? 0) > 0;
}

/**
 * Build one snapshot from the live catalog. Read-only. A missing product still yields
 * a snapshot, with `product: null` and `reason: 'product_missing'`, so a retraction
 * never leaves a ledger row without its evidence.
 */
export async function buildPlanChangeSnapshot(
  db: Db,
  row: PlanChangeSnapshotRow,
  ctx: PlanSnapshotContext,
): Promise<PlanChangeSnapshot> {
  const managed = await managedNow(db, row.productId);
  const head = {
    schema: PLAN_SNAPSHOT_SCHEMA,
    snapshot_id: row.id,
    product_id: row.productId,
    kind: row.kind,
    phase: row.phase,
    cause: row.cause,
    license_id: row.licenseId,
    event_at: row.eventAt,
    taken_at: ctx.takenAt.toISOString(),
    commit_sha: ctx.commitSha,
    plan_now: { managed, tier: managed ? ('managed' as const) : ('free' as const) },
  };

  const product = (await db.query.products.findFirst({
    ...algoliaProductConfig,
    columns: { ...algoliaProductConfig.columns, ratingOnboardingAvg: true },
    where: eq(products.id, row.productId),
  })) as (RawAlgoliaProductRow & { ratingOnboardingAvg: number | null }) | undefined;

  if (!product) {
    return { ...head, product: null, reason: 'product_missing', inputs: null, positions: [] };
  }

  const categories = product.productCategories.map((r) => r.category.name);
  const tierInputs = {
    name: product.name,
    description: product.description,
    categories,
    website: product.website,
    logo_url: product.logoUrl,
  };
  const indexed = product.promotionStatus === 'promoted' && !product.hiddenAt;
  let algoliaRecord: AlgoliaProductRecord | null = null;
  let algoliaRecordError: string | undefined;
  if (indexed) {
    // The sync skips a record whose transform throws. The snapshot records why and
    // keeps the rest, so one bad field cannot leave the plan change without evidence.
    try {
      algoliaRecord = toAlgoliaProduct(product, await activeHides(db, row.productId));
    } catch (error) {
      algoliaRecordError = error instanceof Error ? error.message : String(error);
    }
  }

  const created = resolveProductOrderBy('created');
  const positions: PlanSnapshotPosition[] = [];
  const listed = async (list: string, filter: ProductFilterParams) => {
    const { rank, of } = await rankIn(db, row.productId, buildProductsWhere(db, filter), created);
    positions.push({ list, sort: 'created', rank, of });
  };

  await listed('/products', {});
  const slugs = await termSlugs(db, row.productId);
  for (const kind of ['category', 'audience', 'phase', 'trade'] as const) {
    for (const slug of slugs[kind]) {
      await listed(`${TERM_PATH[kind]}/${slug}`, { [`${kind}_slug`]: slug });
    }
  }
  const home = await rankIn(db, row.productId, mostIntegratedWhere, mostIntegratedOrderBy);
  positions.push({ list: 'home:most-integrated', sort: 'most-integrated', ...home });

  return {
    ...head,
    product: {
      slug: product.slug,
      name: product.name,
      hidden: Boolean(product.hiddenAt),
      promotion_status: product.promotionStatus,
    },
    inputs: {
      listing_tier: productListingTier(tierInputs) ?? null,
      listing_tier_inputs: tierInputs,
      review_count: product.reviewCount,
      ratings: {
        overall_avg: product.ratingOverallAvg,
        onboarding_avg: product.ratingOnboardingAvg,
      },
      created_at: product.createdAt,
      integration_count: product.integrationCount,
      algolia_record: algoliaRecord,
      ...(algoliaRecordError ? { algolia_record_error: algoliaRecordError } : {}),
    },
    positions,
  };
}

/** The R2 key, under the `evidence/` prefix the bucket lock covers. Listing one
 *  product's prefix returns its snapshots in date order. */
export function planSnapshotKey(row: PlanChangeSnapshotRow): string {
  return `evidence/plan-snapshots/product=${row.productId}/${row.eventAt}-${row.kind}-${row.phase}-${row.id}.json`;
}

/** The R2 bucket key prefix the 4-year lock covers (ADR 0056). */
export const EVIDENCE_PREFIX = 'evidence/';
