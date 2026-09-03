/**
 * Algolia incremental sync core (AECI-139 / Phase 3.6) — Drizzle/D1 (ADR 0016 /
 * AECI-253).
 *
 * Keeps each env's three Algolia indexes fresh between full reindexes via the
 * §20.5 write-event pipeline. Two callers share one core (`indexEntity`):
 *
 *   - the **daily cron** (`../scheduled.ts`) passes a watermark window
 *     (`{ type:'window', gtIso, lteIso }`) so it pushes only rows changed since
 *     the last run, and
 *   - the **promote hook** (`syncAlgoliaAfterPromote`, fired from `routes/promote.ts`
 *     via `ctx.waitUntil`) passes the just-touched ids (`{ type:'ids', ids }`).
 *
 * Index-membership rule: a **product/vendor** is in the index iff
 * `promotion_status = 'promoted'`; an **integration** iff BOTH its endpoint
 * products are `promoted`. Anything else is **deleted** from the index.
 *
 * Transport: the Worker-runtime `callAlgoliaBatch` (`@aeci/shared/algolia-batch`),
 * a never-throwing raw-`fetch` client.
 *
 * Watermark: a single `stats_cache` row (`algolia_sync_watermark`) holding a
 * per-entity ISO timestamp; advanced to the run's wall-clock `cutoff` only after
 * that entity's push succeeds. `updated_at` is ISO-8601 TEXT under D1, so the
 * window compares lexically (ISO sorts chronologically).
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
import { and, eq, gt, inArray, lte, notInArray, or, type SQL } from 'drizzle-orm';
import { type SQLiteColumn } from 'drizzle-orm/sqlite-core';

import type { Db } from '../db/client';
import { connectorEvidencedPairs, integrations, products, statsCache, vendors } from '../db/schema';
import {
  algoliaEvidencedPairConfig,
  algoliaIntegrationConfig,
  algoliaProductConfig,
  algoliaVendorConfig,
  toAlgoliaEvidencedPair,
  toAlgoliaIntegration,
  toAlgoliaProduct,
  toAlgoliaVendor,
  type RawAlgoliaEvidencedPairRow,
  type RawAlgoliaIntegrationRow,
  type RawAlgoliaProductRow,
  type RawAlgoliaVendorRow,
} from './algolia-transforms';

/** The `promotion_status` value that marks a product/vendor as live. */
const PROMOTED = 'promoted';

/** The `stats_cache` key holding the per-entity incremental-sync watermark. */
export const ALGOLIA_WATERMARK_KEY = 'algolia_sync_watermark';

/** Sentinel for a never-synced entity → a self-healing full sweep on first run. */
const EPOCH_ISO = new Date(0).toISOString();

// ---------------------------------------------------------------------------
// Filter (what both callers pass) → per-table Drizzle condition
// ---------------------------------------------------------------------------

/**
 * The row selector both callers pass: the cron passes the watermark window
 * (`updated_at` in `(gtIso, lteIso]`), the promote hook the touched ids. Each
 * builder turns it into a condition over ITS table's columns (each table has its
 * own `id` / `updated_at`).
 */
export type AlgoliaSyncFilter =
  | { type: 'window'; gtIso: string; lteIso: string }
  | { type: 'ids'; ids: string[] };

function whereFor(
  filter: AlgoliaSyncFilter,
  idCol: SQLiteColumn,
  updatedAtCol: SQLiteColumn,
): SQL | undefined {
  return filter.type === 'ids'
    ? inArray(idCol, filter.ids)
    : and(gt(updatedAtCol, filter.gtIso), lte(updatedAtCol, filter.lteIso));
}

export type IndexEntityResult = {
  entity: IndexEntity;
  indexName: string;
  saved: number;
  deleted: number;
  transformErrors: number;
  ok: boolean;
  error?: string;
};

// ---------------------------------------------------------------------------
// Request builders
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

async function buildProductRequests(db: Db, filter: AlgoliaSyncFilter): Promise<RequestBuild> {
  const rows = (await db.query.products.findMany({
    ...algoliaProductConfig,
    where: whereFor(filter, products.id, products.updatedAt),
  })) as RawAlgoliaProductRow[];
  return buildFromStatusRows('products', rows, (row) => toAlgoliaProduct(row));
}

async function buildVendorRequests(db: Db, filter: AlgoliaSyncFilter): Promise<RequestBuild> {
  const rows = (await db.query.vendors.findMany({
    ...algoliaVendorConfig,
    where: whereFor(filter, vendors.id, vendors.updatedAt),
  })) as RawAlgoliaVendorRow[];
  return buildFromStatusRows('vendors', rows, (row) => toAlgoliaVendor(row));
}

/**
 * Integrations carry no `promotion_status`; membership is "both endpoints
 * promoted". Two queries over the same window: eligible → upsert, ineligible →
 * delete-by-id. The both-promoted test is a subquery over the promoted product
 * ids (Drizzle `inArray`/`notInArray` against the same `SELECT id …` subquery).
 *
 * Since AECI-721 the `integrations` INDEX is fed by two TABLES: `integrations`
 * and `connector_evidenced_pairs` (§13.1's delivered tier). Both arms apply the
 * identical both-endpoints-promoted membership rule, and `drizzleDriftCounter`
 * in `algolia-drift-deps.ts` counts the same union — those two must move
 * together, because any disagreement between them IS the drift alarm.
 *
 * The connector's own promotion is deliberately NOT part of membership. It cannot
 * be unpromoted in practice (`connector_product_id` is a NOT NULL FK and rows only
 * arrive once it resolved), and adding a third condition would put the sync and
 * the guard out of step with the `integrations` arm for no reachable case.
 */
async function buildIntegrationRequests(db: Db, filter: AlgoliaSyncFilter): Promise<RequestBuild> {
  const window = whereFor(filter, integrations.id, integrations.updatedAt);
  const promotedProductIds = db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.promotionStatus, PROMOTED));

  const bothPromoted = and(
    inArray(integrations.sourceProductId, promotedProductIds),
    inArray(integrations.targetProductId, promotedProductIds),
  );
  const eitherNotPromoted = or(
    notInArray(integrations.sourceProductId, promotedProductIds),
    notInArray(integrations.targetProductId, promotedProductIds),
  );

  const eligible = (await db.query.integrations.findMany({
    ...algoliaIntegrationConfig,
    where: and(window, bothPromoted),
  })) as RawAlgoliaIntegrationRow[];
  const ineligible = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(and(window, eitherNotPromoted));

  const requests: AlgoliaBatchRequest[] = [];
  let transformErrors = 0;
  for (const row of eligible) {
    try {
      requests.push({ action: 'updateObject', body: toAlgoliaIntegration(row) });
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

  // ── The evidenced arm ────────────────────────────────────────────────────
  const pairWindow = whereFor(
    filter,
    connectorEvidencedPairs.id,
    connectorEvidencedPairs.updatedAt,
  );
  const pairBothPromoted = and(
    inArray(connectorEvidencedPairs.productAId, promotedProductIds),
    inArray(connectorEvidencedPairs.productBId, promotedProductIds),
  );
  const pairEitherNotPromoted = or(
    notInArray(connectorEvidencedPairs.productAId, promotedProductIds),
    notInArray(connectorEvidencedPairs.productBId, promotedProductIds),
  );

  const eligiblePairs = (await db.query.connectorEvidencedPairs.findMany({
    ...algoliaEvidencedPairConfig,
    where: and(pairWindow, pairBothPromoted),
  })) as RawAlgoliaEvidencedPairRow[];
  const ineligiblePairs = await db
    .select({ id: connectorEvidencedPairs.id })
    .from(connectorEvidencedPairs)
    .where(and(pairWindow, pairEitherNotPromoted));

  for (const row of eligiblePairs) {
    try {
      requests.push({ action: 'updateObject', body: toAlgoliaEvidencedPair(row) });
    } catch (error) {
      transformErrors += 1;
      console.warn(
        `algolia-sync: evidenced pair ${row.id} transform failed — skipped`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  for (const row of ineligiblePairs) {
    requests.push({ action: 'deleteObject', body: { objectID: row.id } });
  }

  return { requests, transformErrors };
}

const BUILDERS: Record<IndexEntity, (db: Db, filter: AlgoliaSyncFilter) => Promise<RequestBuild>> =
  {
    products: buildProductRequests,
    vendors: buildVendorRequests,
    integrations: buildIntegrationRequests,
  };

// ---------------------------------------------------------------------------
// Core: build → chunk → push
// ---------------------------------------------------------------------------

/**
 * Sync one entity's index for the rows matched by `filter`: build the
 * upsert/delete batch (membership-aware), chunk to `ALGOLIA_BATCH_MAX`, and push
 * via `callAlgoliaBatch`. Stops at the first failed chunk. Never throws.
 */
export async function indexEntity(
  db: Db,
  fetchImpl: typeof fetch,
  creds: AlgoliaBatchCredentials,
  env: AlgoliaEnv,
  entity: IndexEntity,
  filter: AlgoliaSyncFilter,
): Promise<IndexEntityResult> {
  const indexName = localizedIndexNamesFor(env)[entity];
  const { requests, transformErrors } = await BUILDERS[entity](db, filter);

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
export async function readWatermark(db: Db): Promise<AlgoliaWatermark> {
  const row = await db.query.statsCache.findFirst({
    where: eq(statsCache.key, ALGOLIA_WATERMARK_KEY),
  });
  const value = (row?.value ?? {}) as Partial<AlgoliaWatermark>;
  return {
    products: value.products ?? EPOCH_ISO,
    vendors: value.vendors ?? EPOCH_ISO,
    integrations: value.integrations ?? EPOCH_ISO,
  };
}

/** Persist the per-entity watermark (upsert the singleton row). */
export async function writeWatermark(
  db: Db,
  watermark: AlgoliaWatermark,
  now: Date,
): Promise<void> {
  await db
    .insert(statsCache)
    .values({ key: ALGOLIA_WATERMARK_KEY, value: watermark, computedAt: now.toISOString() })
    .onConflictDoUpdate({
      target: statsCache.key,
      set: { value: watermark, computedAt: now.toISOString() },
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
 * pushes successfully advances its watermark to `cutoff` (the wall-clock fence at
 * run start); a failed entity keeps its prior watermark for retry. Never throws.
 */
export async function runDailySync(
  db: Db,
  fetchImpl: typeof fetch,
  creds: AlgoliaBatchCredentials,
  env: AlgoliaEnv,
  now: Date,
): Promise<DailySyncResult> {
  const cutoffIso = now.toISOString();
  const watermark = await readWatermark(db);
  const next: AlgoliaWatermark = { ...watermark };

  const entities: IndexEntityResult[] = [];
  for (const entity of INDEX_ENTITIES) {
    const filter: AlgoliaSyncFilter = {
      type: 'window',
      gtIso: watermark[entity],
      lteIso: cutoffIso,
    };
    const result = await indexEntity(db, fetchImpl, creds, env, entity, filter);
    entities.push(result);
    if (result.ok) next[entity] = cutoffIso;
  }

  await writeWatermark(db, next, now);
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
 * Index the records a promote just wrote, by id. Returns one result per non-empty
 * entity. Never throws; the caller emits metrics / logs and fires this via
 * `ctx.waitUntil`.
 */
export async function syncPromoteTargets(
  db: Db,
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
    results.push(await indexEntity(db, fetchImpl, creds, env, entity, { type: 'ids', ids }));
  }
  return results;
}
