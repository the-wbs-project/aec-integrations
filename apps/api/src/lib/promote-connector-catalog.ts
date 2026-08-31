/**
 * The connector-catalogue page ingest (AECI-714 / `STAGE_1_5_SPEC.md` §13).
 *
 * A PLANNER, in the same shape as `./promote-claims.ts`: it reads, decides, and
 * returns statements — it executes nothing. The caller splices the plan into the one
 * `db.batch` the ADR 0021 commit step owns, so every row this page writes and its
 * single `audit_log` row commit or roll back together (§26.1).
 *
 * ── WHY EVERY STATEMENT IS AN UPSERT ────────────────────────────────────────
 * A catalogue is 3,573 stubs today and ~15k once Zapier lands, so it arrives PAGED
 * and the pages are not atomic with each other — one `promote_jobs` ledger row
 * protects one commit, not N. Whole-page idempotence is therefore the only
 * correctness property available across pages, and it is bought by keying every
 * table on the review app's own record id: each statement is
 * `onConflictDoUpdate({ target: <table>.id })`, so re-sending a page is harmless.
 *
 * ── WHY UNCHANGED ROWS EMIT NO STATEMENT ────────────────────────────────────
 * The pre-read below is not only for foreign-key resolution; it computes
 * created/updated/unchanged, which lets an unchanged row be dropped from the batch
 * entirely. That is what makes a full-mirror re-sync of a 15k-row catalogue free
 * rather than 15k writes, and it is what lets the audit row obey
 * `./retention-prune.ts`'s rule 4 — **a run that changes nothing writes no audit
 * row.** `audit_log` is indefinite-retention (§26.6), so a scheduled re-sync would
 * otherwise deposit thousands of "nothing happened" rows a week into the one table
 * nothing prunes.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ───────────────────────────────
 * No count is recomputed, no index is touched, no cache tag is emitted. §13.5 is
 * categorical: *"Reachable never counts — not in the heading, not in
 * `integration_count`, not in a facet, not in the home stats."* Nothing renders this
 * data until AECI-715 / 716 / 722, and `connector_evidenced_pairs` — the delivered
 * tier — is never written here at all: it is AECI-721's, and the review app has no
 * such table to project.
 */

import type {
  AuditLogEntry,
  PromoteConnectorMapping,
  PromoteConnectorPagePayload,
  PromoteConnectorPageResponse,
  PromoteConnectorPair,
  PromoteConnectorStub,
  PromoteConnectorSurface,
  PromoteConnectorTableCounts,
  PromoteSkipped,
} from '@aeci/shared';
import { ApiErrorCode, CONNECTOR_DECISION_STATUSES } from '@aeci/shared';
import { eq, inArray } from 'drizzle-orm';

import type { Db } from '../db/client';
import { ApiError } from '../errors';
import {
  connectorCatalogs,
  connectorCatalogSurfaces,
  connectorPairs,
  connectorStubMappings,
  connectorStubs,
  products,
} from '../db/schema';
import type { BatchStmt, BatchTuple } from './audit';
import { chunked } from './promote-claims';

/** Reasons that reach `skipped[]`. Constants so the specs assert the same strings. */
export const SKIP_CONNECTOR_UNPROMOTED =
  'the connector platform for this catalogue is not promoted yet';
export const SKIP_MAPPING_PRODUCT_UNPROMOTED =
  'the mapped product is not promoted yet (send the mapping again once it is)';
export const SKIP_MISSING_STUB =
  'references a stub that is neither on this page nor already stored (send the stub page first)';

/** The plan, mirroring `ClaimIngestPlan` so both ingests read and splice alike. */
export interface ConnectorPagePlan {
  /** FK-safe by construction — see {@link planConnectorCatalogPage}'s ordering note. */
  statements: BatchStmt[];
  /** Zero or one entry: the summary row. An array so the caller's `audit()` wrapper
   *  and batch splice are identical to the claims path. */
  audits: AuditLogEntry[];
  skipped: PromoteSkipped[];
  counts: PromoteConnectorPageResponse['counts'];
  /** False when nothing changed. Gates the audit row and the caller's `wrote`. */
  wrote: boolean;
}

function emptyCounts(): PromoteConnectorTableCounts {
  return { created: 0, updated: 0, unchanged: 0, deleted: 0, skipped: 0 };
}

/** Normalise `undefined` (absent on the wire) and `null` (stored) to one value, so
 *  change detection does not report a difference that does not exist. */
function norm(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  // JSON columns come back parsed; compare them structurally. The review app emits a
  // stable serialisation, so key order is not a source of false positives.
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/** True when every projected column already holds the incoming value. */
function unchanged(existing: Record<string, unknown>, incoming: Record<string, unknown>): boolean {
  return Object.keys(incoming).every((k) => norm(existing[k]) === norm(incoming[k]));
}

/**
 * Everything the plan needs, in ONE batched read.
 *
 * Four questions, each preventing a specific failure:
 *   1. Which of this page's rows already exist, and with what values? — the basis of
 *      created/updated/unchanged, and of dropping unchanged rows entirely.
 *   2. Which referenced products are promoted? — an unpromoted product is a skip;
 *      without this read the foreign key fails and takes the whole page down.
 *   3. Which referenced stubs exist? — pages are not atomic with each other, so a
 *      pair or mapping can legitimately name a stub a later page carries.
 *
 * Every `IN (…)` is chunked at `ID_CHUNK`: D1 caps bound parameters per statement
 * well below what SQLite allows locally, and better-sqlite3 will not reproduce the
 * failure. Batched rather than sequential for the `GET /api/vendor/updates` reason
 * (AECI-627) — one D1 round trip instead of twenty-six.
 */
async function preread(db: Db, page: PromoteConnectorPagePayload) {
  const stubIds = new Set<string>(page.stubs.map((s) => s.id));
  for (const m of page.mappings) stubIds.add(m.stubId);
  for (const p of page.pairs) {
    stubIds.add(p.stubAId);
    stubIds.add(p.stubBId);
  }
  const productIds = new Set<string>();
  if (page.catalog.connectorProductId) productIds.add(page.catalog.connectorProductId);
  for (const m of page.mappings) if (m.productId) productIds.add(m.productId);

  const groups = {
    products: chunked([...productIds]),
    stubs: chunked([...stubIds]),
    surfaces: chunked(page.surfaces.map((s) => s.id)),
    mappings: chunked(page.mappings.map((m) => m.id)),
    pairs: chunked(page.pairs.map((p) => p.id)),
  };

  const reads: BatchStmt[] = [
    db.select().from(connectorCatalogs).where(eq(connectorCatalogs.id, page.catalog.id)),
    ...groups.products.map((c) =>
      db.select({ id: products.id }).from(products).where(inArray(products.id, c)),
    ),
    ...groups.stubs.map((c) =>
      db.select().from(connectorStubs).where(inArray(connectorStubs.id, c)),
    ),
    ...groups.surfaces.map((c) =>
      db.select().from(connectorCatalogSurfaces).where(inArray(connectorCatalogSurfaces.id, c)),
    ),
    ...groups.mappings.map((c) =>
      db.select().from(connectorStubMappings).where(inArray(connectorStubMappings.id, c)),
    ),
    ...groups.pairs.map((c) =>
      db.select().from(connectorPairs).where(inArray(connectorPairs.id, c)),
    ),
  ];

  const rows = (await db.batch(reads as BatchTuple)) as Record<string, unknown>[][];

  let at = 0;
  const take = (count: number) => rows.slice(at, (at += count)).flat();
  const existingCatalog = take(1)[0];
  const promotedProducts = new Set(take(groups.products.length).map((r) => r.id as string));
  const existingStubs = new Map(take(groups.stubs.length).map((r) => [r.id as string, r]));
  const existingSurfaces = new Map(take(groups.surfaces.length).map((r) => [r.id as string, r]));
  const existingMappings = new Map(take(groups.mappings.length).map((r) => [r.id as string, r]));
  const existingPairs = new Map(take(groups.pairs.length).map((r) => [r.id as string, r]));

  return {
    existingCatalog,
    promotedProducts,
    existingStubs,
    existingSurfaces,
    existingMappings,
    existingPairs,
  };
}

/**
 * Plan one page of one catalogue.
 *
 * Statement ordering is structural rather than something each branch has to
 * remember — the arrays are built separately and concatenated at the end:
 *
 *   deletes           DELETES FIRST, and that is load-bearing rather than tidiness.
 *                     A surface re-roled `apps` → `all` upserted before the old `all`
 *                     row is deleted trips `connector_catalog_surfaces_role_idx`, and
 *                     a stub-level decision moved from one row to another trips
 *                     `connector_stub_mappings_decision_idx`. A delete only ever
 *                     targets an id the page does not re-assert, so deletes never
 *                     contend with the upserts.
 *   catalog           the FK parent of everything below, in the SAME batch — which is
 *                     what makes a page self-sufficient and order-independent.
 *   surfaces          FK → catalogs
 *   stubs             FK → catalogs
 *   mappings          FK → stubs, catalogs, products
 *   pairs             FK → catalogs, stubs
 *   [audit]           appended last by the caller, only when `wrote`
 */
export async function planConnectorCatalogPage(
  db: Db,
  page: PromoteConnectorPagePayload,
  now: string = new Date().toISOString(),
): Promise<ConnectorPagePlan> {
  const counts = {
    catalogs: emptyCounts(),
    surfaces: emptyCounts(),
    stubs: emptyCounts(),
    mappings: emptyCounts(),
    pairs: emptyCounts(),
  };
  const skipped: PromoteSkipped[] = [];
  const catalogId = page.catalog.id;

  const {
    existingCatalog,
    promotedProducts,
    existingStubs,
    existingSurfaces,
    existingMappings,
    existingPairs,
  } = await preread(db, page);

  // ── the AECI-720 cutoff ────────────────────────────────────────────────────
  // A vendor-managed catalogue is frozen to the review lane: refuse the whole page.
  //
  // ORDERING IS LOAD-BEARING — this runs BEFORE the unpromoted-connector skip below,
  // not after. A vendor-managed catalogue whose platform happens to be unpromoted
  // (Zapier and Workato are `on_hold` review-side, AECI-700 — the live case) would
  // otherwise come back as a re-sendable `skipped[]` entry, telling the caller "try
  // again later" when the answer is permanently no. A policy refusal must not depend on
  // unrelated resolution state.
  //
  // It is a THROW and not a skip for the same reason: `REVIEW_APP_PROMOTE_API.md` §3a
  // binds all four connector skip kinds to *"this could not be resolved yet"* and
  // *"all four are re-sendable"*, and this is neither. Throwing here — before a single
  // statement is built — is also what makes the refusal write nothing: no rows, no
  // `promote_jobs` ledger row, and no `audit_log` row, because nothing changed.
  //
  // Refusing the PAGE is complete cover. Every child row below binds the page-level
  // `catalogId` rather than a caller-supplied one (and `mappings[].catalogId` is
  // deliberately not on the wire), so one page can only ever write one catalogue's rows.
  if (existingCatalog?.['managedBy'] === 'vendor') {
    throw new ApiError(
      409,
      ApiErrorCode.CATALOG_VENDOR_MANAGED,
      `Connector catalogue "${catalogId}" is vendor-managed on AECi; the review lane is ` +
        `frozen for it and this page was not written. Re-sending will not help. If the ` +
        `catalogue should return to review authorship, an AECi operator flips it back ` +
        `via PATCH /api/admin/connector-catalogs/:id.`,
    );
  }

  // A catalogue whose connector platform is not promoted cannot be stored at all —
  // `connector_product_id` is NOT NULL. Zapier and Workato are `on_hold` review-side
  // (AECI-700), so this is the live case, not a hypothetical. The whole page is
  // reported and dropped: not an error, and nothing is half-written.
  const connectorProductId = page.catalog.connectorProductId;
  if (!connectorProductId || !promotedProducts.has(connectorProductId)) {
    skipped.push({ ref: catalogId, kind: 'connector-catalog', reason: SKIP_CONNECTOR_UNPROMOTED });
    counts.catalogs.skipped = 1;
    counts.surfaces.skipped = page.surfaces.length;
    counts.stubs.skipped = page.stubs.length;
    counts.mappings.skipped = page.mappings.length;
    counts.pairs.skipped = page.pairs.length;
    return { statements: [], audits: [], skipped, counts, wrote: false };
  }

  const deletes: BatchStmt[] = [];
  const upserts: BatchStmt[] = [];

  for (const ids of chunked(page.deleted?.mappings ?? [])) {
    deletes.push(db.delete(connectorStubMappings).where(inArray(connectorStubMappings.id, ids)));
    counts.mappings.deleted += ids.length;
  }
  for (const ids of chunked(page.deleted?.surfaces ?? [])) {
    deletes.push(
      db.delete(connectorCatalogSurfaces).where(inArray(connectorCatalogSurfaces.id, ids)),
    );
    counts.surfaces.deleted += ids.length;
  }

  // ── catalogue ──────────────────────────────────────────────────────────────
  // Always upserted, even when unchanged: it is the FK parent every other statement
  // on this page depends on, and one redundant single-row write is cheaper than
  // reasoning about whether the page still commits without it. It is counted as
  // `unchanged` when nothing moved, so it never on its own makes a page look dirty.
  const tally = (
    bucket: PromoteConnectorTableCounts,
    existing: Record<string, unknown> | undefined,
    values: Record<string, unknown>,
  ): 'created' | 'updated' | 'unchanged' => {
    if (!existing) {
      bucket.created += 1;
      return 'created';
    }
    if (unchanged(existing, values)) {
      bucket.unchanged += 1;
      return 'unchanged';
    }
    bucket.updated += 1;
    return 'updated';
  };

  // ── catalogue ──────────────────────────────────────────────────────────────
  // Treated exactly like every other table, including the skip-when-unchanged rule.
  // Its foreign-key children are safe either way: an unchanged catalogue is by
  // definition already stored, and a new or changed one is upserted here, ahead of
  // them, in the same batch.
  //
  // `managedBy` is NOT here (AECI-720). Promote does not own the flag, so it must not
  // write it — on create the column default supplies `review`, and the admin flip is the
  // only other writer. Its absence from `catalogValues` also keeps it out of the
  // `unchanged()` comparison, which is right: a value promote does not own must never
  // make a page look dirty.
  const catalogValues = {
    connectorProductId,
    connectorAuthorship: page.catalog.connectorAuthorship ?? null,
    notes: page.catalog.notes ?? null,
  };
  if (tally(counts.catalogs, existingCatalog, catalogValues) !== 'unchanged') {
    upserts.push(
      db
        .insert(connectorCatalogs)
        .values({ id: catalogId, ...catalogValues, createdAt: now, updatedAt: now })
        // `updatedAt` is set EXPLICITLY here and in every upsert below. Drizzle's
        // `$onUpdate` fires on `db.update()` and NOT on a conflict set-clause, so
        // omitting it leaves the mirror silently claiming it was never refreshed.
        .onConflictDoUpdate({
          target: connectorCatalogs.id,
          set: { ...catalogValues, updatedAt: now },
        }),
    );
  }

  // ── surfaces ───────────────────────────────────────────────────────────────
  for (const s of page.surfaces as PromoteConnectorSurface[]) {
    const values = {
      catalogId,
      surfaceRole: s.surfaceRole,
      indexKind: s.indexKind ?? null,
      indexUrl: s.indexUrl ?? null,
      lastIngestedAt: s.lastIngestedAt ?? null,
      notes: s.notes ?? null,
    };
    if (tally(counts.surfaces, existingSurfaces.get(s.id), values) === 'unchanged') continue;
    upserts.push(
      db
        .insert(connectorCatalogSurfaces)
        .values({ id: s.id, ...values, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: connectorCatalogSurfaces.id,
          set: { ...values, updatedAt: now },
        }),
    );
  }

  // ── stubs ──────────────────────────────────────────────────────────────────
  for (const s of page.stubs as PromoteConnectorStub[]) {
    const values = {
      catalogId,
      slug: s.slug,
      label: s.label ?? null,
      url: s.url ?? null,
      directionRole: s.directionRole ?? null,
      actionCount: s.actionCount ?? null,
      actions: s.actions ?? null,
      actionsHash: s.actionsHash ?? null,
      actionsFetchedAt: s.actionsFetchedAt ?? null,
      previousLabels: s.previousLabels ?? null,
      meta: s.meta ?? null,
      firstSeenAt: s.firstSeenAt,
      lastSeenAt: s.lastSeenAt,
      removedAt: s.removedAt ?? null,
    };
    if (tally(counts.stubs, existingStubs.get(s.id), values) === 'unchanged') continue;
    upserts.push(
      db
        .insert(connectorStubs)
        .values({ id: s.id, ...values, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: connectorStubs.id, set: { ...values, updatedAt: now } }),
    );
  }

  // A stub is resolvable if it is already stored OR arrives on this page — the
  // second half is what lets one page carry a stub and its mappings together.
  const stubOnPage = new Set(page.stubs.map((s) => s.id));
  const stubExists = (id: string) => stubOnPage.has(id) || existingStubs.has(id);
  const decisionStatuses = CONNECTOR_DECISION_STATUSES as readonly string[];

  // ── mappings ───────────────────────────────────────────────────────────────
  for (const m of page.mappings as PromoteConnectorMapping[]) {
    if (!stubExists(m.stubId)) {
      skipped.push({ ref: m.id, kind: 'connector-stub', reason: SKIP_MISSING_STUB });
      counts.mappings.skipped += 1;
      continue;
    }
    // A product-bearing status with no promoted product is the review app telling us
    // it holds no `supabase_product_id` yet — the same shape as the §3.4 integration
    // rule, and reported the same way rather than failing the page.
    const productBearing = !decisionStatuses.includes(m.status);
    if (productBearing && (!m.productId || !promotedProducts.has(m.productId))) {
      skipped.push({
        ref: m.id,
        kind: 'connector-mapping',
        reason: SKIP_MAPPING_PRODUCT_UNPROMOTED,
      });
      counts.mappings.skipped += 1;
      continue;
    }
    const values = {
      stubId: m.stubId,
      // Derived from the page, never accepted on the wire: it is a denormalised copy
      // of the stub's catalogue and the triage index depends on it being exactly that.
      catalogId,
      productId: productBearing ? (m.productId ?? null) : null,
      status: m.status,
      confidence: m.confidence ?? null,
      evidenceUrl: m.evidenceUrl ?? null,
      decidedBy: m.decidedBy ?? null,
      decidedAt: m.decidedAt ?? null,
      checkedAt: m.checkedAt ?? null,
      notes: m.notes ?? null,
    };
    if (tally(counts.mappings, existingMappings.get(m.id), values) === 'unchanged') continue;
    upserts.push(
      db
        .insert(connectorStubMappings)
        .values({ id: m.id, ...values, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: connectorStubMappings.id,
          set: { ...values, updatedAt: now },
        }),
    );
  }

  // ── pairs ──────────────────────────────────────────────────────────────────
  for (const p of page.pairs as PromoteConnectorPair[]) {
    if (!stubExists(p.stubAId) || !stubExists(p.stubBId)) {
      skipped.push({ ref: p.id, kind: 'connector-pair', reason: SKIP_MISSING_STUB });
      counts.pairs.skipped += 1;
      continue;
    }
    const values = {
      catalogId,
      stubAId: p.stubAId,
      stubBId: p.stubBId,
      urlAToB: p.urlAToB ?? null,
      urlBToA: p.urlBToA ?? null,
      surface: p.surface,
      classifiedAt: p.classifiedAt ?? null,
      firstSeenAt: p.firstSeenAt,
      lastSeenAt: p.lastSeenAt,
      removedAt: p.removedAt ?? null,
    };
    if (tally(counts.pairs, existingPairs.get(p.id), values) === 'unchanged') continue;
    upserts.push(
      db
        .insert(connectorPairs)
        .values({ id: p.id, ...values, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: connectorPairs.id, set: { ...values, updatedAt: now } }),
    );
  }

  // Rule 4: a page that changed nothing emits no statement and writes no audit row.
  const changed = deletes.length > 0 || upserts.length > 0;

  const audits: AuditLogEntry[] = changed
    ? [
        {
          actorType: 'system',
          action: 'connector_catalog.synced',
          entityType: 'connector_catalog',
          entityId: catalogId,
          metadata: { page: page.page, counts, skipped: skipped.length },
        },
      ]
    : [];

  return { statements: [...deletes, ...upserts], audits, skipped, counts, wrote: changed };
}
