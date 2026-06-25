/**
 * Algolia orphan sweep — the remediation half of the §23.1 index-drift check
 * (AECI-266; companion to `./algolia-drift`).
 *
 * The incremental sync (`./algolia-sync`) reads D1 and can only ADD a record or
 * FLIP one out when its `promotion_status` changes — it never sees a row that is
 * ABSENT from D1 (hard-deleted, or stranded by the Supabase→D1 cutover, ADR
 * 0016), so such records stay searchable forever (search reads Algolia) while
 * 404ing on click (detail reads D1). This module is the backstop: it enumerates
 * every objectID in an index, diffs it against the authoritative promoted-id SET
 * from D1, and deletes the difference. The promoted-id set becomes the index's
 * authoritative membership; objects with no matching promoted D1 row are removed.
 *
 * Delete-only by design. It fixes NEGATIVE drift (orphans / extra objects). It
 * deliberately does NOT re-upsert to fix positive drift (records missing from the
 * index) — that stays owned by the incremental sync's epoch/window upsert
 * (`./algolia-sync`). Keeping it delete-only means it needs only D1 ID SETS, never
 * the rich Drizzle relational configs + record transforms — so it stays
 * dependency-free and ADR-0016-safe (no duplicated query/transform logic).
 *
 * Dependency-injected, exactly like `./algolia-drift`: this module imports neither
 * a database client nor `algoliasearch`, so it unit-tests with fakes and is safe
 * to bundle into the API Worker (the 09:00 drift cron, `apps/api/src/scheduled.ts`)
 * AND to run from Node (the operator CLI, `scripts/reconcile-algolia-drift.ts`).
 * The Worker wires a Drizzle/D1-backed id provider; the CLI wires a
 * `wrangler d1 execute` one. Both share this tested core and the fetch-based
 * browse/delete clients below.
 *
 * objectID == the row `id` for all three entities (`./algolia-transforms`), so the
 * orphan diff is a pure string-set difference. Replicas are NOT swept — deletes on
 * the primary auto-propagate to its sort replicas.
 *
 * Spec: `STAGE_1_SPEC.md` §23.1; cross-ref §20.5.
 */

import {
  ALGOLIA_BATCH_MAX,
  callAlgoliaBatch,
  type AlgoliaBatchCredentials,
  type AlgoliaBatchOutcome,
} from '@aeci/shared/algolia-batch';
import {
  DEFAULT_LOCALE,
  INDEX_ENTITIES,
  localizedIndexNamesFor,
  type AlgoliaEnv,
  type IndexEntity,
} from '@aeci/shared/algolia';

/**
 * The authoritative D1 membership id-sets, one per entity. Mirrors the shape of
 * `DriftCount` (`./algolia-drift`) but returns id SETS rather than counts.
 * `integrationIds` is the transitive set — integrations whose BOTH endpoints are
 * promoted (the same membership `./algolia-sync` indexes on). Injected so the lib
 * stays ORM-agnostic; the Worker wires a Drizzle adapter, the CLI a wrangler one.
 */
export type PromotedIdProvider = {
  productIds(): Promise<Set<string>>;
  vendorIds(): Promise<Set<string>>;
  integrationIds(): Promise<Set<string>>;
};

/**
 * Minimal Algolia read surface: every objectID currently in one index.
 * `createAlgoliaObjectIdClient` is the fetch-based production impl (browse with
 * cursor pagination). Injected so the lib stays dependency-free and unit-tests
 * with a fake.
 */
export type AlgoliaObjectIdClient = {
  enumerateObjectIDs(indexName: string): Promise<string[]>;
};

/**
 * Minimal Algolia write surface: delete a set of objectIDs from one index.
 * `createAlgoliaDeleteClient` wraps the shared `callAlgoliaBatch` (`deleteObject`
 * action, chunked to `ALGOLIA_BATCH_MAX`). Returns the (last) batch outcome so the
 * caller can record a partial failure.
 */
export type AlgoliaDeleteClient = {
  deleteObjects(indexName: string, objectIDs: string[]): Promise<AlgoliaBatchOutcome>;
};

/**
 * Destructive-action guard. Auto-deleting from a live search index is dangerous:
 * a misconfigured / empty `PromotedIdProvider` (wrong DB, wrong env, a SQL error
 * returning `[]`) would make EVERY index object look like an orphan and nuke the
 * index. The sweep refuses to delete more than `maxDeletes` objects OR more than
 * `maxFraction` of an index in one pass unless `override` is set. The unattended
 * cron always runs with `override:false`; the operator CLI sets it via `--force`.
 */
export type SafetyCap = {
  /** Absolute ceiling on objects deleted from one index in a single pass. */
  maxDeletes: number;
  /** Fractional ceiling (0–1): refuse if `orphans / indexCount` exceeds this. */
  maxFraction: number;
  /** Explicit opt-out for a legitimate large purge. */
  override: boolean;
};

/** Conservative default: ≤50 objects and ≤20% of an index per pass. The
 *  Fixture-Procore case (3 orphans) clears both; an empty-D1 read (100%) is
 *  refused. */
export const DEFAULT_SAFETY_CAP: SafetyCap = { maxDeletes: 50, maxFraction: 0.2, override: false };

/** Per-entity, per-index sweep outcome. */
export type EntityOrphanResult = {
  entity: IndexEntity;
  indexName: string;
  /** objectIDs browsed from the index. */
  indexCount: number;
  /** Authoritative promoted-id set size from D1. */
  promotedCount: number;
  /** objectIDs in the index with no matching promoted D1 row (`index − D1`). */
  orphanIds: string[];
  /** Orphans actually removed (0 on dry-run, when capped, or on a delete error). */
  deleted: number;
  /** True when the safety cap refused a deletion this pass. */
  skippedBySafetyCap: boolean;
  ok: boolean;
  error?: string;
};

export type OrphanSweepResult = {
  env: AlgoliaEnv;
  locale: string;
  entities: EntityOrphanResult[];
  totalOrphans: number;
  totalDeleted: number;
};

export type OrphanSweepOptions = {
  env: AlgoliaEnv;
  /** Defaults to `en-US` (the bare `<prefix>_<entity>` index set). */
  locale?: string;
  /** `false` = dry-run: compute orphans, delete nothing. `true` = remove them. */
  apply: boolean;
  /** Defaults to `DEFAULT_SAFETY_CAP`. */
  safetyCap?: SafetyCap;
};

export type OrphanSweepDeps = {
  ids: PromotedIdProvider;
  browse: AlgoliaObjectIdClient;
  remove: AlgoliaDeleteClient;
  /** Called once per entity (always) with its result, so the caller can emit
   *  `aeci.algolia.orphans_removed` / `aeci.algolia.orphans_skipped_cap`. */
  emit?: (result: EntityOrphanResult) => void;
  /** Defaults to `console`. Tests inject a recorder. */
  log?: Pick<Console, 'log' | 'warn'>;
};

/**
 * Sweep one entity's index: browse its objectIDs, diff against the authoritative
 * promoted-id set, and (when `apply` and under the safety cap) delete the orphans.
 * Never throws — a browse/delete failure is captured as `{ ok:false, error }` so
 * the remaining entities still process and no delete is issued for the failed one.
 */
async function sweepEntity(
  deps: OrphanSweepDeps,
  entity: IndexEntity,
  indexName: string,
  promotedIds: () => Promise<Set<string>>,
  apply: boolean,
  cap: SafetyCap,
  log: Pick<Console, 'log' | 'warn'>,
): Promise<EntityOrphanResult> {
  const base: EntityOrphanResult = {
    entity,
    indexName,
    indexCount: 0,
    promotedCount: 0,
    orphanIds: [],
    deleted: 0,
    skippedBySafetyCap: false,
    ok: true,
  };
  try {
    // Browse FIRST, then read the D1 promoted set. A record promoted between the
    // two reads lands in the promoted set (→ not an orphan); a record removed from
    // D1 after the browse is a genuine orphan (→ correctly deleted). This ordering
    // is load-bearing for minimizing false-positive deletes.
    const indexIds = await deps.browse.enumerateObjectIDs(indexName);
    const promotedSet = await promotedIds();
    const indexCount = indexIds.length;
    const promotedCount = promotedSet.size;

    // Empty index → nothing to diff or delete (also avoids a divide-by-zero in the
    // fractional cap below).
    if (indexCount === 0) return { ...base, indexCount, promotedCount };

    const orphanIds = indexIds.filter((id) => !promotedSet.has(id));
    const result: EntityOrphanResult = { ...base, indexCount, promotedCount, orphanIds };

    // Dry-run, or nothing to remove: report the computed orphans, delete nothing.
    if (!apply || orphanIds.length === 0) return result;

    // Safety cap — gates actual deletion only.
    const overAbsolute = orphanIds.length > cap.maxDeletes;
    const overFraction = orphanIds.length / indexCount > cap.maxFraction;
    if ((overAbsolute || overFraction) && !cap.override) {
      log.warn(
        `algolia-orphans: REFUSING to delete ${orphanIds.length}/${indexCount} object(s) from "${indexName}" — exceeds safety cap (max ${cap.maxDeletes} or ${Math.round(
          cap.maxFraction * 100,
        )}% of the index). Re-run with --force / override if this is an intended large purge.`,
      );
      return { ...result, skippedBySafetyCap: true };
    }

    const outcome = await deps.remove.deleteObjects(indexName, orphanIds);
    if (!outcome.ok) return { ...result, ok: false, error: outcome.message };
    return { ...result, deleted: orphanIds.length };
  } catch (error) {
    return { ...base, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Sweep orphans across all three entity indexes for `env`/`locale`. Returns one
 * result per entity (in `INDEX_ENTITIES` order). Read-only when `apply:false`.
 * Replicas are not iterated (deletes propagate to them). Never throws.
 */
export async function sweepAlgoliaOrphans(
  deps: OrphanSweepDeps,
  opts: OrphanSweepOptions,
): Promise<OrphanSweepResult> {
  const log = deps.log ?? console;
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const cap = opts.safetyCap ?? DEFAULT_SAFETY_CAP;
  const names = localizedIndexNamesFor(opts.env, locale);

  const promotedFor: Record<IndexEntity, () => Promise<Set<string>>> = {
    products: () => deps.ids.productIds(),
    vendors: () => deps.ids.vendorIds(),
    integrations: () => deps.ids.integrationIds(),
  };

  const entities: EntityOrphanResult[] = [];
  for (const entity of INDEX_ENTITIES) {
    const result = await sweepEntity(
      deps,
      entity,
      names[entity],
      promotedFor[entity],
      opts.apply,
      cap,
      log,
    );
    entities.push(result);
    deps.emit?.(result);
  }

  const totalOrphans = entities.reduce((n, e) => n + e.orphanIds.length, 0);
  const totalDeleted = entities.reduce((n, e) => n + e.deleted, 0);
  return { env: opts.env, locale, entities, totalOrphans, totalDeleted };
}

/** Render the per-entity sweep as a fixed-width table for CLI / cron logs. */
export function formatOrphanTable(result: OrphanSweepResult): string {
  const header = 'entity        index                      indexed   promoted   orphans   deleted';
  const lines = result.entities.map((e) => {
    const flag = e.skippedBySafetyCap ? ' (capped)' : e.ok ? '' : ` (error: ${e.error})`;
    return `${e.entity.padEnd(12)}  ${e.indexName.padEnd(24)}  ${String(e.indexCount).padStart(7)}  ${String(
      e.promotedCount,
    ).padStart(
      8,
    )}  ${String(e.orphanIds.length).padStart(7)}  ${String(e.deleted).padStart(7)}${flag}`;
  });
  return [header, ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// Fetch-based production clients (dependency-free; run in the Worker and Node)
// ---------------------------------------------------------------------------

/**
 * Fetch-based objectID enumerator — browses an index with cursor pagination, so
 * it returns EVERY objectID regardless of the 1000-hit search ceiling (browse is
 * the deep-pagination primitive). Reads `objectID` only. Reads via the `-dsn`
 * host with the per-env MANAGEMENT key (same host/key the drift counter uses).
 * Throws on a non-2xx so a misconfig / missing index is distinguishable from a
 * genuinely empty index (and the sweep aborts that entity rather than treating it
 * as "0 objects").
 *
 * Browse contract: the first request carries the query params; once a `cursor` is
 * returned, subsequent requests send ONLY `{ cursor }` (it encodes the query).
 */
export function createAlgoliaObjectIdClient(appId: string, apiKey: string): AlgoliaObjectIdClient {
  return {
    async enumerateObjectIDs(indexName: string): Promise<string[]> {
      const url = `https://${appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(indexName)}/browse`;
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const body: Record<string, unknown> = cursor
          ? { cursor }
          : { attributesToRetrieve: ['objectID'], hitsPerPage: 1000 };
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Algolia-Application-Id': appId,
            'X-Algolia-API-Key': apiKey,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(
            `Algolia browse failed for index "${indexName}": HTTP ${res.status}${
              detail ? ` — ${detail.slice(0, 200)}` : ''
            }`,
          );
        }
        const page = (await res.json()) as {
          hits?: Array<{ objectID?: unknown }>;
          cursor?: unknown;
        };
        for (const hit of page.hits ?? []) {
          if (typeof hit.objectID === 'string') ids.push(hit.objectID);
        }
        cursor = typeof page.cursor === 'string' ? page.cursor : undefined;
      } while (cursor);
      return ids;
    },
  };
}

/**
 * Fetch-based delete client — wraps the shared `callAlgoliaBatch` (`deleteObject`
 * action) and chunks to `ALGOLIA_BATCH_MAX`. `fetchImpl` is injectable (defaults
 * to the global `fetch`). Stops at the first failed chunk and returns its outcome.
 */
export function createAlgoliaDeleteClient(
  creds: AlgoliaBatchCredentials,
  fetchImpl: typeof fetch = fetch,
): AlgoliaDeleteClient {
  return {
    async deleteObjects(indexName: string, objectIDs: string[]): Promise<AlgoliaBatchOutcome> {
      let outcome: AlgoliaBatchOutcome = { ok: true, status: 0 };
      for (let i = 0; i < objectIDs.length; i += ALGOLIA_BATCH_MAX) {
        const chunk = objectIDs
          .slice(i, i + ALGOLIA_BATCH_MAX)
          .map((id) => ({ action: 'deleteObject' as const, body: { objectID: id } }));
        outcome = await callAlgoliaBatch(fetchImpl, creds, indexName, chunk);
        if (!outcome.ok) return outcome;
      }
      return outcome;
    },
  };
}
