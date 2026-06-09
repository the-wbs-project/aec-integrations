/**
 * Algolia incremental sync core (AECI-139 / Phase 3.6).
 *
 * The complement to the one-off bulk reindex (AECI-138, `./algolia-bulk-sync.ts`):
 * keeps each env's three Algolia indexes fresh between full reindexes via the
 * §20.5 write-event pipeline. Two callers share one core (`indexEntity`):
 *
 *   - the **daily cron** (`../scheduled.ts`, 08:00 UTC = 03:00 EST) passes a
 *     watermark window (`{ updatedAt: { gt, lte } }`) so it pushes only rows
 *     changed since the last run, and
 *   - the **promote hook** (`syncAlgoliaAfterPromote`, fired from `routes/promote.ts`
 *     via `ctx.waitUntil`) passes the just-touched ids (`{ id: { in } }`) so a
 *     promote is searchable immediately, not at the next daily sync.
 *
 * Index-membership rule (identical to the bulk script, so cron / bulk / promote
 * converge on the same index state): a **product/vendor** is in the index iff
 * `promotion_status = 'promoted'`; an **integration** iff BOTH its endpoint
 * products are `promoted`. Anything else is **deleted** from the index (the
 * delete path the bulk script deliberately omits — that's this issue's job, so
 * `retracted`/`rejected` rows are removed, not just skipped).
 *
 * Transport: the Worker-runtime `callAlgoliaBatch` (`@aeci/shared/algolia-batch`),
 * a never-throwing raw-`fetch` client — NOT the `algoliasearch` SDK (that's a
 * Node-only devDep used by the bulk CLI). Both produce the same upsert-by-objectID
 * end-state.
 *
 * Watermark: a single `stats_cache` row (`algolia_sync_watermark`) holding a
 * per-entity ISO timestamp. Advanced to the run's wall-clock `cutoff` (a fence,
 * not `max(updated_at)`) only after that entity's push succeeds; a failed entity
 * keeps its watermark so the next run retries (idempotent re-push is safe).
 *
 * Known bounded gaps (style of `routes/promote-cache-tags.ts`; owned elsewhere):
 *   - **Denormalized drift** the delta can't see: a vendor's `integration_count`
 *     or a taxonomy-term rename changes the *record* without bumping the entity
 *     row's `updated_at`, so the daily window misses it. Owned by AECI-140
 *     (index↔DB drift reconciliation) and the periodic bulk reindex.
 *   - **Integration cascade on endpoint retract:** eligibility is read from both
 *     endpoints, but a retracted endpoint product does not bump its integrations'
 *     `updated_at`, so those integrations aren't re-evaluated until the
 *     integration row itself changes. No retract path exists today; AECI-140.
 *   - **Single write host** (no Algolia retry-host failover): acceptable for a
 *     best-effort sync — the next cron run is the safety net.
 */

import {
  ALGOLIA_BATCH_MAX,
  callAlgoliaBatch,
  type AlgoliaBatchCredentials,
  type AlgoliaBatchRequest,
} from '@aeci/shared/algolia-batch';
import {
  INDEX_ENTITIES,
  localizedIndexNamesFor,
  type AlgoliaEnv,
  type IndexEntity,
} from '@aeci/shared/algolia';
import type { Prisma } from '@prisma/client/edge';

import {
  algoliaIntegrationSelect,
  algoliaProductSelect,
  algoliaVendorSelect,
  toAlgoliaIntegration,
  toAlgoliaProduct,
  toAlgoliaVendor,
} from './algolia-transforms';

/** The `promotion_status` value that marks a product/vendor as live (mirrors
 *  `./algolia-bulk-sync.ts` and `routes/promote.ts`). */
const PROMOTED = 'promoted';

/** The `stats_cache` key holding the per-entity incremental-sync watermark. */
export const ALGOLIA_WATERMARK_KEY = 'algolia_sync_watermark';

/** Sentinel for a never-synced entity → a self-healing full sweep on first run. */
const EPOCH_ISO = new Date(0).toISOString();

// ---------------------------------------------------------------------------
// Select shapes (augment the AECI-137 transform selects with the sync signals)
// ---------------------------------------------------------------------------

/** `algoliaProductSelect` carries neither `promotionStatus` nor `updatedAt`. */
const productSyncSelect = {
  ...algoliaProductSelect,
  promotionStatus: true,
  updatedAt: true,
} as const satisfies Prisma.ProductSelect;

/** `algoliaVendorSelect` already carries `updatedAt` (via `vendorListSelect`). */
const vendorSyncSelect = {
  ...algoliaVendorSelect,
  promotionStatus: true,
} as const satisfies Prisma.VendorSelect;

type RawProductSyncRow = Prisma.ProductGetPayload<{ select: typeof productSyncSelect }>;
type RawVendorSyncRow = Prisma.VendorGetPayload<{ select: typeof vendorSyncSelect }>;

// ---------------------------------------------------------------------------
// Minimal Prisma + result types (structural, so tests inject a recording fake)
// ---------------------------------------------------------------------------

/**
 * The where-filter both callers pass. A minimal shape valid as a
 * `Product|Vendor|Integration WhereInput`: the cron passes the watermark window,
 * the promote hook passes the touched ids.
 */
export type AlgoliaSyncWhere = {
  updatedAt?: { gt: Date; lte: Date };
  id?: { in: string[] };
};

export type AlgoliaSyncPrisma = {
  product: {
    findMany(args: {
      where: Prisma.ProductWhereInput;
      select: typeof productSyncSelect;
    }): Promise<RawProductSyncRow[]>;
  };
  vendor: {
    findMany(args: {
      where: Prisma.VendorWhereInput;
      select: typeof vendorSyncSelect;
    }): Promise<RawVendorSyncRow[]>;
  };
  integration: {
    findMany(args: {
      where: Prisma.IntegrationWhereInput;
      select: Prisma.IntegrationSelect;
    }): Promise<Array<{ id: string }>>;
  };
  statsCache: {
    findUnique(args: { where: { key: string } }): Promise<{ value: unknown } | null>;
    upsert(args: {
      where: { key: string };
      create: { key: string; value: AlgoliaWatermark };
      update: { value: AlgoliaWatermark; computedAt: Date };
    }): Promise<unknown>;
  };
};

export type IndexEntityResult = {
  entity: IndexEntity;
  indexName: string;
  /** Records upserted (`updateObject`). */
  saved: number;
  /** Records removed (`deleteObject`). */
  deleted: number;
  /** Rows whose transform threw and were skipped (logged, never block the run). */
  transformErrors: number;
  /** True when every Algolia batch for this entity succeeded. */
  ok: boolean;
  /** First push failure message, when `ok === false`. */
  error?: string;
};

// ---------------------------------------------------------------------------
// Request builders (one per entity — entities differ only in how membership and
// the record body are derived)
// ---------------------------------------------------------------------------

type RequestBuild = { requests: AlgoliaBatchRequest[]; transformErrors: number };

function buildFromStatusRows<TRow extends { id: string; promotionStatus: string }>(
  entity: IndexEntity,
  rows: TRow[],
  transform: (row: TRow) => Record<string, unknown>,
): RequestBuild {
  const requests: AlgoliaBatchRequest[] = [];
  let transformErrors = 0;
  for (const row of rows) {
    if (row.promotionStatus === PROMOTED) {
      try {
        requests.push({ action: 'updateObject', body: transform(row) });
      } catch (error) {
        // Fail loud but don't wedge the run: log + skip so the watermark can
        // still advance past this row (a corrupt enum is surfaced via the log
        // and the AECI-140 reconciliation, not by retrying forever).
        transformErrors += 1;
        console.warn(
          `algolia-sync: ${entity} ${row.id} transform failed — skipped`,
          error instanceof Error ? error.message : error,
        );
      }
    } else {
      requests.push({ action: 'deleteObject', body: { objectID: row.id } });
    }
  }
  return { requests, transformErrors };
}

async function buildProductRequests(
  prisma: AlgoliaSyncPrisma,
  where: AlgoliaSyncWhere,
): Promise<RequestBuild> {
  const rows = await prisma.product.findMany({ where, select: productSyncSelect });
  return buildFromStatusRows('products', rows, (row) => toAlgoliaProduct(row));
}

async function buildVendorRequests(
  prisma: AlgoliaSyncPrisma,
  where: AlgoliaSyncWhere,
): Promise<RequestBuild> {
  const rows = await prisma.vendor.findMany({ where, select: vendorSyncSelect });
  return buildFromStatusRows('vendors', rows, (row) => toAlgoliaVendor(row));
}

/**
 * Integrations carry no `promotion_status`; membership is "both endpoints
 * promoted" (the AECI-138 filter). Two queries over the same window: eligible →
 * upsert, ineligible → delete-by-id. Avoids merging endpoint status into the
 * AECI-137 nested `productLinkSelect`.
 */
async function buildIntegrationRequests(
  prisma: AlgoliaSyncPrisma,
  where: AlgoliaSyncWhere,
): Promise<RequestBuild> {
  const bothPromoted = {
    sourceProduct: { is: { promotionStatus: PROMOTED } },
    targetProduct: { is: { promotionStatus: PROMOTED } },
  } satisfies Prisma.IntegrationWhereInput;
  const eitherNotPromoted = {
    OR: [
      { sourceProduct: { is: { promotionStatus: { not: PROMOTED } } } },
      { targetProduct: { is: { promotionStatus: { not: PROMOTED } } } },
    ],
  } satisfies Prisma.IntegrationWhereInput;

  const eligible = await prisma.integration.findMany({
    where: { AND: [where, bothPromoted] },
    select: algoliaIntegrationSelect,
  });
  const ineligible = await prisma.integration.findMany({
    where: { AND: [where, eitherNotPromoted] },
    select: { id: true, updatedAt: true },
  });

  const requests: AlgoliaBatchRequest[] = [];
  let transformErrors = 0;
  for (const row of eligible) {
    try {
      requests.push({
        action: 'updateObject',
        body: toAlgoliaIntegration(row as Parameters<typeof toAlgoliaIntegration>[0]),
      });
    } catch (error) {
      transformErrors += 1;
      console.warn(
        `algolia-sync: integration ${row.id} transform failed — skipped`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  for (const row of ineligible) {
    requests.push({ action: 'deleteObject', body: { objectID: row.id } });
  }
  return { requests, transformErrors };
}

const BUILDERS: Record<
  IndexEntity,
  (prisma: AlgoliaSyncPrisma, where: AlgoliaSyncWhere) => Promise<RequestBuild>
> = {
  products: buildProductRequests,
  vendors: buildVendorRequests,
  integrations: buildIntegrationRequests,
};

// ---------------------------------------------------------------------------
// Core: build → chunk → push
// ---------------------------------------------------------------------------

/**
 * Sync one entity's index for the rows matched by `where`: build the
 * upsert/delete batch (membership-aware), chunk to `ALGOLIA_BATCH_MAX`, and push
 * via `callAlgoliaBatch`. Stops at the first failed chunk (the watermark won't
 * advance, so the rest re-pushes next run). Never throws.
 */
export async function indexEntity(
  prisma: AlgoliaSyncPrisma,
  fetchImpl: typeof fetch,
  creds: AlgoliaBatchCredentials,
  env: AlgoliaEnv,
  entity: IndexEntity,
  where: AlgoliaSyncWhere,
): Promise<IndexEntityResult> {
  const indexName = localizedIndexNamesFor(env)[entity];
  const { requests, transformErrors } = await BUILDERS[entity](prisma, where);

  const base: IndexEntityResult = {
    entity,
    indexName,
    saved: 0,
    deleted: 0,
    transformErrors,
    ok: true,
  };
  if (requests.length === 0) return base;

  let saved = 0;
  let deleted = 0;
  for (let i = 0; i < requests.length; i += ALGOLIA_BATCH_MAX) {
    const chunk = requests.slice(i, i + ALGOLIA_BATCH_MAX);
    const outcome = await callAlgoliaBatch(fetchImpl, creds, indexName, chunk);
    if (!outcome.ok) {
      return { ...base, saved, deleted, ok: false, error: outcome.message };
    }
    for (const r of chunk) {
      if (r.action === 'updateObject') saved += 1;
      else deleted += 1;
    }
  }
  return { ...base, saved, deleted };
}

// ---------------------------------------------------------------------------
// Watermark (stats_cache row)
// ---------------------------------------------------------------------------

export type AlgoliaWatermark = Record<IndexEntity, string>;

/** Read the per-entity watermark; a missing row/field → epoch (full sweep). */
export async function readWatermark(prisma: AlgoliaSyncPrisma): Promise<AlgoliaWatermark> {
  const row = await prisma.statsCache.findUnique({ where: { key: ALGOLIA_WATERMARK_KEY } });
  const value = (row?.value ?? {}) as Partial<AlgoliaWatermark>;
  return {
    products: value.products ?? EPOCH_ISO,
    vendors: value.vendors ?? EPOCH_ISO,
    integrations: value.integrations ?? EPOCH_ISO,
  };
}

/** Persist the per-entity watermark (upsert the singleton row). */
export async function writeWatermark(
  prisma: AlgoliaSyncPrisma,
  watermark: AlgoliaWatermark,
  now: Date,
): Promise<void> {
  await prisma.statsCache.upsert({
    where: { key: ALGOLIA_WATERMARK_KEY },
    create: { key: ALGOLIA_WATERMARK_KEY, value: watermark },
    update: { value: watermark, computedAt: now },
  });
}

// ---------------------------------------------------------------------------
// Daily cron entry: watermark window → indexEntity → advance fence
// ---------------------------------------------------------------------------

export type DailySyncResult = {
  cutoff: string;
  entities: IndexEntityResult[];
};

/**
 * Run the incremental sync across all three entities for `env`. Each entity that
 * pushes successfully advances its watermark to `cutoff` (the wall-clock fence
 * captured at run start); a failed entity keeps its prior watermark for retry.
 * The watermark row is written once, after the loop. Never throws.
 */
export async function runDailySync(
  prisma: AlgoliaSyncPrisma,
  fetchImpl: typeof fetch,
  creds: AlgoliaBatchCredentials,
  env: AlgoliaEnv,
  now: Date,
): Promise<DailySyncResult> {
  const cutoff = now;
  const cutoffIso = cutoff.toISOString();
  const watermark = await readWatermark(prisma);
  const next: AlgoliaWatermark = { ...watermark };

  const entities: IndexEntityResult[] = [];
  for (const entity of INDEX_ENTITIES) {
    const where: AlgoliaSyncWhere = {
      updatedAt: { gt: new Date(watermark[entity]), lte: cutoff },
    };
    const result = await indexEntity(prisma, fetchImpl, creds, env, entity, where);
    entities.push(result);
    if (result.ok) next[entity] = cutoffIso;
  }

  await writeWatermark(prisma, next, cutoff);
  return { cutoff: cutoffIso, entities };
}

// ---------------------------------------------------------------------------
// Promote hook: index the just-touched ids immediately (best-effort)
// ---------------------------------------------------------------------------

/** The slice of `PromoteResponse` this hook reads (ids per entity). */
export type PromoteIndexTargets = {
  product: { id: string } | null;
  vendors: Array<{ id: string }>;
  integrations: Array<{ id: string }>;
};

/**
 * Index the records a promote just wrote, by id. Returns one result per
 * non-empty entity (skips an entity with no ids — no empty batch POST). Never
 * throws; the caller emits metrics / logs and fires this via `ctx.waitUntil`.
 */
export async function syncPromoteTargets(
  prisma: AlgoliaSyncPrisma,
  fetchImpl: typeof fetch,
  creds: AlgoliaBatchCredentials,
  env: AlgoliaEnv,
  targets: PromoteIndexTargets,
): Promise<IndexEntityResult[]> {
  const byEntity: Array<[IndexEntity, string[]]> = [
    ['products', targets.product ? [targets.product.id] : []],
    ['vendors', targets.vendors.map((v) => v.id)],
    ['integrations', targets.integrations.map((i) => i.id)],
  ];

  const results: IndexEntityResult[] = [];
  for (const [entity, ids] of byEntity) {
    if (ids.length === 0) continue;
    results.push(await indexEntity(prisma, fetchImpl, creds, env, entity, { id: { in: ids } }));
  }
  return results;
}
