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
 * ── REACH-TIER CLAIMS, AND WHY THEY DO NOT REPLACE WHOLESALE (AECI-891) ─────
 * Operator ruling 2026-09-13: a claim may anchor to a REACHED pair, so `claims` gained
 * `connector_pair_id` and this page gained a `claims[]` array.
 *
 * The product arm (`./promote-claims.ts`) replaces an integration's claims by origin:
 * a claim the payload dropped is deleted or converted, because one promote carries an
 * integration's claims WHOLE. **This arm does not, and must not.** A page is a slice of
 * a catalogue, not a complete statement about any pair — a claim missing from this page
 * is a claim on a different page, exactly like every other row here. Replace-by-absence
 * would make page 2 of a sync silently delete what page 1 committed, and nothing in the
 * protocol orders the pages or even requires them to arrive.
 *
 * So claims join the rest of this endpoint's discipline instead: **upsert keyed on the
 * review record id, with removal stated explicitly in `deleted.claims[]`.** Within one
 * claim the `aeci` attestation slot IS replaced, because a claim always travels whole —
 * that scope is a single record, never a page. Vendor slots are never touched, and a
 * `origin = 'vendor'` claim is never deleted by promote, both matching §3's rules 2 and 3.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ───────────────────────────────
 * No count is recomputed, no index is touched, no cache tag is emitted. §13.5 is
 * categorical: *"Reachable never counts — not in the heading, not in
 * `integration_count`, not in a facet, not in the home stats."* The only surface that
 * renders this data is the admin reader AECI-722 shipped (`/admin/connectors`), which is
 * uncacheable; the public surfaces AECI-715 / 716 are still unbuilt and still own the
 * cache-tag decision. Real rows have been here since the AECI-764 production sync of
 * 2026-09-10, so a change to this planner now moves live data. `connector_evidenced_pairs` — the delivered
 * tier — is never written here at all: it is AECI-721's, and the review app has no
 * such table to project.
 */

import type {
  AuditLogEntry,
  PromoteConnectorClaim,
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
import { and, eq, inArray } from 'drizzle-orm';

import type { Db } from '../db/client';
import { ApiError } from '../errors';
import {
  attestations,
  claims,
  connectorCatalogs,
  connectorCatalogSurfaces,
  connectorPairs,
  connectorStubMappings,
  connectorStubs,
  products,
} from '../db/schema';
import { claimProvenance } from './attestation-authority';
import type { BatchStmt, BatchTuple } from './audit';
import { loadDataObjectResolver, type DataObjectResolver } from './data-object-vocabulary';
import { liveAttestationsWhere } from './drizzle-helpers';
import { chunked } from './promote-claims';

/**
 * The one `attestations.source` promote may write, on either arm. Vendor slots belong to
 * the portal (`STAGE_2_ATTESTATIONS_SPEC.md` §2.1) and a promote that filled one would
 * collide with the live vendor row on `attestations_slot_key`.
 */
const AECI_SOURCE = 'aeci';

/** Reasons that reach `skipped[]`. Constants so the specs assert the same strings. */
export const SKIP_CONNECTOR_UNPROMOTED =
  'the connector platform for this catalogue is not promoted yet';
export const SKIP_MAPPING_PRODUCT_UNPROMOTED =
  'the mapped product is not promoted yet (send the mapping again once it is)';
export const SKIP_MISSING_STUB =
  'references a stub that is neither on this page nor already stored (send the stub page first)';

// ── Reach-tier claim skips (AECI-891) ──────────────────────────────────────────
// All of these are re-sendable in the §3a sense EXCEPT the two marked otherwise, which
// describe a review-side data conflict the caller has to resolve before re-sending.
/** The pair is on a page not yet sent, or it rode this page and was itself skipped. */
export const SKIP_CLAIM_MISSING_PAIR =
  'references a connector pair that is neither written by this page nor already stored (send the pair first)';
/** Not re-sendable as-is: the pair belongs to another catalogue, so this page has no
 *  authority over it — see the scoping note in the claims section. */
export const SKIP_CLAIM_FOREIGN_PAIR =
  'references a connector pair that belongs to a different catalogue; a page may only claim on its own';
/** Not re-sendable as-is: the term has to be added to the closed vocabulary by AECi, or
 *  the review app has to send one that exists. */
export const SKIP_CLAIM_DATA_OBJECT =
  'did not resolve to the seeded data_object vocabulary (find-only; promote may not mint a term)';
/** Not re-sendable as-is: two review records assert one `(pair, dataObject, direction)`,
 *  which `claims_identity_key` permits exactly one of. */
export const SKIP_CLAIM_IDENTITY_TAKEN =
  'asserts a (pair, dataObject, direction) another claim already holds; claim identity is unique';
/** Rule 2 of `STAGE_2_ATTESTATIONS_SPEC.md` §3, applied to the delete path. */
export const SKIP_CLAIM_VENDOR_ORIGIN =
  'is vendor-origin; promote curates alongside a vendor but never deletes or overwrites its claims';
/** Promote writes the `aeci` slot only — same rule and same wording as the product arm. */
export const SKIP_CLAIM_VENDOR_ATTESTATION =
  "attestation source is vendor-owned; promote writes only 'aeci'";

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
  /**
   * Products whose §13.7 reach line this page may have moved — a CACHE-KEY set,
   * and nothing else (AECI-892).
   *
   * Deliberately NOT called `affectedProducts`. That name is absent from the
   * connector ledger on purpose, because carrying it would let a replay call
   * `recomputeProductCounts` and violate §13.5's "reachable never counts". These
   * ids reach `cacheTagsForConnectorPage` and no counter.
   *
   * Ids rather than slugs: the planner's product read is scoped to the page's own
   * references, and a pair can move the reach of a product no row on this page
   * mentions. Slugs are resolved post-commit, where an extra read costs nothing
   * and cannot touch the batch.
   */
  purgeProductIds: string[];
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

/**
 * This page's claims, tolerating their ABSENCE (AECI-891).
 *
 * `PromoteConnectorPagePayloadSchema` defaults the array, so a parsed page always has
 * one — but the inline-params path through `runPromoteWorkflow` **casts rather than
 * re-parses**, and Workflows are at-least-once. An instance created before AECI-891
 * shipped carries params with no `claims` key at all, and it can replay days later
 * against this code. Iterating it directly would throw `page.claims is not iterable` and
 * turn an in-flight connector page into a dead job.
 *
 * Same forward-compatibility rule as `PromoteWorkflowParams.kind`, which is absent for
 * the product arm precisely so pre-AECI-714 instances still replay. `deleted.claims` is
 * covered by the `deleted?.` optional chain that was already there.
 */
function pageClaims(page: PromoteConnectorPagePayload): readonly PromoteConnectorClaim[] {
  return page.claims ?? [];
}

/** True when every projected column already holds the incoming value. */
function unchanged(existing: Record<string, unknown>, incoming: Record<string, unknown>): boolean {
  return Object.keys(incoming).every((k) => norm(existing[k]) === norm(incoming[k]));
}

/**
 * Everything the plan needs, in ONE batched read.
 *
 * Six questions, each preventing a specific failure:
 *   1. Which of this page's rows already exist, and with what values? — the basis of
 *      created/updated/unchanged, and of dropping unchanged rows entirely.
 *   2. Which referenced products are promoted? — an unpromoted product is a skip;
 *      without this read the foreign key fails and takes the whole page down.
 *   3. Which referenced stubs exist? — pages are not atomic with each other, so a
 *      pair or mapping can legitimately name a stub a later page carries.
 *   4. Which referenced PAIRS exist, and whose catalogue are they? — same dangling-
 *      reference rule for claims, plus the scoping check that stops one catalogue's
 *      page claiming on another's pairs.
 *   5. Which claims already exist? Asked TWICE and both are needed: **by id**, because
 *      the id is this arm's upsert key (and covers `deleted.claims` too), and **by
 *      anchor**, because `claims_identity_key` is unique on `(anchor, dataObject,
 *      direction)` and a second record id asserting a held identity would otherwise fail
 *      the whole batch at commit rather than land in `skipped[]`. A claim re-anchored to
 *      a different pair review-side is exactly the row the by-id read catches and the
 *      by-anchor read cannot.
 *   6. Which live attestations hang off this page's claims? — the `aeci` slot is updated
 *      in place rather than churned, so its id has to be known before the batch is built.
 *      Only the page's own claim ids are needed: deleted claims cascade, and anchor-found
 *      claims are read for collision detection only.
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

  // Pair ids the page WRITES plus pair ids its claims merely REFERENCE. Unioned into one
  // read rather than two: a claim-referenced pair that also rides this page must resolve
  // to the same row either way, and `existingPairs` is keyed by id so the extra entries
  // are inert for the pair tally.
  const pairIds = new Set<string>(page.pairs.map((p) => p.id));
  for (const c of pageClaims(page)) pairIds.add(c.connectorPairId);

  const pageClaimIds = pageClaims(page).map((c) => c.id);
  const claimIds = new Set<string>([...pageClaimIds, ...(page.deleted?.claims ?? [])]);

  const groups = {
    products: chunked([...productIds]),
    stubs: chunked([...stubIds]),
    surfaces: chunked(page.surfaces.map((s) => s.id)),
    // The ids this page ASSERTS plus the ids it DELETES. The deleted half is only
    // for AECI-892's purge set — a deleted row is the one place the pre-read holds
    // the only surviving copy of which product just lost reach — and it is inert
    // for change detection, which only ever looks up `page.mappings` ids.
    mappings: chunked([...page.mappings.map((m) => m.id), ...(page.deleted?.mappings ?? [])]),
    pairs: chunked([...pairIds]),
    claimsById: chunked([...claimIds]),
    claimsByAnchor: chunked([...pairIds]),
    attestations: chunked(pageClaimIds),
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
    ...groups.claimsById.map((c) => db.select().from(claims).where(inArray(claims.id, c))),
    // `anchor_id` is the generated `coalesce(...)` column the identity index is built on,
    // so this read and the uniqueness it guards cannot drift apart.
    ...groups.claimsByAnchor.map((c) =>
      db.select().from(claims).where(inArray(claims.anchorId, c)),
    ),
    ...groups.attestations.map((c) =>
      db
        .select()
        .from(attestations)
        // `liveAttestationsWhere`, not a bare `retracted_at IS NULL`, so retraction
        // semantics stay defined in one place — and `deprecated_at` must never gate it,
        // being a version stamp rather than a withdrawal.
        .where(and(inArray(attestations.claimId, c), liveAttestationsWhere)),
    ),
    // LAST, and it stays last. Every read above is unpacked by POSITION via
    // `take()`, so inserting a statement anywhere in the middle silently re-points
    // every map below it — `existingPairs` ends up keyed on `undefined` and change
    // detection reports every pair as new. Appending is the one edit that cannot
    // do that.
    //
    // Every product currently mapped to a stub this page touches (AECI-892). A
    // pair row can appear or vanish without any mapping changing — that is exactly
    // what AECI-890's derived-pair materialisation did, 669 rows and not one
    // mapping — and the reach of both its endpoints moves anyway. Keyed on
    // `stub_id` rather than on the mapping id, so it answers "who is on this stub"
    // rather than "what did the page send".
    ...groups.stubs.map((c) =>
      db
        .select({
          stubId: connectorStubMappings.stubId,
          productId: connectorStubMappings.productId,
        })
        .from(connectorStubMappings)
        .where(inArray(connectorStubMappings.stubId, c)),
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

  // The two claim reads overlap by construction (a claim on one of this page's pairs is
  // found by both), so they are folded into ONE id-keyed map. `existingClaimsByAnchor`
  // then indexes that same map, which is what keeps the two views from disagreeing.
  const existingClaims = new Map<string, Record<string, unknown>>();
  for (const row of [...take(groups.claimsById.length), ...take(groups.claimsByAnchor.length)]) {
    existingClaims.set(row.id as string, row);
  }

  const liveAttestations = new Map<string, Record<string, unknown>[]>();
  for (const row of take(groups.attestations.length)) {
    const claimId = row.claimId as string;
    const list = liveAttestations.get(claimId);
    if (list) list.push(row);
    else liveAttestations.set(claimId, [row]);
  }

  // Last take, matching the last read. See the note on that statement.
  const mappedProductsByStub = new Map<string, Set<string>>();
  for (const row of take(groups.stubs.length)) {
    const productId = row.productId as string | null;
    if (!productId) continue;
    const stubId = row.stubId as string;
    const set = mappedProductsByStub.get(stubId);
    if (set) set.add(productId);
    else mappedProductsByStub.set(stubId, new Set([productId]));
  }

  return {
    existingCatalog,
    promotedProducts,
    existingStubs,
    existingSurfaces,
    existingMappings,
    existingPairs,
    existingClaims,
    liveAttestations,
    mappedProductsByStub,
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
    claims: emptyCounts(),
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
    existingClaims,
    liveAttestations,
    mappedProductsByStub,
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
    counts.claims.skipped = pageClaims(page).length;
    return { statements: [], audits: [], skipped, counts, wrote: false, purgeProductIds: [] };
  }

  // The claim vocabulary read is deliberately BELOW both early exits: a refused or
  // skipped page must cost exactly one batched read, not two. It is also gated on the
  // page actually carrying claims, because the overwhelming majority of pages are stubs
  // and mappings and would otherwise pay for a table they never touch.
  const resolveDataObject: DataObjectResolver | null = pageClaims(page).length
    ? await loadDataObjectResolver(db)
    : null;

  const deletes: BatchStmt[] = [];
  const upserts: BatchStmt[] = [];

  // ── the AECI-892 purge set ─────────────────────────────────────────────────
  // Collected as the plan is built rather than derived from the response, because
  // the response carries counts and no ids. Added to at exactly the points a
  // statement is emitted, so a page that writes nothing collects nothing and
  // purges nothing — §13.10's "a re-sent page writes nothing at all, including no
  // `audit_log` row" extends to the cache.
  const purgeProductIds = new Set<string>();
  const purgeStubEndpoints = (...stubIds: string[]) => {
    for (const stubId of stubIds) {
      for (const productId of mappedProductsByStub.get(stubId) ?? [])
        purgeProductIds.add(productId);
    }
  };

  for (const ids of chunked(page.deleted?.mappings ?? [])) {
    deletes.push(db.delete(connectorStubMappings).where(inArray(connectorStubMappings.id, ids)));
    counts.mappings.deleted += ids.length;
    // The product loses reach through this stub, so its page moves. Read off the
    // PRE-READ, which is the only surviving copy once the row is gone.
    //
    // BOUNDED GAP, stated rather than left to be found: this purges the product
    // that lost the mapping, not the partners that lost IT. Closing that needs a
    // pairs-by-stub read plus a mappings read for every partner stub, three round
    // trips to repaint pages whose only change is one line's integer. The same
    // shape as `CACHE_STRATEGY.md` §3 rule 4's re-pointed-connector gap, and the
    // same disposition: those pages go stale until TTL.
    for (const id of ids) {
      const productId = existingMappings.get(id)?.productId as string | null | undefined;
      if (productId) purgeProductIds.add(productId);
    }
  }
  for (const ids of chunked(page.deleted?.surfaces ?? [])) {
    deletes.push(
      db.delete(connectorCatalogSurfaces).where(inArray(connectorCatalogSurfaces.id, ids)),
    );
    counts.surfaces.deleted += ids.length;
  }

  // ── deleted claims (AECI-891) ──────────────────────────────────────────────
  // Filtered against the pre-read rather than issued blind, unlike the two deletes
  // above, and for two reasons that both matter:
  //
  //   1. **Rule 2 of `STAGE_2_ATTESTATIONS_SPEC.md` §3** — promote never deletes a
  //      vendor-origin claim. Unreachable today (only this arm writes reach claims, and
  //      it writes `origin='aeci'`), which is precisely the argument AECI-604 disproved
  //      the hard way on the product arm. Reported, so a review app that starts sending
  //      these finds out.
  //   2. **Rule 7** — an id that no longer exists must emit no statement. A blind DELETE
  //      would make `deleted.claims` re-write an `audit_log` row on every re-send of a
  //      page that changes nothing, which is the exact churn this planner exists to avoid.
  //
  // Deleting a claim cascades its attestations (`attestations.claim_id` ON DELETE
  // CASCADE), so there is no second statement to emit.
  const deletedClaimIds: string[] = [];
  for (const id of page.deleted?.claims ?? []) {
    const row = existingClaims.get(id);
    if (!row) continue;
    if (row.origin === 'vendor') {
      skipped.push({ ref: id, kind: 'claim', reason: SKIP_CLAIM_VENDOR_ORIGIN });
      counts.claims.skipped += 1;
      continue;
    }
    deletedClaimIds.push(id);
  }
  for (const ids of chunked(deletedClaimIds)) {
    deletes.push(db.delete(claims).where(inArray(claims.id, ids)));
    counts.claims.deleted += ids.length;
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
    // Both sides of a re-point: the product losing the mapping and the one
    // gaining it. Purging only the new one leaves the old page asserting reach it
    // no longer has, which is the same shape as Addendum B's re-pointed-connector
    // gap (`CACHE_STRATEGY.md` §3 rule 4).
    const priorProductId = existingMappings.get(m.id)?.productId as string | null | undefined;
    if (priorProductId) purgeProductIds.add(priorProductId);
    if (values.productId) purgeProductIds.add(values.productId);
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
  // Pairs a claim may legally anchor to: the ones this page WRITES. A pair that rode this
  // page but was skipped for a missing stub is NOT in here — its row never lands, so a
  // claim naming it would fail the foreign key and take the whole page down.
  const pairsWrittenThisPage = new Set<string>();
  for (const p of page.pairs as PromoteConnectorPair[]) {
    if (!stubExists(p.stubAId) || !stubExists(p.stubBId)) {
      skipped.push({ ref: p.id, kind: 'connector-pair', reason: SKIP_MISSING_STUB });
      counts.pairs.skipped += 1;
      continue;
    }
    pairsWrittenThisPage.add(p.id);
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
    // A pair row IS the reach, so both its endpoints' pages move — including on a
    // `removed_at` tombstone, which is how a pair is retired (there is no
    // `deleted.pairs` on the wire).
    purgeStubEndpoints(p.stubAId, p.stubBId);
    upserts.push(
      db
        .insert(connectorPairs)
        .values({ id: p.id, ...values, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({ target: connectorPairs.id, set: { ...values, updatedAt: now } }),
    );
  }

  // ── claims (AECI-891) ──────────────────────────────────────────────────────
  // Runs AFTER the pairs loop, because the FK a claim needs is only known once each
  // pair on this page has been accepted or skipped.
  //
  // Statement order within the claim work is FK-safe by construction: claim upserts sit
  // with the other upserts (after `pairs`), and the two attestation arrays are appended
  // last. Attestation deletes precede attestation writes so re-filling the `aeci` slot
  // cannot trip `attestations_slot_key`.
  const attestationDeletes: BatchStmt[] = [];
  const attestationWrites: BatchStmt[] = [];

  // Identities already spoken for — by a stored claim, or by an earlier claim on this
  // page. `claims_identity_key` admits exactly one per `(anchor, dataObject, direction)`,
  // and a second one would roll the WHOLE page back instead of reporting itself.
  //
  // A claim THIS PAGE deletes does not hold its identity: the DELETE is in `deletes`,
  // which is spliced ahead of every upsert, so by commit time the slot is free. Seeding
  // it here anyway would reject the re-key shape — hard-delete record X, send record Y on
  // the same `(pair, dataObject, direction)` — with `SKIP_CLAIM_IDENTITY_TAKEN`, a reason
  // documented as terminal. The caller would be told to fix upstream data that is already
  // right, and only a second send of the identical page would land Y.
  const identityKey = (pairId: string, dataObjectId: string, direction: string) =>
    `${pairId}|${dataObjectId}|${direction}`;
  const deletedClaimIdSet = new Set(deletedClaimIds);
  const identityHolder = new Map<string, string>();
  for (const row of existingClaims.values()) {
    if (deletedClaimIdSet.has(row.id as string)) continue;
    const anchor = row.anchorId as string | null;
    if (anchor)
      identityHolder.set(
        identityKey(anchor, row.dataObjectId as string, row.direction as string),
        row.id as string,
      );
  }

  for (const c of pageClaims(page)) {
    const storedPair = existingPairs.get(c.connectorPairId);
    if (!pairsWrittenThisPage.has(c.connectorPairId) && !storedPair) {
      skipped.push({ ref: c.id, kind: 'claim', reason: SKIP_CLAIM_MISSING_PAIR });
      counts.claims.skipped += 1;
      continue;
    }
    // Catalogue scoping, and it is a real control rather than belt-and-braces. Every
    // other child row on this page binds the page-level `catalogId`, which is what makes
    // "one page writes one catalogue's rows" true — and it is what AECI-720's vendor-
    // managed freeze rests on. A claim has no `catalog_id` column of its own; its only
    // scope is the pair it names. Without this check, a page for a review-managed
    // catalogue could write claims onto a FROZEN catalogue's pairs, walking straight
    // around the freeze. Page-carried pairs are in scope by construction.
    if (!pairsWrittenThisPage.has(c.connectorPairId) && storedPair?.catalogId !== catalogId) {
      skipped.push({ ref: c.id, kind: 'claim', reason: SKIP_CLAIM_FOREIGN_PAIR });
      counts.claims.skipped += 1;
      continue;
    }

    // Find-only against the frozen vocabulary (`docs/DATA_OBJECT_VOCABULARY.md`), through
    // the same resolver the product arm and the vendor authoring API use. Minting a term
    // is an AECi curation act; promote may not do it, so a miss is reported and dropped.
    const term = resolveDataObject?.(c.dataObject);
    if (!term) {
      skipped.push({
        ref: c.id,
        kind: 'claim',
        reason: `dataObject "${c.dataObject}" ${SKIP_CLAIM_DATA_OBJECT}`,
      });
      counts.claims.skipped += 1;
      continue;
    }

    const key = identityKey(c.connectorPairId, term.id, c.direction);
    const holder = identityHolder.get(key);
    if (holder !== undefined && holder !== c.id) {
      skipped.push({ ref: c.id, kind: 'claim', reason: SKIP_CLAIM_IDENTITY_TAKEN });
      counts.claims.skipped += 1;
      continue;
    }

    const existing = existingClaims.get(c.id);
    if (existing?.origin === 'vendor') {
      // Rule 2 again, on the write path: AECi curating alongside a vendor never seizes
      // the vendor's row. Promote leaves it exactly as it found it.
      skipped.push({ ref: c.id, kind: 'claim', reason: SKIP_CLAIM_VENDOR_ORIGIN });
      counts.claims.skipped += 1;
      continue;
    }
    // Claim this identity before the write, so a second page entry asserting it is
    // reported rather than colliding at commit.
    identityHolder.set(key, c.id);

    const values = {
      // All three anchor columns are written EXPLICITLY, not just the one that is set.
      // `claims_anchor_check` requires exactly one non-null, and this is an UPSERT: a row
      // that somehow arrived carrying a second anchor would otherwise keep it through the
      // conflict set-clause and fail the CHECK for the whole page.
      integrationId: null,
      connectorEvidencedPairId: null,
      connectorPairId: c.connectorPairId,
      dataObjectId: term.id,
      direction: c.direction,
      // Never assemble the provenance pair by hand — the helper makes `origin='vendor'`
      // without a vendor id unrepresentable (`STAGE_2_ATTESTATIONS_SPEC.md` §2.2).
      ...claimProvenance(null),
    };
    const outcome = tally(counts.claims, existing, values);
    if (outcome !== 'unchanged') {
      upserts.push(
        db
          .insert(claims)
          .values({ id: c.id, ...values, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({ target: claims.id, set: { ...values, updatedAt: now } }),
      );
    }

    // ── the claim's `aeci` attestation slot ──────────────────────────────────
    // Replaced within the claim, which is a DIFFERENT scope from replacing a page: a
    // claim always travels whole, so absence here really does mean "AECi no longer
    // asserts this", the same meaning the product arm gives it. Updated in place rather
    // than the product arm's delete-then-insert, so an unchanged attestation emits
    // nothing and the row's id stays put.
    const live = liveAttestations.get(c.id) ?? [];
    const liveAeci = live.find((a) => a.source === AECI_SOURCE);
    let incoming: PromoteConnectorClaim['attestations'][number] | undefined;
    for (const att of c.attestations) {
      if (att.source !== AECI_SOURCE) {
        // Inserting a vendor slot would collide with a live vendor row on
        // `attestations_slot_key` and 500 the whole page, so it is reported the same way
        // an unresolved `dataObject` is rather than rejected at the schema boundary.
        skipped.push({
          ref: c.id,
          kind: 'claim',
          reason: `${SKIP_CLAIM_VENDOR_ATTESTATION} (source "${att.source}")`,
        });
        continue;
      }
      // First occurrence wins, matching the product arm: a payload repeating a source on
      // one claim would otherwise fail the batch rather than duplicate a vote.
      incoming ??= att;
    }

    const attestationValues = incoming && {
      claimId: c.id,
      source: AECI_SOURCE,
      asserted: incoming.asserted,
      introducedAt: incoming.introducedAt ?? null,
      deprecatedAt: incoming.deprecatedAt ?? null,
      note: incoming.note ?? null,
    };

    // The attestation IS the claim's content, so a claim whose row did not move but whose
    // attestation did must not report `unchanged` — that number is what proves a page was
    // idempotent, and it has to stay honest.
    const reclassify = () => {
      if (outcome !== 'unchanged') return;
      counts.claims.updated += 1;
      counts.claims.unchanged -= 1;
    };

    if (!attestationValues) {
      if (liveAeci) {
        attestationDeletes.push(
          db.delete(attestations).where(eq(attestations.id, liveAeci.id as string)),
        );
        reclassify();
      }
      continue;
    }
    if (liveAeci) {
      if (unchanged(liveAeci, attestationValues)) continue;
      attestationWrites.push(
        db
          .update(attestations)
          .set({ ...attestationValues, updatedAt: now })
          .where(eq(attestations.id, liveAeci.id as string)),
      );
    } else {
      attestationWrites.push(
        db.insert(attestations).values({
          id: crypto.randomUUID(),
          ...attestationValues,
          createdAt: now,
          updatedAt: now,
        }),
      );
    }
    reclassify();
  }

  // Rule 4: a page that changed nothing emits no statement and writes no audit row.
  const changed =
    deletes.length > 0 ||
    upserts.length > 0 ||
    attestationDeletes.length > 0 ||
    attestationWrites.length > 0;

  const audits: AuditLogEntry[] = changed
    ? [
        {
          actorType: 'system',
          action: 'connector_catalog.synced',
          entityType: 'connector_catalog',
          entityId: catalogId,
          metadata: {
            page: page.page,
            counts,
            skipped: skipped.length,
            // Named, not just counted. A claim delete is destructive and the summary row
            // is the only record of it — `deleted: 3` would leave an operator unable to
            // say WHICH three. Bounded by the page ceiling, so this cannot grow unbounded.
            ...(deletedClaimIds.length ? { deletedClaimIds } : {}),
          },
        },
      ]
    : [];

  // The catalogue's own connector product rides along whenever the page wrote
  // anything, and unconditionally rather than by derivation.
  // `CACHE_STRATEGY.md` §3 rule 5 names the tag set as
  // `product:{connectorSlug}` PLUS the moved endpoints, and the connector is the
  // one product no other rule reaches: it is not an endpoint of any pair here,
  // and it is only in `purgeProductIds` by accident if it happens to be mapped as
  // a stub somewhere. AECI-715's coverage surface will render on that page.
  if (changed) purgeProductIds.add(connectorProductId);

  return {
    statements: [...deletes, ...upserts, ...attestationDeletes, ...attestationWrites],
    audits,
    skipped,
    counts,
    wrote: changed,
    // Empty when nothing changed, by construction: every `add` above sits after
    // an `unchanged` guard, and the connector id is gated on `changed`.
    purgeProductIds: changed ? [...purgeProductIds] : [],
  };
}
