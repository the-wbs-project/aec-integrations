/**
 * Query layer for the connector admin surface (AECI-722 —
 * `docs/ADMIN_PANEL_SPEC.md` §5.9), over the six AECI-714 tables
 * (`docs/DATABASE_SCHEMA.md` §9a).
 *
 * Everything here READS. The lane's only writers are
 * `POST /api/promote/connector-catalog` (the sync) and AECI-720's `managed_by`
 * flip; `packages/shared/src/api/admin-connectors.ts` records why an AECi-side
 * mapping write is not one of them.
 *
 * ── WHY TALLIES ARE GROUP-BYs AND NOT CORRELATED SUBQUERIES ─────────────────
 * `vendorListConfig.extras` proves correlated scalar subqueries are fine for two
 * counts on a 100-row page. This surface needs FOURTEEN per catalogue, and five
 * of them are per-status splits. Fourteen correlated subqueries per row is a
 * different animal, so {@link collectCounts} instead runs six GROUP-BY passes
 * over the page's ids in ONE `db.batch` and stitches in JS — bounded by the page
 * size, not by catalogue size.
 *
 * Two D1 limits shape this and neither is the one people expect:
 *
 *  - **`SQLITE_MAX_COMPOUND_SELECT` is 5 on D1** against better-sqlite3's 500
 *    (`TESTING_STRATEGY.md` §6.3 — the trap that 500'd `/admin/system` after
 *    every unit test passed). Nothing here is a compound `UNION`; the tallies are
 *    separate statements in a batch precisely so they never become one.
 *  - **Bound parameters are capped per query, not per statement count.** The `IN`
 *    lists are page-bounded (≤100 ids), so they stay well inside it. Where an id
 *    set could be unbounded it is expressed as a subquery instead, the same rule
 *    `admin-vendors.ts` states for its actor scope.
 */

import {
  CONNECTOR_AUTO_DECIDER,
  type AdminConnectorCounts,
  type AdminConnectorMapping,
  type AdminConnectorStubState,
} from '@aeci/shared';
import { and, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  connectorCatalogSurfaces,
  connectorEvidencedPairs,
  connectorPairs,
  connectorStubMappings,
  connectorStubs,
} from '../db/schema';

import { likeContains } from './sql-like';

/** An empty tally, so a catalogue with no rows reports zeros rather than gaps. */
export function emptyCounts(): AdminConnectorCounts {
  return {
    surfaces: 0,
    stubs_total: 0,
    stubs_removed: 0,
    stubs_undecided: 0,
    mappings_mapped: 0,
    mappings_ruled_out: 0,
    mappings_out_of_scope: 0,
    mappings_no_record: 0,
    mappings_ambiguous_parked: 0,
    mappings_publishable: 0,
    pairs_curated: 0,
    pairs_generated: 0,
    pairs_unknown: 0,
    evidenced_pairs: 0,
  };
}

/**
 * §9a.4's publication gate, as SQL, in ONE place.
 *
 * `status = 'mapped' AND product_id IS NOT NULL AND decided_by IS NOT NULL AND
 * decided_by <> 'auto-name-match'`.
 *
 * **Provenance, never confidence.** §9a.4 is explicit that gating on
 * `confidence` would publish hundreds of machine guesses sitting at `medium`.
 * Exported so the per-row `publishable` flag and the `mappings_publishable`
 * tally are provably the same predicate — the UI never re-implements it, which
 * is the failure mode a second copy invites.
 */
export const publishableMapping: SQL = and(
  eq(connectorStubMappings.status, 'mapped'),
  isNotNull(connectorStubMappings.productId),
  isNotNull(connectorStubMappings.decidedBy),
  ne(connectorStubMappings.decidedBy, CONNECTOR_AUTO_DECIDER),
) as SQL;

/** The same predicate evaluated in JS, for rows already in memory. */
export function isPublishable(m: {
  status: string;
  productId: string | null;
  decidedBy: string | null;
}): boolean {
  return (
    m.status === 'mapped' &&
    m.productId !== null &&
    m.decidedBy !== null &&
    m.decidedBy !== CONNECTOR_AUTO_DECIDER
  );
}

const MAPPING_STATUS_KEYS: Record<string, keyof AdminConnectorCounts> = {
  mapped: 'mappings_mapped',
  ruled_out: 'mappings_ruled_out',
  out_of_scope: 'mappings_out_of_scope',
  no_record: 'mappings_no_record',
  ambiguous_parked: 'mappings_ambiguous_parked',
};

const PAIR_SURFACE_KEYS: Record<string, keyof AdminConnectorCounts> = {
  curated: 'pairs_curated',
  generated: 'pairs_generated',
  unknown: 'pairs_unknown',
};

/**
 * Tallies + freshness for a page of catalogues, in one batch.
 *
 * `connectorProductIds` is separate because `connector_evidenced_pairs` keys on
 * the PRODUCT, not the catalogue — it has no `catalog_id` at all, being the one
 * table with no review-side counterpart (§9a.6).
 *
 * Returns a map keyed by catalogue id, plus the per-catalogue MAX ingest stamp.
 */
export async function collectCounts(
  db: Db,
  catalogIds: readonly string[],
  connectorProductIdByCatalog: ReadonlyMap<string, string>,
): Promise<Map<string, { counts: AdminConnectorCounts; lastIngestedAt: string | null }>> {
  const out = new Map<string, { counts: AdminConnectorCounts; lastIngestedAt: string | null }>();
  for (const id of catalogIds) out.set(id, { counts: emptyCounts(), lastIngestedAt: null });
  if (catalogIds.length === 0) return out;

  const productIds = [...new Set(connectorProductIdByCatalog.values())];
  const ids = [...catalogIds];

  const [surfaceRows, stubRows, undecidedRows, mappingRows, pairRows, evidencedRows] =
    await db.batch([
      db
        .select({
          catalogId: connectorCatalogSurfaces.catalogId,
          total: sql<number>`count(*)`,
          // MAX over a nullable ISO-8601 TEXT column. SQLite's MAX ignores NULLs,
          // so a catalogue with one ingested surface and three never-ingested ones
          // reports the real stamp rather than null — which is the honest reading:
          // the feed HAS delivered, just not on every surface.
          lastIngestedAt: sql<string | null>`max(${connectorCatalogSurfaces.lastIngestedAt})`,
        })
        .from(connectorCatalogSurfaces)
        .where(inArray(connectorCatalogSurfaces.catalogId, ids))
        .groupBy(connectorCatalogSurfaces.catalogId),

      db
        .select({
          catalogId: connectorStubs.catalogId,
          total: sql<number>`count(*)`,
          removed: sql<number>`sum(case when ${connectorStubs.removedAt} is not null then 1 else 0 end)`,
        })
        .from(connectorStubs)
        .where(inArray(connectorStubs.catalogId, ids))
        .groupBy(connectorStubs.catalogId),

      // The undecided anti-join. §9a.4: "there is no `pending` status — the
      // absence of a row is pending." So this is a LEFT JOIN ... IS NULL and not
      // a status count, and it is the number the triage queue burns down.
      db
        .select({
          catalogId: connectorStubs.catalogId,
          total: sql<number>`count(*)`,
        })
        .from(connectorStubs)
        .leftJoin(connectorStubMappings, eq(connectorStubMappings.stubId, connectorStubs.id))
        .where(and(inArray(connectorStubs.catalogId, ids), isNull(connectorStubMappings.id)))
        .groupBy(connectorStubs.catalogId),

      // Rides `connector_stub_mappings_status_idx (catalog_id, status)`, which
      // §9a.4 says exists for exactly this GROUP BY — and is why `catalog_id` is
      // denormalised onto the mapping at all rather than joined back through the
      // stub.
      db
        .select({
          catalogId: connectorStubMappings.catalogId,
          status: connectorStubMappings.status,
          total: sql<number>`count(*)`,
          publishable: sql<number>`sum(case when ${publishableMapping} then 1 else 0 end)`,
        })
        .from(connectorStubMappings)
        .where(inArray(connectorStubMappings.catalogId, ids))
        .groupBy(connectorStubMappings.catalogId, connectorStubMappings.status),

      db
        .select({
          catalogId: connectorPairs.catalogId,
          surface: connectorPairs.surface,
          total: sql<number>`count(*)`,
        })
        .from(connectorPairs)
        .where(inArray(connectorPairs.catalogId, ids))
        .groupBy(connectorPairs.catalogId, connectorPairs.surface),

      db
        .select({
          connectorProductId: connectorEvidencedPairs.connectorProductId,
          total: sql<number>`count(*)`,
        })
        .from(connectorEvidencedPairs)
        .where(
          productIds.length > 0
            ? inArray(connectorEvidencedPairs.connectorProductId, productIds)
            : sql`1 = 0`,
        )
        .groupBy(connectorEvidencedPairs.connectorProductId),
    ]);

  for (const r of surfaceRows) {
    const e = out.get(r.catalogId);
    if (!e) continue;
    e.counts.surfaces = Number(r.total ?? 0);
    e.lastIngestedAt = r.lastIngestedAt ?? null;
  }
  for (const r of stubRows) {
    const e = out.get(r.catalogId);
    if (!e) continue;
    e.counts.stubs_total = Number(r.total ?? 0);
    e.counts.stubs_removed = Number(r.removed ?? 0);
  }
  for (const r of undecidedRows) {
    const e = out.get(r.catalogId);
    if (e) e.counts.stubs_undecided = Number(r.total ?? 0);
  }
  for (const r of mappingRows) {
    const e = out.get(r.catalogId);
    if (!e) continue;
    const key = MAPPING_STATUS_KEYS[r.status];
    // An unrecognized status is skipped rather than crashing the page. The CHECK
    // makes it unreachable today; a CHECK change is a destructive D1 recreate, so
    // this stays tolerant on the same reasoning `AdminAuditRow` renders tolerantly.
    if (key) e.counts[key] = Number(r.total ?? 0);
    e.counts.mappings_publishable += Number(r.publishable ?? 0);
  }
  for (const r of pairRows) {
    const e = out.get(r.catalogId);
    if (!e) continue;
    const key = PAIR_SURFACE_KEYS[r.surface];
    if (key) e.counts[key] = Number(r.total ?? 0);
  }
  const evidencedByProduct = new Map(
    evidencedRows.map((r) => [r.connectorProductId, Number(r.total ?? 0)]),
  );
  for (const [catalogId, productId] of connectorProductIdByCatalog) {
    const e = out.get(catalogId);
    if (e) e.counts.evidenced_pairs = evidencedByProduct.get(productId) ?? 0;
  }

  return out;
}

/**
 * The `WHERE` for one stub-triage filter set.
 *
 * Every mapping-shaped filter is an `EXISTS` over `connector_stub_mappings`
 * rather than a join, for one reason worth stating: a stub may carry SEVERAL
 * mappings (§9a.4's many-to-many), so a join would return the same stub once per
 * matching mapping and quietly corrupt both the page and its `total`.
 *
 * `undecided` inverts to `NOT EXISTS` — the absence of a row, not a status.
 */
export function stubFilterWhere(
  catalogId: string,
  filters: {
    state?: AdminConnectorStubState;
    proposalsOnly?: boolean;
    confidence?: 'low' | 'medium' | 'high';
    search?: string;
    includeRemoved?: boolean;
  },
): SQL | undefined {
  const mappingExists = (extra?: SQL): SQL =>
    sql`exists (select 1 from ${connectorStubMappings} where ${connectorStubMappings.stubId} = ${connectorStubs.id}${
      extra ? sql` and ${extra}` : sql``
    })`;

  const parts: (SQL | undefined)[] = [eq(connectorStubs.catalogId, catalogId)];

  // A tombstoned listing is not triage, so it is hidden unless asked for.
  if (!filters.includeRemoved) parts.push(isNull(connectorStubs.removedAt));

  if (filters.state === 'undecided') {
    parts.push(
      sql`not exists (select 1 from ${connectorStubMappings} where ${connectorStubMappings.stubId} = ${connectorStubs.id})`,
    );
  } else if (filters.state) {
    parts.push(mappingExists(eq(connectorStubMappings.status, filters.state)));
  }

  if (filters.proposalsOnly) {
    parts.push(mappingExists(eq(connectorStubMappings.decidedBy, CONNECTOR_AUTO_DECIDER)));
  }
  if (filters.confidence) {
    parts.push(mappingExists(eq(connectorStubMappings.confidence, filters.confidence)));
  }

  const search = filters.search?.trim();
  if (search) {
    parts.push(
      or(likeContains(connectorStubs.slug, search), likeContains(connectorStubs.label, search)),
    );
  }

  return and(...parts);
}

/** Shape a mapping row for the wire, deriving `publishable` from the one predicate. */
export function toMapping(
  row: {
    id: string;
    status: string;
    productId: string | null;
    confidence: string | null;
    evidenceUrl: string | null;
    decidedBy: string | null;
    decidedAt: string | null;
    checkedAt: string | null;
    notes: string | null;
  },
  products: ReadonlyMap<string, { id: string; name: string; slug: string }>,
): AdminConnectorMapping {
  return {
    id: row.id,
    status: row.status as AdminConnectorMapping['status'],
    product: row.productId ? (products.get(row.productId) ?? null) : null,
    confidence: (row.confidence as AdminConnectorMapping['confidence']) ?? null,
    evidence_url: row.evidenceUrl ?? null,
    decided_by: row.decidedBy ?? null,
    decided_at: row.decidedAt ?? null,
    checked_at: row.checkedAt ?? null,
    notes: row.notes ?? null,
    publishable: isPublishable(row),
  };
}

/**
 * Pick the mapping that represents a stub on a pair row.
 *
 * A stub can map to several of our products (MindCloud's single `adp` listing is
 * ADP Workforce Now and every edition built within it), but a pair row has one
 * cell per side. Preference order: a mapping that clears the publication gate,
 * then any `mapped` row naming a product, then nothing. Ordering by gate rather
 * than by recency means the cell answers the question the pairs view is actually
 * asking — "would this side clear publication?" — instead of showing whichever
 * row happened to be written last.
 */
export function representativeMapping<
  T extends { status: string; productId: string | null; decidedBy: string | null },
>(mappings: readonly T[]): T | null {
  return (
    mappings.find((m) => isPublishable(m)) ??
    mappings.find((m) => m.status === 'mapped' && m.productId !== null) ??
    null
  );
}
