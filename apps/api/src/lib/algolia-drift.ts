/**
 * Algolia ↔ D1 index-drift reconciliation — the testable core of the Phase 3.7
 * daily data-quality check (AECI-140, `STAGE_1_SPEC.md` §23.1 line "Algolia index
 * drift (record count mismatch with the database)").
 *
 * Counts the **promoted** rows per entity in D1 and the object count of the
 * matching Algolia index, and reports any per-index mismatch. Report-only: there
 * is no auto-remediation (§23.1 — humans triage; re-run the AECI-138 bulk sync to
 * repair).
 *
 * Dependency-injected, exactly like `./algolia-bulk-sync`: this module imports
 * neither a database client nor `algoliasearch`, so it unit-tests with fakes and
 * (more importantly) is safe to bundle into the API Worker via the cron handler.
 * The Worker cron (`apps/api/src/scheduled.ts`) wires the real clients: a
 * Drizzle/D1-backed counter (`drizzleDriftCounter`) and the fetch-based Algolia
 * counter below.
 *
 * The promoted-row definition mirrors the bulk sync (`./algolia-bulk-sync`):
 * `products`/`vendors` carry `promotion_status`; integrations are promoted
 * transitively when BOTH endpoints are. Index names come from the single source
 * of truth `@aeci/shared/algolia`.
 *
 * Spec: `STAGE_1_SPEC.md` §23.1; `CICD_PLAN.md` §3.2.
 */

import {
  DEFAULT_LOCALE,
  INDEX_ENTITIES,
  localizedIndexNamesFor,
  type AlgoliaEnv,
  type AlgoliaIndexNames,
  type IndexEntity,
} from '@aeci/shared/algolia';

/**
 * The `promotion_status` value that marks a row live on the public site (the
 * value `POST /api/promote` writes; `docs/DATABASE_SCHEMA.md` CHECK constraint).
 * Same constant the bulk sync filters on (`./algolia-bulk-sync`).
 */
const PROMOTED = 'promoted';

/**
 * Minimal DB read surface this check uses — `.count()` per entity. Satisfied by
 * the Drizzle/D1-backed counter (`drizzleDriftCounter`, the cron path); the
 * where-shapes are the same promoted-only filters the bulk sync
 * (`./algolia-bulk-sync`) reads on.
 */
export type DriftCount = {
  product: { count(args: { where: { promotionStatus: string } }): Promise<number> };
  vendor: { count(args: { where: { promotionStatus: string } }): Promise<number> };
  integration: {
    count(args: {
      where: {
        sourceProduct: { promotionStatus: string };
        targetProduct: { promotionStatus: string };
      };
    }): Promise<number>;
  };
};

/**
 * Minimal Algolia read surface: the object count of one index. Injected so the
 * lib stays dependency-free and unit-tests with a fake; `createAlgoliaCounter`
 * is the fetch-based production implementation.
 */
export type AlgoliaCountClient = {
  countObjects(indexName: string): Promise<number>;
};

/** Drift for one entity's index. `drift = database - algolia` (signed). */
export type AlgoliaIndexDrift = {
  entity: IndexEntity;
  indexName: string;
  /** Promoted rows in D1. */
  database: number;
  /** Objects in the Algolia index (`nbHits` of an empty query). */
  algolia: number;
  /** `database - algolia`: positive = index is missing rows; negative = orphans. */
  drift: number;
};

/**
 * Fetch-based Algolia object counter — dependency-free (no `algoliasearch`), so
 * it runs in the Worker and in Node. Counts via an empty search query
 * (`hitsPerPage=0`) and reads `nbHits`; the per-env MANAGEMENT key's `search`
 * ACL covers this read. `nbHits` is exact at AECi's hundreds-of-records scale
 * (it can become approximate only well above ~1000 distinct hits). A non-2xx
 * response throws so the caller can tell a misconfig / missing index apart from
 * genuine drift — the AECI-138 `algoliasearch` SDK could later be dropped behind
 * this same interface for multi-host read fallback.
 */
export function createAlgoliaCounter(appId: string, apiKey: string): AlgoliaCountClient {
  return {
    async countObjects(indexName: string): Promise<number> {
      const url = `https://${appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(indexName)}/query`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Algolia-Application-Id': appId,
          'X-Algolia-API-Key': apiKey,
        },
        // POST search expects a url-encoded `params` string. hitsPerPage=0 keeps
        // the payload tiny; analytics=false keeps this off the search-analytics.
        body: JSON.stringify({ params: 'query=&hitsPerPage=0&analytics=false' }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(
          `Algolia count failed for index "${indexName}": HTTP ${res.status}${
            detail ? ` — ${detail.slice(0, 200)}` : ''
          }`,
        );
      }
      const body = (await res.json()) as { nbHits?: unknown };
      if (typeof body.nbHits !== 'number' || !Number.isFinite(body.nbHits)) {
        throw new Error(`Algolia count for index "${indexName}" returned no numeric nbHits`);
      }
      return body.nbHits;
    },
  };
}

/**
 * Count promoted rows per entity in D1 and objects per index in Algolia, and
 * return one row per entity (in `INDEX_ENTITIES` order). Read-only; callers
 * filter `drift !== 0`. Index names resolve through `@aeci/shared/algolia`
 * (locale-aware: default `en-US` → bare `<prefix>_<entity>`).
 */
export async function findAlgoliaIndexDrift(
  deps: { db: DriftCount; algolia: AlgoliaCountClient },
  opts: { env: AlgoliaEnv; locale?: string },
): Promise<AlgoliaIndexDrift[]> {
  const { db, algolia } = deps;
  const names: AlgoliaIndexNames = localizedIndexNamesFor(opts.env, opts.locale ?? DEFAULT_LOCALE);

  const databaseCount: Record<IndexEntity, () => Promise<number>> = {
    products: () => db.product.count({ where: { promotionStatus: PROMOTED } }),
    vendors: () => db.vendor.count({ where: { promotionStatus: PROMOTED } }),
    // Integrations are promoted transitively: both endpoints must be promoted —
    // the same filter the bulk sync uploads on (`./algolia-bulk-sync`).
    integrations: () =>
      db.integration.count({
        where: {
          sourceProduct: { promotionStatus: PROMOTED },
          targetProduct: { promotionStatus: PROMOTED },
        },
      }),
  };

  const rows: AlgoliaIndexDrift[] = [];
  for (const entity of INDEX_ENTITIES) {
    const indexName = names[entity];
    const database = await databaseCount[entity]();
    const algoliaCount = await algolia.countObjects(indexName);
    rows.push({
      entity,
      indexName,
      database,
      algolia: algoliaCount,
      drift: database - algoliaCount,
    });
  }
  return rows;
}

/** Render the per-index counts as a fixed-width table for CLI / cron logs. */
export function formatDriftTable(rows: AlgoliaIndexDrift[]): string {
  const header = 'entity        index                      database   algolia      drift';
  const lines = rows.map(
    (r) =>
      `${r.entity.padEnd(12)}  ${r.indexName.padEnd(24)}  ${String(r.database).padStart(8)}  ${String(
        r.algolia,
      ).padStart(8)}  ${String(r.drift).padStart(9)}`,
  );
  return [header, ...lines].join('\n');
}

export type AlgoliaDriftDeps = {
  db: DriftCount;
  algolia: AlgoliaCountClient;
  /** Called once per entity (always, 0 when clean) so a no-data monitor can tell
   *  "ran clean" from "didn't run". Value is the signed `drift`. */
  emitGauge: (row: AlgoliaIndexDrift) => void;
  /** Called once with the drifted rows when any index mismatches. */
  onDrift?: (drifted: AlgoliaIndexDrift[]) => void;
  /** Defaults to `console`. Tests inject a recorder. */
  log?: Pick<Console, 'log' | 'warn'>;
};

/**
 * Orchestration shared by the cron and the CLI: run the comparison, emit a gauge
 * per entity, log the table, and surface any drift via `onDrift`. The emit + log
 * sinks are injected so this stays Worker/Node-agnostic and unit-testable — the
 * Worker emits through the shared Datadog client, the CLI through a raw fetch.
 * Returns every row (drifted or not).
 */
export async function reportAlgoliaDrift(
  deps: AlgoliaDriftDeps,
  opts: { env: AlgoliaEnv; locale?: string },
): Promise<AlgoliaIndexDrift[]> {
  const log = deps.log ?? console;
  const locale = opts.locale ?? DEFAULT_LOCALE;

  const rows = await findAlgoliaIndexDrift({ db: deps.db, algolia: deps.algolia }, opts);

  for (const row of rows) deps.emitGauge(row);

  const drifted = rows.filter((r) => r.drift !== 0);
  log.log(`Algolia index drift — env=${opts.env}, locale=${locale}:`);
  log.log(formatDriftTable(rows));
  if (drifted.length > 0) {
    log.warn(
      `✗ ${drifted.length} index(es) drifted: ${drifted
        .map((r) => `${r.indexName} (${r.drift > 0 ? '+' : ''}${r.drift})`)
        .join(', ')}. Report-only — re-run the bulk sync to repair.`,
    );
    deps.onDrift?.(drifted);
  } else {
    log.log('✓ No Algolia index drift — every index matches its promoted D1 rows.');
  }
  return rows;
}
