/**
 * Push-based review app → app-DB promotion ingest — Drizzle/D1 (ADR 0016 / AECI-253,
 * AECI-249).
 *
 * The review application sends one product plus its dependencies; this module
 * upserts the whole bundle and returns the resulting IDs (see `@aeci/shared`
 * `PromotePayloadSchema` / `PromoteResponse` for the contract and idempotency
 * model).
 *
 * **This is no longer an HTTP handler (AECI-563 / ADR 0021).** `POST /api/promote`
 * (`routes/promote-kickoff.ts`) validates the payload, starts the promote Workflow,
 * and returns `202 { jobId }`; the Workflow (`workflows/promote-workflow.ts`) runs
 * {@link runPromoteIngest} inside one non-retried step and then
 * {@link dispatchPromoteHooks}, and `GET /api/promote/jobs/:id`
 * (`routes/promote-jobs.ts`) serves the ID map. That split exists because the
 * commit used to be lost to a client timeout: the batch committed, the response
 * carrying the assigned IDs never arrived, and the product went live with no way
 * to recover its IDs (AECI-561).
 *
 * D1 has no interactive transactions, so the ingest is **plan-then-batch**:
 *   1. **Plan (reads + id generation, NO writes).** Preload slugs; read the
 *      slugs of any rows being updated; resolve taxonomy (find-or-create for
 *      categories/audiences/phases, find-ONLY for trades — AECI-542) and
 *      usefulness against existing+to-be-created terms; resolve every
 *      integration/extension endpoint (refs → planned ids, supabaseIds →
 *      existence reads); read an updated integration's OLD endpoints for the
 *      recompute. All new ids are app-generated `crypto.randomUUID()` up front,
 *      so nothing depends on a write's return value.
 *   2. **One atomic `db.batch`** of vendor/product/integration upserts +
 *      join-table delete/recreate + extension inserts + an `audit_log` row per
 *      create/update (Stage 1 Spec §26.1 — every state change logs, atomically).
 *      Statements are ordered to satisfy FKs statement-by-statement (vendors →
 *      taxonomy → product → joins → integrations → audits).
 *   3. **Post-batch recompute** of the denormalized counts for the touched
 *      products (`lib/recompute-counts.ts`; the brief lag is the drift sweep's
 *      backstop), then the best-effort §26.5 audit forwards, edge-cache purge,
 *      and Algolia upsert via `ctx.waitUntil`.
 *
 *   - **Upsert by caller-supplied `supabaseId`.** Present *and still resolvable*
 *     → update; absent → create. The review app holds the IDs (no `external_id`
 *     column exists). A `supabaseId` whose row is **gone** (retracted, pruned,
 *     deleted) falls back to **create** rather than issuing a no-op
 *     `UPDATE … WHERE id = <gone>` that silently writes nothing and reports an
 *     empty slug (AECI-568). The fallback is reported on
 *     `PromoteIngestResult.staleSupabaseIds` → `aeci.api.promote.stale_id`.
 *   - **Taxonomy resolves slug → name → mint (AECI-970).** A category / audience /
 *     phase that matches no stored slug and no stored name is still created, and
 *     every mint is reported as `aeci.api.promote.taxonomy_created`. Trades are
 *     find-only and never mint.
 *   - **Slugs are server-owned.** Generated on create via `@aeci/shared/slug`;
 *     kept stable on update.
 *   - **Joins are replaced, not merged.** On update, the product's
 *     vendor/taxonomy/extension join rows are deleted and re-inserted.
 *   - **Endpoint resolution.** Integrations whose source/target can't be
 *     resolved (the other product isn't promoted yet) are reported in `skipped[]`
 *     rather than failing the request (the product-driven "both endpoints
 *     promoted" rule, AECI-83).
 *
 * Cache invalidation (AECI-105) is best-effort + post-commit (`ctx.waitUntil` →
 * enqueue onto `CACHE_PURGE_QUEUE`; the SSR Worker's queue consumer issues the
 * `ctx.cache.purge()` — ADR 0020 §3, since the API Worker's own zone-HTTP purge is
 * inert against native Workers Cache); no-op without the queue binding
 * (local/preview). Algolia sync (AECI-139) is an injectable post-commit seam over
 * the Drizzle `algolia-sync` core, no-op without the Algolia secrets.
 */

import {
  CACHE_PURGE_QUEUE_MAX_TAGS,
  type PromotePayload,
  type EntityRef,
  type PromoteEntityResult,
  type PromoteIntegrationResult,
  type PromoteOperation,
  type PromotePreserved,
  type PromoteResponse,
  type PromoteSkipped,
  type PromoteTaxonomyResult,
  type PromoteUnresolvedLink,
  type PromoteVendor,
  type PromoteProduct,
  type PromoteIntegration,
  type PromoteUsefulnessGroup,
  type UsefulnessGroup,
} from '@aeci/shared';
import { type AlgoliaEnv } from '@aeci/shared/algolia';
import { type AuditLogEntry } from '@aeci/shared/audit-log';
import { disambiguateSlug, SlugReservedError, slugify } from '@aeci/shared/slug';
import { and, eq, inArray, isNull, sql, type Table } from 'drizzle-orm';
import { type SQLiteColumn } from 'drizzle-orm/sqlite-core';

import { getDb, type Db, type DbContext } from '../db/client';
import {
  claims,
  connectorEvidencedPairs,
  integrationEndpointMoves,
  integrations,
  productAudiences,
  productCategories,
  productExtensions,
  productPhases,
  products,
  productTrades,
  productVendors,
  promoteJobs,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyPhases,
  taxonomyTrades,
  vendors,
} from '../db/schema';
import {
  logBatchToPosthog,
  logToPosthog,
  submitCount,
  submitDistribution,
  type PosthogLogEvent,
} from '../posthog';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { syncPromoteTargets } from '../lib/algolia-sync';
import { emitAlgoliaSyncMetrics, type SyncMetricSink } from '../lib/algolia-sync-metrics';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { loadClaimedVendorIds } from '../lib/claimed-vendors';
import { isPromoteClaimFenceError, promoteClaimFenceSentinel } from '../lib/integration-claims';
import {
  anyVendorOwnedTwin,
  findStrongMatches,
  VENDOR_OWNED_TWIN,
  vendorOwnedTwinSentinel,
  type TwinCandidate,
} from '../lib/integration-twins';
import {
  loadDataObjectResolver,
  safeSlugify,
  type DataObjectResolver,
} from '../lib/data-object-vocabulary';
import { planClaimReframe } from '../lib/claim-frame';
import {
  loadReframeClaims,
  planClaimIngest,
  reframeStatements,
  type ClaimIngestItem,
} from '../lib/promote-claims';
import { type DbFactory } from '../lib/handler-utils';
import { runHomeStats, type HomeStatsResult } from '../lib/home-stats';
import { emitHomeStatsMetrics, type StatsMetricSink } from '../lib/home-stats-metrics';
import { enqueueIndexNowUrls } from '../lib/indexnow-queue';
import { enqueueGscRecrawl } from '../lib/gsc-recrawl-queue';
import { extensionHostSlugs } from '../lib/product-extensions';
import { recomputeProductCounts } from '../lib/recompute-counts';
import { cacheTagsForPromote, touchedTradeSlugs } from './promote-cache-tags';
import { gscRecrawlEntriesForPromote } from './promote-gsc-recrawl-entries';
import { affectedUrlsForPromote, type AffectedUrlOptions } from './promote-indexnow-urls';
import { resolvePublishedTradeSlugs } from './promote-trade-publication';

// ─── Helpers ─────────────────────────────────────────────────────────────────
/**
 * The maintenance fence (AECI-981 / `STAGE_2_ATTESTATIONS_SPEC.md` §13.9).
 *
 * Promote may advance `last_reviewed_at` on a record AECi maintains, and must not
 * on one a vendor maintains. The marker's two branches use different verbs off the
 * SAME column — `Maintained by AEC Integrations · Reviewed <date>` versus
 * `Vendor-maintained · Updated <date>` — so an AECi review date landing on a
 * vendor-maintained row attributes AECi's work to the vendor. That is exactly the
 * mis-attribution §13.5 branch-scopes `computePairMaintenance` to prevent; this
 * closes the same hole at the row grain, on the write side.
 *
 * Tested in SQL rather than read-then-branch for the reason `logo_source` is
 * (`STAGE_2_5_SPEC.md` §11.2): the plan and the commit are not atomic with each
 * other, so a vendor save landing in between must still win.
 *
 * Returns `{}` when the caller sent nothing, preserving §3.6's absent-means-
 * untouched contract — the fence only ever refuses a value that was explicitly
 * supplied, and that refusal is reported in `skipped[]`.
 */
function fencedLastReviewedAt(
  table: { maintainedBy: SQLiteColumn; lastReviewedAt: SQLiteColumn },
  value: string | null | undefined,
): Record<string, unknown> {
  if (value === undefined) return {};
  return {
    lastReviewedAt: sql`CASE WHEN ${table.maintainedBy} = 'aeci' THEN ${value} ELSE ${table.lastReviewedAt} END`,
  };
}

/** Whether {@link fencedLastReviewedAt} will refuse this write, i.e. whether the
 *  caller earns a `kind: 'review-signal'` entry in `skipped[]`. Kept beside the
 *  fence so the SQL and the receipt cannot drift.
 *
 *  Its row-grain sibling is {@link claimFenceRefuses} below (AECI-1005): the same
 *  two halves, a receipt decided from the plan read and an in-SQL guard that
 *  holds if the row changes between plan and commit. */
function reviewSignalRefused(
  value: string | null | undefined,
  storedMaintainedBy: string | undefined,
): boolean {
  return value !== undefined && storedMaintainedBy === 'vendor';
}

/**
 * The ownership fence (AECI-1005 / ADR 0035 / `REVIEW_APP_PROMOTE_API.md` §4b).
 *
 * Once an integration's owner has claimed it (`claimed_at IS NOT NULL`), promote
 * writes NOTHING to it: no content column, no `built_by_vendor_id`, no endpoint
 * re-point, no cross-table move (which would DELETE the row and cascade away its
 * claims, attestations and contests), and no write to its claims or attestations.
 * The whole edge is refused into `skipped[]` with {@link REFUSED_CLAIMED_INTEGRATION},
 * the same way AECI-520 refuses an edge touching a blocked product.
 *
 * It keys on `claimed_at` and never on `maintained_by` (AECI-1003 decision 13):
 * `maintained_by` flips to `'vendor'` when either endpoint vendor merely attests,
 * which is the {@link fencedLastReviewedAt} fence's business and not ownership.
 *
 * **Since AECI-1011 it also keys on `origin = 'vendor'`.** A vendor-created row is
 * born claimed, but an AECi `owner` contest accept reassigns the owner and CLEARS
 * `claimed_at` (§11b.6), and a `claimed_at`-only fence would then hand a row no
 * curator ever wrote to promote. A vendor-created row is never promote's to write,
 * whoever owns it. The predicate is `vendorHeldIntegrationWhere`'s, in JS
 * (`lib/integration-twins.ts`), and so is the commit-time sentinel's. The 1005
 * function is widened here rather than on the 1005 branch (ADR 0035).
 *
 * This is the plan-time half. It is decided from {@link locateEdge}'s read, so it
 * covers every row claimed before the promote started. The commit-time half is
 * `promoteClaimFenceSentinel` (`lib/integration-claims.ts`): one guard statement per
 * written `integrations` row that aborts the whole batch if the row was claimed
 * after this read. Only the `integrations` arm can be claimed.
 */
function claimFenceRefuses(located: LocatedEdge | null): boolean {
  return (
    located?.table === 'integrations' &&
    (located.row.claimedAt !== null || located.row.origin === 'vendor')
  );
}

/**
 * What a cross-table move must write so the destination row keeps the maintenance
 * state the source row held (AECI-981).
 *
 * `maintained_by` is carried unconditionally — the routing key changed, the record
 * did not. `last_reviewed_at` applies the same fence as an UPDATE would, in JS
 * rather than SQL because the source row is already in hand and the destination
 * row does not exist yet to be tested against.
 */
function carriedMaintenance(
  source: { maintainedBy: string; lastReviewedAt: string | null },
  supplied: string | null | undefined,
): { maintainedBy: string; lastReviewedAt: string | null } {
  const accept = supplied !== undefined && source.maintainedBy === 'aeci';
  return {
    maintainedBy: source.maintainedBy,
    lastReviewedAt: accept ? supplied : source.lastReviewedAt,
  };
}

/** Drop keys whose value is `undefined` so the column is left untouched. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

/** Generate a slug or throw a typed 400 for the two expected failure modes. */
function generateSlug(name: string, existing: Set<string>, vendorSlug?: string): string {
  let base: string;
  try {
    base = slugify(name);
  } catch (err) {
    if (err instanceof SlugReservedError) {
      throw new ApiError(400, 'VALIDATION_FAILED', `Name "${name}" maps to a reserved slug`, {
        field: 'name',
      });
    }
    throw new ApiError(400, 'VALIDATION_FAILED', `Name "${name}" cannot be converted to a slug`, {
      field: 'name',
    });
  }
  const slug = disambiguateSlug(base, [...existing], vendorSlug);
  existing.add(slug);
  return slug;
}

/**
 * True when `err` is a SQLite/D1 UNIQUE-constraint violation on a `slug` column.
 * Slugs are preloaded *before* the batch (`loadSlugs`), so two concurrent
 * first-time promotes can both generate the same slug and the second insert then
 * trips `vendors_slug_key` / `products_slug_key`. That is a caller-resolvable
 * conflict, not a server fault — the handler translates it to a documented
 * `409 SLUG_CONFLICT` (AECI-98) instead of a generic 500.
 *
 * Duck-typed across the D1 and better-sqlite3 error shapes (message + code), like
 * `routes/reviews.ts`'s duplicate check. SQLite reports `UNIQUE constraint
 * failed: products.slug`; a non-slug UNIQUE violation returns false and falls
 * through to the generic 500 so unrelated violations are never mislabeled.
 */
function isSlugUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { message?: unknown; code?: unknown };
  const msg =
    `${typeof e.message === 'string' ? e.message : ''} ${String(e.code ?? '')}`.toLowerCase();
  return msg.includes('unique') && msg.includes('slug');
}

/**
 * True when `err` is the `promote_jobs` primary-key violation — i.e. this job id has
 * already committed and the batch we just attempted IS a replay (AECI-571).
 *
 * Sibling of {@link isSlugUniqueViolation}, duck-typed the same way because D1 and
 * better-sqlite3 both report constraint failures only in the message. Note the trap:
 * SQLite reports a conflict on a TEXT PRIMARY KEY as `UNIQUE constraint failed:
 * promote_jobs.job_id` (extended code `SQLITE_CONSTRAINT_PRIMARYKEY`) — the words
 * "primary key" never appear in the message, so this matches on the TABLE name instead.
 * D1 wraps the identical text as `D1_ERROR: UNIQUE constraint failed:
 * promote_jobs.job_id: SQLITE_CONSTRAINT`.
 *
 * The message carries no `slug`, and a slug violation carries no `promote_jobs`, so this
 * predicate and {@link isSlugUniqueViolation} are disjoint by construction.
 */
export function isPromoteJobDuplicate(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { message?: unknown; code?: unknown };
  const msg =
    `${typeof e.message === 'string' ? e.message : ''} ${String(e.code ?? '')}`.toLowerCase();
  return msg.includes('constraint') && msg.includes('promote_jobs');
}

/** Columns named in a `UNIQUE constraint failed: <table>.<col>, …` message →
 *  `['slug']` etc. (the `details.target` for the 409 envelope). */
function slugConflictTarget(err: unknown): string[] {
  const msg = String((err as { message?: unknown })?.message ?? '');
  const m = msg.match(/unique constraint failed:\s*(.+)/i);
  if (!m) return ['slug'];
  return m[1]!
    .split(',')
    .map((s) => s.trim().split('.').pop() ?? s.trim())
    .filter(Boolean);
}

function vendorEditableData(v: PromoteVendor): Record<string, unknown> {
  return compact({
    description: v.description,
    website: v.website,
    headquarters: v.headquarters,
    foundedYear: v.foundedYear,
    publicPrivate: v.publicPrivate,
    parentCompany: v.parentCompany,
    linkedinUrl: v.linkedinUrl,
    xUrl: v.xUrl,
    facebookUrl: v.facebookUrl,
    instagramUrl: v.instagramUrl,
    youtubeUrl: v.youtubeUrl,
    crunchbaseUrl: v.crunchbaseUrl,
    wikiUrl: v.wikiUrl,
    sourceUrl: v.sourceUrl,
    githubOrg: v.githubOrg,
    phoneNumber: v.phoneNumber,
    contactEmail: v.contactEmail,
    logoUrl: v.logoUrl,
    // Absent → `compact()` drops it → the stored timestamp is untouched. That IS
    // the "no review happened" signal (AECI-616); see `ReviewSignalSchema`.
    lastReviewedAt: v.lastReviewedAt,
    // `maintainedBy` is deliberately NOT here either, for the same reason as
    // `verified` below: it is owned by the vendor attestation path, and a routine
    // push must not be able to flip a vendor-maintained record back to 'aeci'.
    //
    // `verified` is deliberately NOT here (AECI-520). It is an entitlement the
    // vendor-claim grant owns, not curation content — the payload field is still
    // accepted and ignored (`REVIEW_APP_PROMOTE_API.md` §3.2). It used to be
    // written, and a routine promote push carrying `verified: false` would then
    // silently un-verify a vendor.
  });
}

function productEditableData(p: PromoteProduct): Record<string, unknown> {
  return compact({
    description: p.description,
    website: p.website,
    toolIntegrationsUrl: p.toolIntegrationsUrl,
    apiDocsUrl: p.apiDocsUrl,
    hasApiDocs: p.hasApiDocs,
    toolIntegrationCheckNotes: p.toolIntegrationCheckNotes,
    logoUrl: p.logoUrl,
    productRole: p.productRole,
    researchStatus: p.researchStatus,
    researchNotes: p.researchNotes,
    priorityTier: p.priorityTier,
    priorityScore: p.priorityScore,
    googleTrendsIndex: p.googleTrendsIndex,
    searchVolumeMonthly: p.searchVolumeMonthly,
    redditMentions24mo: p.redditMentions24mo,
    adminNotes: p.adminNotes,
    // AECI-616. Absent → untouched (see `vendorEditableData`). Deliberately NOT
    // given the set-once `COALESCE` guard `promotedAt` gets in the update branch
    // below: that column records the FIRST promote, this one is meant to advance
    // every time a human actually re-checks the record.
    lastReviewedAt: p.lastReviewedAt,
  });
}

// Field projection for the integration upsert.
function integrationEditableData(intg: PromoteIntegration): Record<string, unknown> {
  return compact({
    name: intg.name,
    mechanismKind: intg.mechanismKind,
    mechanismName: intg.mechanismName,
    direction: intg.direction,
    description: intg.description,
    listingUrl: intg.listingUrl,
    docsUrl: intg.docsUrl,
    website: intg.website,
    mechanismUrl: intg.mechanismUrl,
    pricingModel: intg.pricingModel,
    maturity: intg.maturity,
    notes: intg.notes,
    // AECI-616. Absent → untouched (see `vendorEditableData`).
    lastReviewedAt: intg.lastReviewedAt,
  });
}

/**
 * Plan the write for a **connector-evidenced pair** — the delivered tier's other
 * table (AECI-721 / `STAGE_1_5_SPEC.md` §13.1).
 *
 * Mirrors the `integrations` branch it replaces, with three shape differences the
 * destination forces (`DATABASE_SCHEMA.md` §9a.6):
 *
 *   1. **The pair is canonicalised** (`product_a_id < product_b_id`, a CHECK), so
 *      orientation moves out of the endpoint columns and into `direction`.
 *   2. **`direction` uses the CLAIM vocabulary** — once the pair is ordered,
 *      `one-way` no longer says which way. The mapping is the same lossless CASE
 *      the migration uses, and it must stay identical to it: promote and migration
 *      writing different encodings for the same edge is the drift that would make
 *      a re-promote silently flip an arrow.
 *   3. **There is no `mechanism_kind` column.** The lane answers "which mechanism",
 *      so the payload's `mechanismKind` is deliberately DROPPED rather than stored
 *      somewhere else. `mechanism_name` still carries the vendor's own label.
 *
 * The id is reused verbatim so a re-promote is an UPDATE rather than a duplicate —
 * the unique index is `(connector, a, b)`, so a second insert for the same triple
 * would fail the batch, and failing the batch is how a routine re-promote would
 * become an outage. Which requires knowing WHERE the id already lives, because the
 * migration preserves it across tables (`DATABASE_SCHEMA.md` §9a.6):
 *
 *   - `evidenced` — the id is already a `connector_evidenced_pairs` row (the common
 *     re-promote of a migrated edge). Plain UPDATE.
 *   - `integrations` — the id is still an `integrations` row that this promote is
 *     moving into the delivered tier (a curator added a third-party connector to an
 *     edge that used to be accountable-party). INSERT here with the id preserved,
 *     RE-HOME its claims off `integration_id` onto `connector_evidenced_pair_id`,
 *     then drop the source row — the same ordered dance migration 0027 performs, so
 *     the `ON DELETE CASCADE` never reaches a live claim or its attestations.
 *   - `null` — brand new (or a stale id, AECI-568). Mint a fresh id and INSERT.
 *
 * Reading only `integrations` (as the endpoint-move pre-read does) would send every
 * migrated edge down the `null` branch on its next promote and collide on the unique
 * index; sending it down a naive UPDATE branch would write nothing while deleting the
 * source row. Both are why `existing` names the table, not just the id.
 */
function planEvidencedPairWrite(args: {
  db: Db;
  intg: PromoteIntegration;
  sourceId: string;
  targetId: string;
  connectorProductId: string;
  /** Tri-state like the `integrations` branch (AECI-730): `undefined` = the payload's
   *  vendor did not resolve, so the column is LEFT UNTOUCHED rather than cleared. */
  builtByVendorId: string | null | undefined;
  /** The full {@link LocatedEdge}, not just `{ id, table }` — the move branch needs
   *  the source row's maintenance pair to carry it across (AECI-981). */
  existing: LocatedEdge | null;
}): { id: string; operation: 'created' | 'updated'; statements: BatchStmt[] } {
  const { db, intg, sourceId, targetId, connectorProductId, builtByVendorId, existing } = args;

  const sourceIsA = sourceId < targetId;
  const productAId = sourceIsA ? sourceId : targetId;
  const productBId = sourceIsA ? targetId : sourceId;
  // RE-ANCHOR, not translate (AECI-921). `intg.direction` already speaks the
  // stored vocabulary — `PromoteIntegrationSchema` normalises the legacy wire
  // spelling on the way in — but it is anchored to the PAYLOAD's
  // `sourceProduct` -> `targetProduct`, while this table's A/B is the id-sorted
  // canonical order its unique index depends on. When the payload's source is
  // NOT endpoint A, both arrows flip.
  //
  // Before AECI-921 this could only ever produce `a_to_b` or `b_to_a` from a
  // single `one-way`, because the wire had no way to say the flow ran the other
  // way. It can now, which is the whole point: a payload meaning `b_to_a` with a
  // source that is already A lands as `b_to_a` instead of being silently
  // straightened into `a_to_b`.
  const direction =
    intg.direction === null || intg.direction === undefined
      ? null
      : intg.direction === 'both'
        ? 'both'
        : (intg.direction === 'a_to_b') === sourceIsA
          ? 'a_to_b'
          : 'b_to_a';

  // `compact()` keeps the promote contract's absent-means-untouched rule (§3.6):
  // an omitted key is not written, so a re-push that carries only some fields does
  // not blank the rest. `mechanismKind` is absent by design — see the header.
  const editable = compact({
    name: intg.name,
    mechanismName: intg.mechanismName,
    description: intg.description,
    listingUrl: intg.listingUrl,
    docsUrl: intg.docsUrl,
    website: intg.website,
    mechanismUrl: intg.mechanismUrl,
    pricingModel: intg.pricingModel,
    maturity: intg.maturity,
    notes: intg.notes,
    lastReviewedAt: intg.lastReviewedAt,
  });
  // `builtByVendorId` rides `compact()` for the same reason the `integrations`
  // branch does (AECI-730): an unresolvable vendor must leave the stored value
  // alone, not blank it. The other three are NOT NULL / explicitly nullable and
  // are always written.
  const links = {
    connectorProductId,
    productAId,
    productBId,
    direction,
    ...compact({ builtByVendorId }),
  };

  if (existing?.table === 'evidenced') {
    return {
      id: existing.id,
      operation: 'updated',
      statements: [
        db
          .update(connectorEvidencedPairs)
          // The fence goes LAST so it overrides the plain `lastReviewedAt` that
          // `editable` carries (AECI-981).
          .set({
            ...editable,
            ...links,
            ...fencedLastReviewedAt(connectorEvidencedPairs, intg.lastReviewedAt),
          })
          .where(eq(connectorEvidencedPairs.id, existing.id)),
        // Belt-and-braces on the single-table invariant: an id must never live in
        // both tables. A clean evidenced row is not in `integrations`, so this is a
        // no-op then; it only bites if a prior partial state left a stale twin. A
        // CLAIMED twin is never deleted (AECI-1005): it is the vendor's row now.
        db
          .delete(integrations)
          .where(and(eq(integrations.id, existing.id), isNull(integrations.claimedAt))),
      ],
    };
  }

  if (existing?.table === 'integrations') {
    // Moving an accountable-party edge into the delivered tier, id preserved. Order
    // matters exactly as in migration 0027 step 8→9→11: INSERT the destination first
    // (so the re-home FK resolves), re-home the claims in ONE UPDATE (both anchor
    // columns at once keeps `claims_anchor_check`'s XOR satisfied), THEN drop the
    // source. Re-homing before the delete is what stops the `ON DELETE CASCADE` from
    // taking the claims and their attestations with it. `planClaimIngest` runs after
    // and reconciles the payload against these same rows (its pre-read saw them under
    // the identical `anchor_id`), so ids — and therefore vendor attestations — hold.
    // The frame does NOT hold on its own: when the source sorts second, the caller
    // re-anchors directions and vendor slots after this re-home (AECI-996).
    return {
      id: existing.id,
      operation: 'updated',
      statements: [
        // Carry the maintenance pair across — see the mirror branch in
        // `planIntegrationEdge` (AECI-981).
        db.insert(connectorEvidencedPairs).values({
          id: existing.id,
          ...editable,
          ...links,
          ...carriedMaintenance(existing.row, intg.lastReviewedAt),
        }),
        db
          .update(claims)
          .set({ connectorEvidencedPairId: existing.id, integrationId: null })
          .where(eq(claims.integrationId, existing.id)),
        db.delete(integrations).where(eq(integrations.id, existing.id)),
      ],
    };
  }

  const id = crypto.randomUUID();
  return {
    id,
    operation: 'created',
    statements: [db.insert(connectorEvidencedPairs).values({ id, ...editable, ...links })],
  };
}

/**
 * Where a caller-supplied `supabaseId` actually lives. The delivered tier spans TWO
 * tables and migration `0027` preserved ids verbatim across the move, so an id alone
 * does not say which one holds it (`DATABASE_SCHEMA.md` §9a.6).
 *
 * Both branches of the integration loop need this answer, and they need it BEFORE
 * routing, not after. That is the whole of AECI-888: the routed branch already read
 * both tables, the unrouted one read only `integrations`, and an id sitting in
 * `connector_evidenced_pairs` therefore looked DEAD — so a re-promote that cleared
 * `powered_by` minted a fresh row and left the old one unreachable forever (AECI-798,
 * the Roofr → QuickBooks Online orphan; write-up in
 * `scripts/ops/2026-09-roofr-qbo-connector-orphan/README.md`).
 *
 * `null` keeps its original meaning and only its original meaning: the pointer is dead
 * in BOTH tables, which is the AECI-568 stale-id case. An id that resolves on the other
 * side is not stale and must never be reported as such.
 */
type LocatedEdge =
  | { id: string; table: 'integrations'; row: LocatedIntegrationRow }
  | { id: string; table: 'evidenced'; row: LocatedEvidencedRow };

/**
 * The maintenance pair rides on both shapes for two jobs (AECI-981):
 *
 * 1. the fence's receipt — whether a supplied `lastReviewedAt` was refused; and
 * 2. the **cross-table move carry**. A `powered_by` re-route re-INSERTs the row
 *    under its existing id in the other table, and an INSERT that names neither
 *    column takes the `'aeci'` column default — silently un-vendoring an edge a
 *    vendor maintains. The SQL fence cannot help there: it guards UPDATEs, and a
 *    move is an insert plus a drop. Carrying both columns across is what keeps
 *    §13.3's "promote can never take a record off a vendor's name" true through a
 *    routing change.
 */
type LocatedMaintenance = {
  maintainedBy: string;
  lastReviewedAt: string | null;
};

type LocatedIntegrationRow = LocatedMaintenance & {
  sourceProductId: string;
  targetProductId: string;
  poweredByProductId: string | null;
  /** The AECI-1005 ownership fence's input — see {@link claimFenceRefuses}. */
  claimedAt: string | null;
  /** AECI-1011: `'vendor'` fences the row too — see {@link claimFenceRefuses}. */
  origin: string;
  /** AECI-1011: the stored owner and kind, for the UPDATE twin guard. */
  builtByVendorId: string | null;
  mechanismKind: string | null;
};

type LocatedEvidencedRow = LocatedMaintenance & {
  productAId: string;
  productBId: string;
  connectorProductId: string;
};

async function locateEdge(
  db: Db,
  supabaseId: string | null | undefined,
): Promise<LocatedEdge | null> {
  if (!supabaseId) return null;
  // `integrations` first: it is the larger table and the overwhelmingly common hit, so
  // the second read is skipped on most rows. Order is a cost choice only — the
  // single-table invariant means at most one of these can match.
  const intg = await db.query.integrations.findFirst({
    columns: {
      sourceProductId: true,
      targetProductId: true,
      poweredByProductId: true,
      maintainedBy: true,
      lastReviewedAt: true,
      claimedAt: true,
      origin: true,
      builtByVendorId: true,
      mechanismKind: true,
    },
    where: eq(integrations.id, supabaseId),
  });
  if (intg) return { id: supabaseId, table: 'integrations', row: intg };

  const pair = await db.query.connectorEvidencedPairs.findFirst({
    columns: {
      productAId: true,
      productBId: true,
      connectorProductId: true,
      maintainedBy: true,
      lastReviewedAt: true,
    },
    where: eq(connectorEvidencedPairs.id, supabaseId),
  });
  if (pair) return { id: supabaseId, table: 'evidenced', row: pair };

  return null;
}

/**
 * Plan the write for an edge landing in **`integrations`** — the delivered tier's
 * accountable-party table. The exact mirror of {@link planEvidencedPairWrite}, and it
 * exists for the same reason: WHERE the preserved id already lives decides the write.
 *
 *   - `integrations` — plain UPDATE (the ordinary re-promote).
 *   - `evidenced` — the edge is coming BACK out of the connector-delivered tier because
 *     its routing key was cleared. INSERT here with the id preserved, RE-HOME its claims
 *     off `connector_evidenced_pair_id`, then drop the source row.
 *   - `null` — brand new, or a dead id (AECI-568). Mint a fresh id and INSERT.
 *
 * **Statement order in the `evidenced` branch is the entire safety argument**, and it is
 * the same 0027 step 8→9→11 dance the forward move performs. `claims.connector_evidenced_pair_id`
 * is `ON DELETE CASCADE` and `attestations.claim_id` cascades off that, so dropping the
 * pair first destroys every claim on the edge AND the vendor attestations hanging from
 * them — silently, because ADR 0018 is explicit that `claims_anchor_check` cannot make a
 * delete fail. Re-homing first is the only protection there is.
 *
 * Both anchor columns move in ONE `UPDATE` so the CHECK's three-term sum never leaves 1
 * mid-statement. `anchor_id` is `coalesce()` over the three arms and the id is unchanged,
 * so `claims_identity_key` sees no movement from the move itself. The caller then
 * re-anchors directions and vendor slots out of the pair's A/B frame when the source is
 * B (AECI-996), so the row's ids hold even where its arrows flip.
 *
 * **This move is lossy on `mechanism_kind` and nothing can fix that here.**
 * `connector_evidenced_pairs` has no such column — the forward move drops the value
 * deliberately (see {@link planEvidencedPairWrite}) — so only the payload can supply it.
 * A push that clears `powered_by` without restating `mechanismKind` lands a NULL kind.
 * The column is nullable and the CHECK passes on NULL, so this is recorded rather than
 * guarded; `promote.spec.ts` asserts the loss so it stays a known property.
 */
function planIntegrationWrite(args: {
  db: Db;
  intg: PromoteIntegration;
  /** The two NOT NULL endpoints, plus whichever optional links resolved. Typed
   *  structurally rather than as `Record<string, unknown>` so Drizzle's insert overload
   *  can still see that `source_product_id` / `target_product_id` are supplied. */
  linkData: { sourceProductId: string; targetProductId: string } & Record<string, unknown>;
  existing: LocatedEdge | null;
}): { id: string; operation: 'created' | 'updated'; statements: BatchStmt[] } {
  const { db, intg, linkData, existing } = args;
  const editable = integrationEditableData(intg);

  if (existing?.table === 'integrations') {
    return {
      id: existing.id,
      operation: 'updated',
      statements: [
        db
          .update(integrations)
          // The fence goes LAST so it overrides the plain `lastReviewedAt` that
          // `integrationEditableData` carries (AECI-981).
          .set({
            ...editable,
            ...linkData,
            ...fencedLastReviewedAt(integrations, intg.lastReviewedAt),
          })
          .where(eq(integrations.id, existing.id)),
        // Belt-and-braces on the single-table invariant, mirroring the evidenced branch:
        // an id must never live in both tables. A clean `integrations` row has no twin,
        // so this is a no-op then; it only bites if a prior partial state left one.
        db.delete(connectorEvidencedPairs).where(eq(connectorEvidencedPairs.id, existing.id)),
      ],
    };
  }

  if (existing?.table === 'evidenced') {
    return {
      id: existing.id,
      operation: 'updated',
      statements: [
        // The maintenance pair is carried across explicitly (AECI-981): this is an
        // INSERT, so omitting it would take the `'aeci'` column default and un-vendor
        // an edge the vendor maintains. `editable` may also carry a `lastReviewedAt`
        // the payload sent; the carry goes last, and it wins for the same reason the
        // UPDATE fence does.
        db.insert(integrations).values({
          id: existing.id,
          ...editable,
          ...linkData,
          ...carriedMaintenance(existing.row, intg.lastReviewedAt),
        }),
        db
          .update(claims)
          .set({ integrationId: existing.id, connectorEvidencedPairId: null })
          .where(eq(claims.connectorEvidencedPairId, existing.id)),
        db.delete(connectorEvidencedPairs).where(eq(connectorEvidencedPairs.id, existing.id)),
      ],
    };
  }

  const id = crypto.randomUUID();
  return {
    id,
    operation: 'created',
    statements: [db.insert(integrations).values({ id, ...editable, ...linkData })],
  };
}

/** The same two products, in either order. The twin guard's pair test: a
 *  direction swap (AECI-920) is not a key change, and strong matching is
 *  orientation-blind anyway. */
function samePair(a: readonly [string, string], b: readonly [string, string]): boolean {
  return (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]);
}

/**
 * The two endpoint product ids of a pre-update edge, whichever anchor table it sits
 * in. `connector_evidenced_pairs` names them `product_a`/`product_b` and stores them
 * canonically; `integrations` names them `source`/`target` and does not. Both are
 * "the two products whose slugs make this pair's URL", which is all
 * {@link endpointMoveFrom} needs.
 */
function locatedEndpointPair(located: LocatedEdge | null): readonly [string, string] | null {
  if (!located) return null;
  return located.table === 'integrations'
    ? [located.row.sourceProductId, located.row.targetProductId]
    : [located.row.productAId, located.row.productBId];
}

/**
 * Did this edge's pair-page URL just move? (AECI-953 / `STAGE_1_5_SPEC.md` §7.2a.)
 *
 * A re-pointed endpoint keeps the edge's id and updates its public row in place, but
 * the pair page is keyed by the two product SLUGS — so the URL moves and the old one
 * serves 200 + `noindex` with no redirect. AECI-726 did that to 37 live Procore edges
 * and AECI-950 to 15 more. The `integration_endpoint_moves` row is what lets the pair
 * resolver 301 instead.
 *
 * Returns the two OLD endpoint ids when the pair changed, `null` when it did not —
 * and that second case is the load-bearing one: an ordinary re-promote restates the
 * same endpoints, so it must plan no statement and no audit row. Comparing the two
 * pairs UNORDERED is deliberate — a promote that merely swaps `source` and `target`
 * (upstream orients rows by builder, and AECI-920 is correcting a population of
 * inverted rows) changes the edge's direction, not its URL.
 *
 * Arm-agnostic by design: the delivered tier spans `integrations` and
 * `connector_evidenced_pairs` (§13.1) and a pair page renders both, so both callers
 * use this.
 *
 * ── THE ROW ITSELF IS PLANNED LATER, AND IT HAS TO BE (AECI-991) ──────────────
 *
 * `integration_endpoint_moves` is keyed on the two **slugs** now, not the two ids,
 * because an id-keyed row cascades away with the product it names — which is exactly
 * what a merge-then-retire deletes. Endpoint slugs are not in hand inside the
 * integration loop: a freshly-created endpoint has no readable row yet, so they are
 * resolved in ONE batched read after the loop (the `sourceSlug`/`targetSlug` backfill
 * pass below), which already had to resolve these same ids for the pair cache tags.
 * The INSERT and its audit row are emitted there, still inside the SAME `db.batch`
 * as the endpoint update — §26.1 is about the batch, not about the line number.
 */
function endpointMoveFrom(args: {
  /** The two endpoint product ids BEFORE this promote, in any order. */
  from: readonly [string, string];
  /** The two endpoint product ids AFTER it, in any order. */
  to: readonly [string, string];
}): readonly [string, string] | null {
  const [fromA, fromB] = [...args.from].sort();
  const [toA, toB] = [...args.to].sort();
  if (fromA === toA && fromB === toB) return null;
  return [fromA, fromB];
}

/**
 * Build one AECI-730 report entry for an optional integration link that didn't
 * resolve, so the column was left out of the write.
 *
 * `operation` is the enclosing integration's own outcome, and it decides what the
 * stored column now holds: a **create** leaves it NULL (`unset`), an **update**
 * leaves whatever was already there (`preserved`) — which is the clobber guard.
 */
function unresolvedLinkEntry(
  intgRef: string,
  field: PromoteUnresolvedLink['field'],
  ref: EntityRef | null | undefined,
  operation: PromoteOperation,
): PromoteUnresolvedLink {
  const outcome = operation === 'updated' ? 'preserved' : 'unset';
  const { payloadKey, column } =
    field === 'powered_by'
      ? { payloadKey: 'poweredByProduct', column: 'powered_by_product_id' }
      : { payloadKey: 'builtByVendor', column: 'built_by_vendor_id' };
  return {
    ref: intgRef,
    field,
    supabaseId: ref?.supabaseId ?? null,
    outcome,
    reason:
      `${payloadKey} ${ref?.supabaseId ?? ref?.ref ?? '(unspecified)'} is not promoted in AECi; ` +
      `${column} ${outcome === 'preserved' ? 'left unchanged' : 'left unset'}`,
  };
}

/**
 * The §26.5 log envelope for one `audit_log` row. Split out from the old
 * `AuditLogForwarder` closure so the whole set can be posted in ONE request per
 * vendor — see the `logBatchToPosthog` call in {@link dispatchPromoteHooks}.
 */
export function auditLogEvent(entry: Omit<AuditLogEntry, 'metadata'>): PosthogLogEvent {
  return {
    level: 'info',
    message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
    action: entry.action,
    entity_type: entry.entityType ?? undefined,
    entity_id: entry.entityId ?? undefined,
    source: 'review-app-promote',
  };
}

/**
 * Ceiling on how long a post-commit hook may stay unsettled before this gives up
 * on it (AECI-666).
 *
 * Not a request timeout — the hooks are already fire-and-forget and nothing is
 * waiting on them. It exists because a `fetch` the runtime cancels for holding a
 * connection too long returns a promise that **never settles at all**: no
 * resolve, no reject, so the transport's own `catch` cannot see it. Left
 * unguarded, that promise sits in `waitUntil` until the runtime kills the whole
 * invocation as hung, taking every *other* in-flight hook with it. Losing one
 * hook is survivable; losing the invocation is what turned this into a silent
 * outage across ~8% of production promotes.
 *
 * 20s, not 30s: `waitUntil` is documented to extend execution for *up to* 30s
 * after the response, so a 30s watchdog races the platform tearing the
 * invocation down and the warning — the whole point — might never be emitted.
 * 20s is ~20x the slowest healthy hook (a few D1 reads plus 1-3 Algolia batch
 * calls) and comfortably inside the budget.
 *
 * Note the watchdog also suppresses the hang *detector* for its whole duration:
 * a pending timer means the event loop is not empty, which is the condition the
 * runtime kills on. So the invocation ends cleanly on the timeout path rather
 * than being cancelled part-way through the other hooks.
 */
const HOOK_SETTLE_TIMEOUT_MS = 20_000;

/**
 * Hand `task` to `waitUntil` behind a watchdog: whichever way it ends, the
 * promise `waitUntil` sees always settles.
 *
 * The timeout branch is the whole point — it converts a wedged transport from an
 * invocation-killing hang into one `console.warn` line in Workers Observability,
 * which is the signal that was missing while this failure mode ran undetected.
 */
export function dispatchHook(rc: PromoteRunCtx, name: string, task: Promise<unknown>): void {
  rc.waitUntil(
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.warn(
          `promote hook "${name}" did not settle within ${HOOK_SETTLE_TIMEOUT_MS}ms — abandoning it`,
        );
        resolve();
      }, HOOK_SETTLE_TIMEOUT_MS);
      task
        .catch((error: unknown) => {
          // The transports swallow their own failures, so reaching here means an
          // unexpected throw. Never let it become an unhandled rejection.
          console.warn(`promote hook "${name}" threw`, error);
        })
        .finally(() => {
          clearTimeout(timer);
          resolve();
        });
    }),
  );
}

export const AUDIT_META = { source: 'review-app-promote' } as const;

// ─── Claimed-vendor block reasons (AECI-520) ─────────────────────────────────
// Constants, not interpolated strings: the review app surfaces `skipped[].reason`
// verbatim, and the causal vendor ids belong in the `promote.blocked` audit row,
// not in a message specs and operators have to pattern-match.
const BLOCKED_VENDOR_REASON =
  'vendor is claimed by a vendor admin; review-app writes to claimed vendors are blocked';
const BLOCKED_PRODUCT_REASON =
  'product belongs to a claimed vendor; review-app writes to claimed vendors are blocked';
const BLOCKED_INTEGRATION_REASON =
  'an endpoint product belongs to a claimed vendor; review-app writes to claimed vendors are blocked';

// ─── Maintenance-fence reasons (AECI-981) ────────────────────────────────────
// Same constant discipline as the block reasons above, and the entity type lives
// in the text because a `review-signal` entry carries only the payload `ref`, which
// is unique within its own array and not across them.
const REFUSED_REVIEW_SIGNAL_VENDOR =
  'vendor is vendor-maintained; lastReviewedAt is not written to a record AECi does not maintain';
const REFUSED_REVIEW_SIGNAL_PRODUCT =
  'product is vendor-maintained; lastReviewedAt is not written to a record AECi does not maintain';
const REFUSED_REVIEW_SIGNAL_INTEGRATION =
  'integration is vendor-maintained; lastReviewedAt is not written to a record AECi does not maintain';

// ─── Ownership-fence reason (AECI-1005) ──────────────────────────────────────
// Same constant discipline. `kind: 'integration'`, like the AECI-520 edge block,
// because the whole edge is refused, not one field of it.
export const REFUSED_CLAIMED_INTEGRATION =
  'integration is claimed by its owner; promote writes nothing to a vendor-owned integration';

// ─── Cache purge (AECI-105) ──────────────────────────────────────────────────

/**
 * Best-effort, post-commit edge-cache invalidation for a promote. No-ops when
 * `CACHE_PURGE_QUEUE` is unbound (local `pnpm dev:bound`, PR previews — there is
 * no edge cache there), or when nothing cacheable changed.
 *
 * WC-5 (AECI-319 / ADR 0020 §3): this ENQUEUES onto `aeci-cache-purge-{env}`
 * rather than calling Cloudflare's zone purge over HTTPS. Under native Workers
 * Cache the SSR responses live in the SSR Worker's own cache, which a zone-level
 * purge cannot reach — `ctx.cache.purge()` is entrypoint-scoped, and that
 * entrypoint is in a different Worker. The SSR Worker consumes the message and
 * issues the purge itself. The HTTP transport (`callCloudflarePurge` +
 * `CF_PURGE_API_TOKEN`) was retired in WC-10 (AECI-324).
 *
 * Every batch goes in ONE `sendBatch()` rather than a concurrent `send()` per
 * batch (AECI-666): a Queue producer call counts against the same per-invocation
 * connection budget as `fetch`, and the promote's post-commit tail is already
 * close to it. Latent rather than active today — `CACHE_PURGE_QUEUE_MAX_TAGS` is
 * 1000, so a promote's tag set is essentially always one batch — but the shape
 * is the rule, and it stops being latent the moment that cap moves. `sendBatch`
 * itself caps at 100 messages / 256 KB; chunk here if the tag cap ever drops far
 * enough for that to bite. A failed enqueue is logged (a `warn`) and swallowed so
 * it never affects the committed promote.
 *
 * `removedTradeSlugs` carries the trades this promote *dropped* from the product
 * (AECI-542). The response echoes only what was SET, so a re-promote that clears a
 * trade would otherwise purge nothing — and because the trade facet is publication-
 * gated (`TRADE_PUBLISH_MIN_PRODUCTS`), a removal can un-publish a term and change
 * `/trades`, the facet sidebar, and the sitemap. See `CACHE_STRATEGY.md` §2.
 */
async function purgeAfterPromote(
  rc: PromoteRunCtx,
  response: PromoteResponse,
  removedTradeSlugs: string[] = [],
  db?: Db,
): Promise<void> {
  const queue = rc.env.CACHE_PURGE_QUEUE;
  if (!queue) return;

  // AECI-710 / §13.3b: the hosts this product is built within. A host page lists
  // its extensions, and a NEWLY added extension is the one case its embedded tags
  // cannot reach (`CACHE_STRATEGY.md` §3 rule 7). Read post-commit, so it is the
  // pushed set; a removed host still carries the extension's embedded tag. A failed
  // read costs only those host tags, so it must not cost the rest of the purge.
  let hostSlugs: string[] = [];
  if (db && response.product) {
    try {
      hostSlugs = await extensionHostSlugs(db, response.product.id);
    } catch (error) {
      logToPosthog(rc, rc.env, rc.request, {
        level: 'warn',
        message: 'aeci.api.promote.extension_host_read_failed',
        source: 'review-app-promote',
        product_id: response.product.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const tags = cacheTagsForPromote(response, { removedTradeSlugs, extensionHostSlugs: hostSlugs });
  if (tags.length === 0) return;

  const batches: string[][] = [];
  for (let i = 0; i < tags.length; i += CACHE_PURGE_QUEUE_MAX_TAGS) {
    batches.push(tags.slice(i, i + CACHE_PURGE_QUEUE_MAX_TAGS));
  }

  try {
    await queue.sendBatch(batches.map((batch) => ({ body: { tags: batch, source: 'promote' } })));
  } catch (error) {
    // `sendBatch` is all-or-nothing, so report the whole tag set rather than a
    // single batch — every one of these tags is now unpurged.
    logPurgeEnqueueFailure(rc, tags, error instanceof Error ? error.message : String(error));
  }
}

export function logPurgeEnqueueFailure(rc: PromoteRunCtx, batch: string[], reason: string): void {
  logToPosthog(rc, rc.env, rc.request, {
    level: 'warn',
    message: 'aeci.api.promote.cache_purge_enqueue_failed',
    source: 'review-app-promote',
    reason,
    tags: batch.join(','),
    tags_count: batch.length,
  });
}

// ─── Algolia index sync (AECI-139) ───────────────────────────────────────────

/**
 * Post-commit Algolia upsert seam. Default re-queries the touched rows by id and
 * pushes them to the env's indexes via the Drizzle `algolia-sync` core, gated on
 * the Algolia secrets. Injected for tests. Never throws.
 */
export type PromoteAlgoliaSync = (rc: PromoteRunCtx, response: PromoteResponse) => Promise<void>;

const defaultAlgoliaSync: PromoteAlgoliaSync = (rc, response) =>
  // Post-commit best-effort re-read for indexing. It re-queries the just-promoted
  // rows by id, so it MUST see its own write: resume the write session via its
  // bookmark (`rc.bookmark()`, filled in from the commit step's result) rather than
  // starting a fresh `'first-unconstrained'` session — otherwise a lagging replica could index
  // stale/missing rows once read replication is enabled. Falls back to the read
  // default when no bookmark exists (single-DB local/test). (AECI-250)
  syncAlgoliaAfterPromote(rc, response, getDb(rc.env, { bookmark: rc.bookmark() }).db);

async function syncAlgoliaAfterPromote(
  rc: PromoteRunCtx,
  response: PromoteResponse,
  db: Db,
): Promise<void> {
  const creds = { appId: rc.env.ALGOLIA_APP_ID, apiKey: rc.env.ALGOLIA_ADMIN_KEY };
  const env: AlgoliaEnv = rc.env.ENV ?? 'development';
  const started = Date.now();
  try {
    const results = await syncPromoteTargets(db, fetch, creds, env, {
      product: response.product ? { id: response.product.id } : null,
      vendors: response.vendors.map((v) => ({ id: v.id })),
      integrations: response.integrations.map((i) => ({ id: i.id })),
    });
    const sink: SyncMetricSink = {
      count: (metric, value, tags) => submitCount(rc, rc.env, rc.request, metric, value, tags),
      distribution: (metric, value, tags) =>
        submitDistribution(rc, rc.env, rc.request, metric, value, tags),
    };
    emitAlgoliaSyncMetrics(sink, 'promote', results, Date.now() - started);
    for (const result of results) {
      if (!result.ok) logAlgoliaSyncFailure(rc, result.entity, result.error ?? 'unknown');
    }
  } catch (error) {
    logAlgoliaSyncFailure(rc, 'all', error instanceof Error ? error.message : String(error));
  }
}

function logAlgoliaSyncFailure(rc: PromoteRunCtx, entity: string, reason: string): void {
  logToPosthog(rc, rc.env, rc.request, {
    level: 'warn',
    message: 'aeci.api.promote.algolia_sync_failed',
    source: 'review-app-promote',
    entity,
    reason,
  });
}

// ─── IndexNow buffering (AECI-236, rebuilt in AECI-826) ──────────────────────

/**
 * Post-commit IndexNow seam. Builds the affected public URLs from the promote
 * response (`affectedUrlsForPromote`) and **appends them to the `indexnow_queue`
 * buffer**, gated on `INDEXNOW_KEY` + `PUBLIC_SITE_URL`. Records
 * `aeci.indexnow.queued{source:promote}` and warn-logs a failure — never throws,
 * never blocks the committed promote (§20.2 / §20.5). Injected for tests (mirrors
 * the Algolia seam).
 *
 * ─── It used to submit here, and that was the defect ──────────────────────────
 *
 * From AECI-236 to AECI-826 this called `callIndexNow` directly, so one promote
 * meant one outbound request. A bulk curation session fired eleven inside seven
 * minutes on 2026-09-07, and **every production submission across 2026-09-07..09
 * returned HTTP 429 — twenty-three of twenty-three, zero successes.** The URL
 * count per request was never the problem (IndexNow takes 10,000; our largest
 * carried 107). Request frequency was.
 *
 * So the hook buffers and the twenty-minute `indexnow-drain` cron
 * (`lib/indexnow-drain.ts`) submits, collapsing any number of promotes into one
 * request. Three secondary wins fall out of the move: the buffer's unique `url`
 * dedupes a product promoted twice inside one window, which the old design could
 * not do at all; a D1 insert is far more likely to survive than an outbound
 * `fetch`; and the promote's post-commit block gives back a Worker connection,
 * which is the scarce resource AECI-666 was about.
 *
 * **Do not restore a direct submit here.** If you need a new IndexNow producer,
 * append to the buffer.
 *
 * `tradeUrls` carries the trade inputs the response can't supply (AECI-546): the
 * touched trades that are PUBLISHED post-commit, plus the removed slugs. It
 * arrives as a promise so the one D1 read backing it is never awaited on the
 * request path — see `resolveTradeUrlOptions`.
 */
export type PromoteIndexNowNotify = (
  rc: PromoteRunCtx,
  response: PromoteResponse,
  tradeUrls: Promise<AffectedUrlOptions>,
) => Promise<void>;

const defaultIndexNowNotify: PromoteIndexNowNotify = (rc, response, tradeUrls) =>
  // The promote's write bookmark (`rc.bookmark()`) anchors the append at the same
  // D1 session as the commit, matching the home-stats seam below. It is a write,
  // so replica lag cannot corrupt it — but pinning the session keeps the whole
  // post-commit tail on one primary and costs nothing (AECI-250).
  bufferIndexNowAfterPromote(
    rc,
    response,
    tradeUrls,
    getDb(rc.env, { bookmark: rc.bookmark() }).db,
  );

/** Exported for the promote spec: append the affected public URLs to
 *  `indexnow_queue`. `db` is a parameter rather than a `getDb` call inside,
 *  following `refreshHomeStatsAfterPromote` — the in-memory harness has no `DB`
 *  binding, so a self-resolving hook is untestable end to end. */
export async function bufferIndexNowAfterPromote(
  rc: PromoteRunCtx,
  response: PromoteResponse,
  tradeUrls: Promise<AffectedUrlOptions>,
  db: Db,
): Promise<void> {
  const key = rc.env.INDEXNOW_KEY;
  const siteUrl = rc.env.PUBLIC_SITE_URL;
  if (!key || !siteUrl) return;

  const urlList = affectedUrlsForPromote(response, siteUrl, await tradeUrls);
  if (urlList.length === 0) return;

  // Still validated here even though the drain re-derives it: an unparseable
  // PUBLIC_SITE_URL means every URL we are about to buffer is malformed, and
  // catching it at the producer keeps junk out of the table rather than making the
  // drain discard it twenty minutes later.
  try {
    new URL(siteUrl);
  } catch {
    logIndexNowFailure(rc, urlList.length, 'invalid_public_site_url');
    return;
  }

  try {
    const queued = await enqueueIndexNowUrls(db, urlList);
    submitCount(rc, rc.env, rc.request, 'aeci.indexnow.queued', queued, ['source:promote']);
  } catch (error) {
    // Fail-open, exactly as the submission did: the promote is committed and a
    // missed ping costs discovery latency, never correctness. The sitemap's
    // `<lastmod>` remains the primary discovery path (§20.5 step 5).
    logIndexNowFailure(
      rc,
      urlList.length,
      error instanceof Error ? error.message : 'indexnow_enqueue_failed',
    );
  }

  // The Google half, in the SAME hook rather than a second one (AECI-945).
  //
  // Two reasons it rides along here instead of being dispatched separately.
  // Both queues are fed by the same event and gated on the same pair, so a
  // second `dispatchHook` would double the post-commit fan-out to say the same
  // thing twice. And the trade publication read backing `tradeUrls` has already
  // been awaited above, so sharing the hook means one D1 read rather than two.
  //
  // Its own try/catch, though: a Google-queue failure must not suppress a
  // successful IndexNow buffer or vice versa. They are independent discovery
  // channels and one being broken is not a reason to lose the other.
  try {
    const entries = gscRecrawlEntriesForPromote(response, siteUrl, await tradeUrls);
    const touched = await enqueueGscRecrawl(db, entries, 'promote');
    submitCount(rc, rc.env, rc.request, 'aeci.gsc_recrawl.queued', touched, ['source:promote']);
  } catch (error) {
    // Fail-open for the same reason the IndexNow half is: the promote is
    // committed, and a missing worklist row costs the operator a manual
    // Request Indexing they would otherwise have made. The sitemap's `<lastmod>`
    // is still the passive discovery path underneath both (§20.5 step 5).
    logToPosthog(rc, rc.env, rc.request, {
      level: 'warn',
      message: 'aeci.api.promote.gsc_recrawl_failed',
      source: 'review-app-promote',
      reason: error instanceof Error ? error.message : 'gsc_recrawl_enqueue_failed',
    });
  }
}

function logIndexNowFailure(rc: PromoteRunCtx, urlsCount: number, reason: string): void {
  logToPosthog(rc, rc.env, rc.request, {
    level: 'warn',
    message: 'aeci.api.promote.indexnow_failed',
    source: 'review-app-promote',
    reason,
    urls_count: urlsCount,
  });
}

/**
 * Resolves the publication-gated trade inputs the IndexNow URL set needs
 * (AECI-546), as a promise the caller creates but never awaits.
 *
 * Written for two consumers when the Google Indexing ping was the second one;
 * AECI-747 removed that, so there is one consumer today. The shape is kept because
 * the other two properties are still what it is for:
 *   - **No added latency.** The read starts as the handler returns and resolves
 *     inside `waitUntil`, so the promote response never waits on it.
 *   - **Fails to the safe side.** A rejected read resolves to `{}`, which buffers
 *     no trade URLs at all rather than risking a sub-floor (noindex) submission.
 *     That guard matters MORE since AECI-826, not less: a bad trade URL written to
 *     `indexnow_queue` outlives the promote and is submitted up to twenty minutes
 *     later by a job with no way to re-derive whether it should have been.
 *
 * Skipped entirely when no key is configured or no trade was touched, so the
 * overwhelming majority of promotes — trades are sparse by design — pay nothing.
 */
function resolveTradeUrlOptions(
  rc: PromoteRunCtx,
  db: Db,
  response: PromoteResponse,
  removedTradeSlugs: string[],
): Promise<AffectedUrlOptions> {
  const siteUrl = rc.env.PUBLIC_SITE_URL;
  // IndexNow is the only channel left (AECI-747 removed the Google Indexing API
  // submission — Google supports it for `JobPosting`/`BroadcastEvent` only, which
  // is nothing we publish). Same gate as the buffer write it feeds.
  const pingConfigured = Boolean(siteUrl) && Boolean(rc.env.INDEXNOW_KEY);
  const touched = touchedTradeSlugs(response, removedTradeSlugs);
  if (!pingConfigured || touched.length === 0) return Promise.resolve({});

  return resolvePublishedTradeSlugs(db, touched)
    .then((publishedTradeSlugs) => ({ publishedTradeSlugs, removedTradeSlugs }))
    .catch(() => ({}));
}

// ─── Home-stats refresh (AECI-305) ───────────────────────────────────────────

/** The edge-cache tag the home page (`/`) carries — the SSR emitter is
 *  `apps/web/src/server/cache-tags.ts` → `cacheTagInputsForPath('/')`. Kept in
 *  lockstep with that side per `docs/CACHE_STRATEGY.md` §2: purging it here evicts
 *  the cached home HTML so it repaints with the fresh counts. */
const HOME_CACHE_TAG = 'index:home';

/**
 * Post-commit home-stats refresh seam. The home page's credibility strip + stats
 * cards read the `home.*` `stats_cache` keys, which are **never live-aggregated**
 * (`routes/stats.ts` / §10) and were previously written ONLY by the daily 07:00 UTC
 * cron (`scheduled.ts`). So a promote that added products/vendors/integrations left
 * the home banner frozen at the last cron snapshot until the next run. This
 * recomputes the cache immediately after the promote commits, then purges the home
 * page's edge cache so the next render repaints with the fresh numbers.
 *
 * Ordering is load-bearing: refresh `stats_cache` FIRST, purge `/` SECOND, so any
 * render after the purge reads the already-fresh cache (and never re-caches stale
 * HTML for another edge TTL). Injected for tests; never throws. Mirrors the Algolia
 * seam above.
 */
export type PromoteHomeStatsRefresh = (rc: PromoteRunCtx) => Promise<void>;

const defaultHomeStatsRefresh: PromoteHomeStatsRefresh = (rc) =>
  // Re-read with the promote's write bookmark (`rc.bookmark()`, filled in from the
  // commit step's result) so the
  // recompute's COUNT(*)s see the just-committed rows even once D1 read replication
  // is enabled — otherwise a lagging replica would recount the stale catalog. Falls
  // back to the read default when no bookmark exists (single-DB local/test). (AECI-250)
  refreshHomeStatsAfterPromote(rc, getDb(rc.env, { bookmark: rc.bookmark() }).db);

/** Exported for the promote spec: recompute the `home.*` `stats_cache` keys, then
 *  purge the home page. Not the injected seam (`PromoteHomeStatsRefresh`) — that's
 *  the thin `getDb`-binding wrapper above; this is the testable body. */
export async function refreshHomeStatsAfterPromote(rc: PromoteRunCtx, db: Db): Promise<void> {
  const started = Date.now();
  let result: HomeStatsResult;
  try {
    result = await runHomeStats(db, new Date());
  } catch (error) {
    // `runHomeStats` is per-key best-effort and never throws on a compute/write
    // failure, so reaching here is a pre-compute crash. Count an outright failure +
    // error-log; never rethrow — the promote already committed (this is a
    // post-commit task).
    submitCount(rc, rc.env, rc.request, 'aeci.stats.compute', 1, [
      'trigger:promote',
      'outcome:failed',
    ]);
    logToPosthog(rc, rc.env, rc.request, {
      level: 'error',
      message: 'aeci.stats.compute.crashed',
      source: 'review-app-promote',
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const sink: StatsMetricSink = {
    count: (metric, value, tags) => submitCount(rc, rc.env, rc.request, metric, value, tags),
    distribution: (metric, value, tags) =>
      submitDistribution(rc, rc.env, rc.request, metric, value, tags),
  };
  emitHomeStatsMetrics(sink, 'promote', result, Date.now() - started);
  for (const k of result.keys) {
    if (k.status !== 'failed') continue;
    logToPosthog(rc, rc.env, rc.request, {
      level: 'warn',
      message: `aeci.stats.compute ${k.key} status=failed`,
      source: 'review-app-promote',
      key: k.key,
      ...(k.error ? { reason: k.error } : {}),
    });
  }

  // Invalidate the home page's edge cache now that `stats_cache` is fresh, so the
  // next render repaints with the new counts. Best-effort, post-refresh; no-ops
  // without the queue producer (local/preview don't edge-cache, so the refresh
  // above already suffices). Wrapped so a `queue.send` throw can't reject this
  // post-commit task — the error is recorded, never rethrown. Queue rather than
  // zone purge for the WC-5 reason in `purgeAfterPromote`.
  const queue = rc.env.CACHE_PURGE_QUEUE;
  if (!queue) return;
  try {
    await queue.send({ tags: [HOME_CACHE_TAG], source: 'promote' });
  } catch (error) {
    logPurgeEnqueueFailure(
      rc,
      [HOME_CACHE_TAG],
      error instanceof Error ? error.message : String(error),
    );
  }
}

// ─── Skipped-entity observability ────────────────────────────────────────────

/**
 * Surface a promote's `skipped[]` (§4) in Datadog. A promote returns `200` even
 * when it could not link some entities — an integration/extension whose far
 * endpoint isn't promoted yet, a usefulness group, a claim `dataObject`, or a
 * trade that didn't resolve — so the response looks like a clean success and the
 * metrics layer (`aeci.api.query.duration_ms{status_class:2xx}`) is blind to the
 * partial data loss. Without this the only record of a curator's silently-dropped
 * push lives in the HTTP response body, which the review app must itself inspect.
 *
 * Emits a single `warn` log detailing every `{ ref, kind, reason }` plus per-kind
 * counts, and an `aeci.api.promote.skipped` count (value = per-kind skip count,
 * so query with `sum:`; `kind` tag ∈ integration/extension/usefulness/claim/trade)
 * as the alertable signal. Best-effort + fire-and-forget: the transport self-gates
 * on `POSTHOG_PROJECT_KEY` and dispatches via `ctx.waitUntil`, so this never affects the
 * committed promote. No-op when nothing was skipped.
 */
export function logPromoteSkips(rc: PromoteRunCtx, skipped: PromoteSkipped[]): void {
  if (skipped.length === 0) return;

  const countByKind = skipped.reduce<Record<string, number>>((acc, s) => {
    acc[s.kind] = (acc[s.kind] ?? 0) + 1;
    return acc;
  }, {});

  logToPosthog(rc, rc.env, rc.request, {
    level: 'warn',
    message: 'aeci.api.promote.partial_skipped',
    source: 'review-app-promote',
    outcome: 'partial',
    skipped_count: skipped.length,
    // Per-kind counts as flat scalars for faceting, plus the full detail array so
    // Datadog alone answers "what didn't land and why" (each `{ref, kind, reason}`).
    ...Object.fromEntries(Object.entries(countByKind).map(([k, n]) => [`skipped_${k}`, n])),
    skipped,
  });

  for (const [kind, n] of Object.entries(countByKind)) {
    submitCount(rc, rc.env, rc.request, 'aeci.api.promote.skipped', n, [
      'source:promote',
      `kind:${kind}`,
    ]);
  }
}

/**
 * Surface a promote's stale-`supabaseId` fallbacks (AECI-568) in Datadog. The ingest
 * upserts by the caller-supplied id, so an id whose row no longer exists used to
 * produce a no-op `UPDATE` reported as `operation: 'updated'` with an empty slug —
 * invisible everywhere. The ingest now falls back to **create**, which self-heals the
 * dead pointer on the next write-back, but a silent self-heal is how the *next* drift
 * ships: it means the review app's copy of that id was wrong, and nothing else says so.
 *
 * Mirrors {@link logPromoteSkips}: one `warn` log with every `{ ref, kind, supabaseId }`
 * plus an `aeci.api.promote.stale_id` count (value = per-kind count, so query with
 * `sum:`; `kind` tag ∈ vendor/product/integration). Fire-and-forget over the same
 * self-gating transport, so it never affects the committed promote. No-op when clean.
 */
function logPromoteStaleIds(rc: PromoteRunCtx, staleSupabaseIds: PromoteStaleId[]): void {
  if (staleSupabaseIds.length === 0) return;

  const countByKind = staleSupabaseIds.reduce<Record<string, number>>((acc, s) => {
    acc[s.kind] = (acc[s.kind] ?? 0) + 1;
    return acc;
  }, {});

  logToPosthog(rc, rc.env, rc.request, {
    level: 'warn',
    message: 'aeci.api.promote.stale_supabase_id',
    source: 'review-app-promote',
    outcome: 'recreated',
    stale_id_count: staleSupabaseIds.length,
    ...Object.fromEntries(Object.entries(countByKind).map(([k, n]) => [`stale_${k}`, n])),
    stale_supabase_ids: staleSupabaseIds,
  });

  for (const [kind, n] of Object.entries(countByKind)) {
    submitCount(rc, rc.env, rc.request, 'aeci.api.promote.stale_id', n, [
      'source:promote',
      `kind:${kind}`,
    ]);
  }
}

/**
 * Surface a promote's unresolved optional links (AECI-730) in the observability
 * plane. The ingest
 * writes an integration whose `poweredByProduct` / `builtByVendor` doesn't resolve
 * *without* that column, which used to be invisible everywhere: no `skipped[]` entry
 * (the row DID land), no `staleSupabaseIds` entry, no metric, no log. The only trace
 * was the absence of `poweredBySlug` from the result, which nobody was told to check
 * — so the NULL-FK population re-accrued silently on every promote and could only be
 * found by an offline sweep (`scripts/ops/2026-08-powered-by-backfill/`).
 *
 * **Deliberately `info`, and deliberately NOT folded into {@link logPromoteSkips}.**
 * Zapier and Workato are parked permanently (AECI-700), so every promote of an
 * endpoint carrying one of their edges fires this — forever, by design. A `warn` on
 * the expected steady state, or a bump to `aeci.api.promote.skipped` (which means
 * "something wasn't written"), would turn a real signal into noise an operator learns
 * to ignore, which is the exact failure mode this exists to fix. The actionable read
 * is a *rise* in `field:powered_by`, not its non-zero-ness.
 *
 * Shape mirrors {@link logPromoteStaleIds}: one log with every
 * `{ ref, field, supabaseId, outcome }` plus per-field counts, and an
 * `aeci.api.promote.unresolved_link` count (value = per-field count, so query with
 * `sum:`). Fire-and-forget over the same self-gating transport. No-op when clean.
 */
function logPromoteUnresolvedLinks(
  rc: PromoteRunCtx,
  unresolvedLinks: PromoteUnresolvedLink[],
): void {
  if (unresolvedLinks.length === 0) return;

  const countByField = unresolvedLinks.reduce<Record<string, number>>((acc, l) => {
    acc[l.field] = (acc[l.field] ?? 0) + 1;
    return acc;
  }, {});

  logToPosthog(rc, rc.env, rc.request, {
    level: 'info',
    message: 'aeci.api.promote.unresolved_link',
    source: 'review-app-promote',
    outcome: 'unlinked',
    unresolved_link_count: unresolvedLinks.length,
    ...Object.fromEntries(Object.entries(countByField).map(([k, n]) => [`unresolved_${k}`, n])),
    unresolved_links: unresolvedLinks,
  });

  for (const [field, n] of Object.entries(countByField)) {
    submitCount(rc, rc.env, rc.request, 'aeci.api.promote.unresolved_link', n, [
      'source:promote',
      `field:${field}`,
    ]);
  }
}

/** The response key each mintable taxonomy kind reports under. */
const FACET_KEY = { category: 'categories', audience: 'audiences', phase: 'phases' } as const;

/**
 * Surface every taxonomy term a promote MINTED (AECI-970). `categories` / `audiences` /
 * `phases` are closed vocabularies that promote can still grow: a value that matches no
 * stored slug and no stored name creates a row with a public browse URL, no
 * `description` and no `display_order`. That used to be visible only as an
 * `operation: 'created'` in the response and a `<kind>.created` audit row, which is how
 * `reality-capture-scan-to-bim` carried 10 products for a month before anyone saw it
 * (AECI-926).
 *
 * One `warn` log listing every `{ kind, slug, id }`, plus one
 * `aeci.api.promote.taxonomy_created` count per term tagged `kind` and `slug`. `slug`
 * is a tag on purpose: mints are rare (11 in production's whole history), so the
 * cardinality is negligible and the series alone names the term to go and look at.
 * Read off `response`, so an AECI-571 replay reports the same mints again, exactly as
 * {@link logPromoteSkips} does. Fire-and-forget over the same self-gating transport.
 * No-op when nothing was minted, which is the steady state.
 */
function logPromoteTaxonomyCreates(rc: PromoteRunCtx, response: PromoteResponse): void {
  const created = (['category', 'audience', 'phase'] as const).flatMap((kind) =>
    (response.taxonomy[FACET_KEY[kind]] ?? [])
      .filter((r) => r.operation === 'created')
      .map((r) => ({ kind, slug: r.slug, id: r.id })),
  );
  if (created.length === 0) return;

  logToPosthog(rc, rc.env, rc.request, {
    level: 'warn',
    message: 'aeci.api.promote.taxonomy_created',
    source: 'review-app-promote',
    outcome: 'minted',
    created_count: created.length,
    created,
  });

  for (const term of created) {
    submitCount(rc, rc.env, rc.request, 'aeci.api.promote.taxonomy_created', 1, [
      'source:promote',
      `kind:${term.kind}`,
      `slug:${term.slug}`,
    ]);
  }
}

/**
 * Surface an absorbed commit replay (AECI-571) in Datadog.
 *
 * This is the ONLY direct evidence that the Workflows at-least-once window actually
 * fired: before the `promote_jobs` ledger, the runbook could only ask an operator to
 * notice a duplicated product and infer it after the fact. A non-zero
 * `aeci.api.promote.replay` means the engine really did replay a committed step and the
 * primary key absorbed it — the promote is correct and needs no action, but the job id
 * is worth capturing.
 *
 * `via` distinguishes the two paths: `pre-read` (the ordinary replay, short-circuited
 * before the plan phase) and `batch-conflict` (a replay that raced the original
 * attempt's batch, caught by the in-batch primary key). Fire-and-forget over the same
 * self-gating transport as {@link logPromoteSkips}.
 */
function logPromoteReplay(
  rc: PromoteRunCtx,
  jobId: string,
  via: PromoteReplayPath,
  ledger: PromoteJobLedger,
): void {
  logToPosthog(rc, rc.env, rc.request, {
    level: 'warn',
    message: 'aeci.api.promote.replay_detected',
    source: 'review-app-promote',
    outcome: 'replayed',
    job_id: jobId,
    via,
    // The ids the replay is about to return, so the log alone answers "which rows".
    product_id: ledger.response.product?.id,
    truncated: ledger.truncated,
  });

  submitCount(rc, rc.env, rc.request, 'aeci.api.promote.replay', 1, [
    'source:promote',
    `via:${via}`,
  ]);
}

// ─── Ingest ──────────────────────────────────────────────────────────────────

/**
 * Everything the ingest and its post-commit seams need from their caller, which
 * since AECI-563 is a Workflow step rather than a Hono request. Deliberately four
 * members — the ingest never wanted a `Context`, only these:
 *
 *   - `env` — the Worker bindings (`DB`, CF/Algolia/IndexNow/Google creds, `DD_*`).
 *   - `waitUntil` — dispatch for the best-effort post-commit tasks AND for the
 *     telemetry transport, which is fire-and-forget by design (`@aeci/shared/posthog`).
 *     `PromoteRunCtx` satisfies that transport's `{ waitUntil }` shape directly, so
 *     it is passed as the ctx argument.
 *   - `request` — used ONLY to derive the Datadog `hostname` dimension. The Workflow
 *     rebuilds one from the kick-off request's URL so workflow-originated promote
 *     logs stay on the same `hostname` facet as before.
 *   - `bookmark` — the latest D1 session bookmark of this promote's write (AECI-250).
 *     Mutable by design: the post-commit re-reads (Algolia, home-stats, the trade
 *     publication floor) must resume the write's session, and the bookmark only
 *     exists once the commit step has returned, so the Workflow's implementation
 *     reads a holder it fills in from {@link PromoteIngestResult}. Returns `null`
 *     before the commit and in single-DB local/test setups.
 */
export type PromoteRunCtx = {
  env: Env;
  waitUntil(promise: Promise<unknown>): void;
  request: Request;
  bookmark(): string | null;
};

/** Injectable seams, all defaulted. Tests pass no-op/spy implementations so the real
 *  transports (D1 binding, Cloudflare purge, Algolia, IndexNow) are never hit. */
export type PromoteIngestDeps = {
  dbFor?: DbFactory;
  syncAlgolia?: PromoteAlgoliaSync;
  notifyIndexNow?: PromoteIndexNowNotify;
  refreshHomeStats?: PromoteHomeStatsRefresh;
};

/** What the committed ingest hands back: the caller's ID map plus the inputs the
 *  post-commit tail needs, none of which are derivable from the response alone. */
export type PromoteIngestResult = {
  /** The ID map the review app persists — the former `200` body, now the job result. */
  response: PromoteResponse;
  /** Trades this promote DROPPED from the product; the response echoes only what was
   *  SET, and a removal can still un-publish a trade page (AECI-542/546). */
  removedTradeSlugs: string[];
  /** False for an all-skipped promote, which wrote nothing and so needs no stats refresh.
   *  Computed from the entity statements BEFORE the AECI-571 ledger row joins the batch —
   *  the ledger is bookkeeping, not a change. */
  wrote: boolean;
  /** D1 session bookmark of the commit, for the post-commit re-reads (AECI-250). */
  bookmark: string | null;
  /** Audit rows committed inside the batch, forwarded to the logs plane post-commit (§26.5). */
  auditEntries: AuditLogEntry[];
  /** Entities the caller addressed by a `supabaseId` whose row no longer exists, and
   *  which were therefore **created** instead of updated (AECI-568). Deliberately NOT
   *  on `PromoteResponse`: `operation: 'created'` + the new id already tell the review
   *  app everything it must persist, so this is an operator/Datadog signal only and
   *  needs no change to the public contract. */
  staleSupabaseIds: PromoteStaleId[];
};

/** One entity addressed by a `supabaseId` that resolved to nothing (AECI-568). */
export type PromoteStaleId = {
  kind: 'vendor' | 'product' | 'integration';
  /** The payload `ref` the caller used, so the report is actionable on their side. */
  ref: string;
  /** The dead id — what the review app currently has stored for that record. */
  supabaseId: string;
};

/**
 * Per-attempt inputs that are neither run context nor injectable seams (AECI-571).
 *
 * Deliberately a fourth parameter rather than a member of {@link PromoteRunCtx}: one
 * `rc` is legitimately reused across two ingests (the specs' stale-then-healed pair),
 * and a job id living on it would silently turn the second call into a replay. `jobId`
 * scopes one *attempt*; `rc` scopes a *run*.
 */
export type PromoteIngestOptions = {
  /**
   * The promote job id — the Workflow instance id, and the `promote_jobs` primary key.
   * Supplied → the ingest is **exactly-once for this id, for as long as the ledger row
   * lives**. Omitted → pre-AECI-571 behaviour: no ledger row and no replay protection.
   * The Workflow always supplies it; only direct-call tests omit it.
   */
  jobId?: string;
};

/** How a replay was caught — see {@link logPromoteReplay}. */
type PromoteReplayPath = 'pre-read' | 'batch-conflict';

/**
 * What a committed promote leaves behind in `promote_jobs.result` (AECI-571).
 *
 * This is the replay's ONLY source of truth, and it has to carry more than the ID map.
 * The post-commit hooks are dispatched by the Workflow AFTER the commit step resolves,
 * so for the attempt whose result was lost they never ran at all — meaning the replay is
 * what must drive them. Everything {@link dispatchPromoteHooks} reads is therefore here.
 *
 * Deliberately NOT stored:
 *   - `bookmark` — a D1 session token, meaningless in another session. The replay
 *     returns its own, which (having just read this row through the `'first-primary'`
 *     anchor) is already at or past the original commit.
 *   - `AuditLogEntry.metadata` — `AUDIT_META` is on every entry, so it is re-attached on
 *     read rather than stored N times. Entry-specific keys (`movedFrom`, AECI-888) are
 *     therefore NOT replayed. That is a bounded loss: the `audit_log` ROW committed with
 *     the full metadata in the original batch, and a replay by definition means that
 *     commit already happened — only the re-forwarded log line is thinner. Storing them
 *     would need a `v: 2` envelope, which is not worth it for that.
 */
export type PromoteJobLedger = {
  /** Envelope version. A row written by a future shape reads as unusable rather than
   *  being silently coerced — see {@link parsePromoteJobLedger}. */
  v: 1;
  /** The ID map. The whole point: a replay returns the same ids and the same slug. */
  response: PromoteResponse;
  /** Hook input: trades this promote DROPPED (purge + trade-URL derivation). Not
   *  recoverable after the fact — it is a diff against pre-commit state. */
  removedTradeSlugs: string[];
  /** Hook input: gates the home-stats refresh. Computed BEFORE the ledger statement
   *  joins the batch — see the `wrote` note in {@link runPromoteIngest}. */
  wrote: boolean;
  /** Hook input: the §26.5 Datadog audit forwards. Stored without `metadata`. */
  auditEntries: Omit<AuditLogEntry, 'metadata'>[];
  /** Hook input: the AECI-568 stale-pointer report. */
  staleSupabaseIds: PromoteStaleId[];
  /** Products whose denormalized counts this promote invalidated. Not a member of
   *  {@link PromoteIngestResult} (the ingest consumes it internally), but it must
   *  survive: `recomputeProductCounts` runs AFTER the batch, outside the transaction, so
   *  the lost attempt may have died before reaching it. Re-running it on the replay is
   *  safe — it recomputes from source rows — and is the only chance to heal the counts
   *  before the daily drift sweep. */
  affectedProducts: string[];
  /** Parts shed to keep the row under {@link PROMOTE_LEDGER_MAX_BYTES}, in drop order.
   *  Diagnostic only; absent for every realistic bundle. */
  truncated?: ('auditEntries' | 'affectedProducts')[];
};

/**
 * Shed-point for the ledger blob. D1 caps a row at 2 MB; 512 KiB leaves >3x headroom and
 * keeps a `SELECT *` on this table sane. A typical bundle serializes to ~10 KB, so only a
 * pathological one (hundreds of integrations, each with claims) can reach this.
 */
const PROMOTE_LEDGER_MAX_BYTES = 512 * 1024;

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Build the ledger envelope, shedding the least valuable parts if the blob would exceed
 * {@link PROMOTE_LEDGER_MAX_BYTES}.
 *
 * Degrades, never fails: this row IS the duplicate guard, so an oversized payload must
 * cost observability rather than block an otherwise valid promote. `response` and
 * `wrote` are never droppable — they are the reason the row exists. Dropping
 * `auditEntries` costs a Datadog forward whose `audit_log` rows committed anyway;
 * dropping `affectedProducts` costs a count recompute the daily drift sweep backstops.
 */
function buildPromoteJobLedger(input: {
  response: PromoteResponse;
  removedTradeSlugs: string[];
  wrote: boolean;
  auditEntries: AuditLogEntry[];
  staleSupabaseIds: PromoteStaleId[];
  affectedProducts: Iterable<string>;
}): PromoteJobLedger {
  const ledger: PromoteJobLedger = {
    v: 1,
    response: input.response,
    removedTradeSlugs: input.removedTradeSlugs,
    wrote: input.wrote,
    auditEntries: input.auditEntries.map(({ metadata: _metadata, ...rest }) => rest),
    staleSupabaseIds: input.staleSupabaseIds,
    affectedProducts: [...input.affectedProducts],
  };

  for (const part of ['auditEntries', 'affectedProducts'] as const) {
    if (jsonByteLength(ledger) <= PROMOTE_LEDGER_MAX_BYTES) break;
    ledger[part] = [];
    (ledger.truncated ??= []).push(part);
  }
  return ledger;
}

/**
 * Narrow a stored `promote_jobs.result` back to a {@link PromoteJobLedger}, or `null` if
 * it can't be trusted. Defensive on purpose: the caller's only safe response to `null` is
 * to fail the job, because the alternative — re-planning — is the duplicate this whole
 * mechanism exists to prevent.
 *
 * Accepts a raw JSON string as well as a parsed object, so a row written by an ops script
 * outside Drizzle still reads back.
 */
function parsePromoteJobLedger(stored: unknown): PromoteJobLedger | null {
  // AECI-714: `promote_jobs` now holds two envelope shapes. The connector one carries
  // `kind: 'connector'`; this one carries no `kind` at all, and that ABSENCE is the
  // discriminant (pre-AECI-714 rows have none either, so absence must stay valid).
  // Without this guard a connector ledger would parse far enough to be returned as a
  // `PromoteResponse`, and `replayPromoteJob`'s "the commit HAPPENED" 500 — the one
  // honest answer when a ledger is unreadable — would never fire.
  if (stored !== null && typeof stored === 'object' && 'kind' in stored) return null;
  let value = stored;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;

  const candidate = value as Partial<PromoteJobLedger>;
  if (candidate.v !== 1) return null;
  if (!candidate.response || typeof candidate.response !== 'object') return null;

  return {
    v: 1,
    response: candidate.response,
    removedTradeSlugs: candidate.removedTradeSlugs ?? [],
    wrote: candidate.wrote ?? false,
    auditEntries: candidate.auditEntries ?? [],
    staleSupabaseIds: candidate.staleSupabaseIds ?? [],
    affectedProducts: candidate.affectedProducts ?? [],
    ...(candidate.truncated ? { truncated: candidate.truncated } : {}),
  };
}

/**
 * Rebuild the {@link PromoteIngestResult} of a promote that already committed under this
 * job id (AECI-571).
 *
 * Reached two ways — the pre-read hit (`'pre-read'`, the ordinary replay) and the
 * in-batch primary-key rollback (`'batch-conflict'`, a replay that raced the original
 * attempt's batch). Both mean the same thing: the write landed exactly once, and this
 * attempt must produce the same answer without touching a row.
 */
async function replayPromoteJob(
  rc: PromoteRunCtx,
  dbCtx: DbContext,
  jobId: string,
  stored: unknown,
  via: PromoteReplayPath,
): Promise<PromoteIngestResult> {
  const ledger = parsePromoteJobLedger(stored);
  if (!ledger) {
    // The commit HAPPENED; we simply cannot describe it. Failing is the only safe
    // answer — re-planning would mint the duplicate. This is the one `errored` promote
    // job that did write, which is why the message says so (see `docs/RUNBOOKS.md`).
    throw new ApiError(
      500,
      'INTERNAL_ERROR',
      `Promote job "${jobId}" has already committed, but its stored result is unreadable. ` +
        `The rows ARE live — recover the ID map from the KV mirror (promote:result:${jobId}) ` +
        `or from promote_jobs.result. Do NOT re-push this bundle.`,
    );
  }

  logPromoteReplay(rc, jobId, via, ledger);

  // Idempotent, and outside the original transaction — the attempt that committed may
  // have died before running it, so the replay is the first real chance to heal.
  if (ledger.affectedProducts.length) {
    await recomputeProductCounts(dbCtx.db, ledger.affectedProducts);
  }

  return {
    response: ledger.response,
    removedTradeSlugs: ledger.removedTradeSlugs,
    wrote: ledger.wrote,
    // This session's bookmark, not the original's: having just read the ledger row off
    // the `'first-primary'` anchor, it is already at or past the commit — which is all
    // the post-commit re-reads need (AECI-250).
    bookmark: dbCtx.getBookmark(),
    auditEntries: ledger.auditEntries.map((entry) => ({ ...entry, metadata: AUDIT_META })),
    staleSupabaseIds: ledger.staleSupabaseIds,
  };
}

/** A taxonomy facet model (table + the columns the find-or-create reads). The
 *  generic `Table` type doesn't expose columns, so they're passed explicitly. */
interface TaxonomyTable {
  table: Table;
  idCol: SQLiteColumn;
  slugCol: SQLiteColumn;
  nameCol: SQLiteColumn;
}

/**
 * The plan-then-batch ingest. **Not an HTTP handler** — since AECI-563 the only
 * caller is the promote Workflow (`workflows/promote-workflow.ts`), which runs it
 * inside a single non-retried `step.do`. `POST /api/promote` validates the payload
 * and starts that Workflow; it no longer commits inline, so a client that walks
 * away mid-flight can't strand a committed promote's IDs.
 *
 * **Exactly-once when `opts.jobId` is supplied (AECI-571).** Workflows guarantee a step
 * runs *at least* once, so an engine crash between `db.batch` committing and the step
 * result being persisted replays this whole function. Two things absorb that: a pre-read
 * of `promote_jobs` short-circuits the ordinary case, and the ledger INSERT rides the
 * batch as its FIRST statement so a racing replay trips the primary key and D1 rolls the
 * entire batch back. Either way the recorded {@link PromoteIngestResult} is returned —
 * same ids, same slug — so the job completes normally and the hooks (which never fired
 * for the lost attempt) fire exactly once.
 *
 * Throws — never returns a `Response`:
 *   - `ApiError(400, VALIDATION_FAILED)` for a name that can't be slugified
 *     (`generateSlug`), which the caller has no way to detect up front.
 *   - `ApiError(409, SLUG_CONFLICT)` when a racing promote took the slug (AECI-98).
 *   - `ApiError(500, INTERNAL_ERROR)` when this job id already committed but its ledger
 *     row is unreadable — the ONE error that means the promote DID write.
 *   - anything else the DB raises → the Workflow reports `INTERNAL_ERROR`.
 *
 * Post-commit work is deliberately NOT done here: it is returned as
 * {@link PromoteIngestResult} and dispatched by {@link dispatchPromoteHooks} after
 * the step resolves, so a step replay can never double-fire the hooks.
 */
export async function runPromoteIngest(
  rc: PromoteRunCtx,
  payload: PromotePayload,
  deps: PromoteIngestDeps = {},
  opts: PromoteIngestOptions = {},
): Promise<PromoteIngestResult> {
  const dbFor = deps.dbFor ?? getDb;
  // Anchor the D1 session at `'first-primary'` so the plan's pre-write reads see
  // the latest version (no spurious unique-constraint conflicts, no wrong
  // create/update branch). The Hono-only `writeDb` helper can't be used here —
  // there is no request context — and `bookmarkMiddleware` no longer applies to
  // this path, so the outbound bookmark rides `PromoteIngestResult` instead. (AECI-250)
  const dbCtx = dbFor(rc.env, { bookmark: null, constraint: 'first-primary' });
  const { db } = dbCtx;

  // One timestamp for the whole run, so every row this ingest promotes shares a
  // first-promote instant (AECI-581 / §13 D6 — see the product branches below).
  const promotedAtIso = new Date().toISOString();

  // ── REPLAY SHORT-CIRCUIT (AECI-571) ──────────────────────────────────────
  // One indexed primary-key lookup so the common replay case never re-plans. It is the
  // FIRST query on this session — exactly what the `'first-primary'` anchor above
  // covers — so a hit is strongly consistent and a miss can never be a lagging
  // replica's miss. This is an OPTIMIZATION, not the guard: two attempts racing can
  // both miss here, and the in-batch primary key below is what makes that safe.
  if (opts.jobId) {
    const prior = await db.query.promoteJobs.findFirst({
      where: eq(promoteJobs.jobId, opts.jobId),
    });
    if (prior) return replayPromoteJob(rc, dbCtx, opts.jobId, prior.result, 'pre-read');
  }

  // ── PLAN: reads + id generation. Writes are accumulated, not executed. ──
  const stmts: BatchStmt[] = [];
  const auditEntries: AuditLogEntry[] = [];
  // MERGE, don't overwrite. `AUDIT_META` is on every row, but a caller may add keys of
  // its own — `movedFrom` on a cross-table move (AECI-888) is the first. Assigning
  // `AUDIT_META` wholesale silently dropped them.
  const audit = (entry: AuditLogEntry) =>
    auditEntries.push({
      ...entry,
      // `AuditLogEntry.metadata` is `unknown` (it is a JSON column), so the spread needs
      // the narrowing. A caller here only ever passes a plain object or nothing.
      metadata: { ...AUDIT_META, ...(entry.metadata as Record<string, unknown> | undefined) },
    });
  const skipped: PromoteSkipped[] = [];
  // The inverse of `skipped`: existing vendor-owned claims/attestations this promote
  // deliberately left alive (AECI-604). Never an error — it is the operator's receipt
  // that replace-by-origin worked.
  const preserved: PromotePreserved[] = [];
  // Ids the caller supplied that resolve to nothing — each one falls back to a create
  // below, and is reported post-commit so the dead pointer is visible (AECI-568).
  const staleSupabaseIds: PromoteStaleId[] = [];
  // Optional integration links (`poweredByProduct` / `builtByVendor`) that didn't
  // resolve. The integration itself is still written — just without that column —
  // and the drop is reported on the response and in the observability plane (AECI-730).
  const unresolvedLinks: PromoteUnresolvedLink[] = [];

  // Preload existing slugs for collision-free generation (outside the batch).
  const loadSlugs = async (col: SQLiteColumn) =>
    new Set((await db.select({ slug: col }).from(col.table as Table)).map((r) => r.slug as string));
  const vendorSlugs = await loadSlugs(vendors.slug);
  const productSlugs = await loadSlugs(products.slug);

  // Read the current slugs of vendors being updated (for `firstVendorSlug` + the
  // response `slug`, which the update doesn't return).
  const updatedVendorIds = payload.vendors
    .map((v) => v.supabaseId)
    .filter((id): id is string => Boolean(id));
  //
  // `maintained_by` rides along for the AECI-981 fence: it costs nothing on a read
  // that already runs, and it is what decides whether a supplied `lastReviewedAt`
  // is written or refused into `skipped[]`.
  const vendorSlugById = new Map<string, string>();
  const vendorMaintainedById = new Map<string, string>();
  if (updatedVendorIds.length) {
    const rows = await db.query.vendors.findMany({
      columns: { id: true, slug: true, maintainedBy: true },
      where: inArray(vendors.id, updatedVendorIds),
    });
    for (const r of rows) {
      vendorSlugById.set(r.id, r.slug);
      vendorMaintainedById.set(r.id, r.maintainedBy);
    }
  }

  // ── Claimed-vendor block (AECI-520) ──────────────────────────────────────
  // Once a vendor admin claims a vendor, the review app stops being the writer
  // for that vendor's row and its products. The rule is deliberately coarse: the
  // vendor's row/products are skipped entirely. That means AECi's own curation
  // columns on those rows (`name`, `promotion_status`, `research_*`,
  // `priority_*`, `admin_notes`) also stop updating through promote — accepted
  // at launch because vendor volume is low and the concierge model has a human
  // in the loop, but it is the cost of the simple rule. An admin-side edit
  // surface for claimed rows is the follow-up if that bites.
  //
  // Both reads run BEFORE the first `stmts.push`, because the decision has to be
  // available to the taxonomy resolution below — that step mints terms and would
  // otherwise leave orphans behind for a product we never write.
  const existingProductVendorIds = payload.product?.supabaseId
    ? (
        await db.query.productVendors.findMany({
          columns: { vendorId: true },
          where: eq(productVendors.productId, payload.product.supabaseId),
        })
      ).map((r) => r.vendorId)
    : [];

  // A vendor with no `supabaseId` is being created, so it cannot be claimed — a
  // payload that only creates pays no extra read at all.
  const claimedVendorIds = await loadClaimedVendorIds(db, [
    ...updatedVendorIds,
    ...existingProductVendorIds,
  ]);

  // An EXISTING product is blocked when a claimed vendor owns it today, or when
  // this payload would hand it to one. Creation is never blocked: nothing
  // vendor-owned exists yet, and blocking it would stall catalog growth for
  // every vendor that has signed up.
  const productBlocked =
    Boolean(payload.product?.supabaseId) &&
    [...existingProductVendorIds, ...updatedVendorIds].some((id) => claimedVendorIds.has(id));

  // ── Vendors ──────────────────────────────────────────────────────────────
  const vendorIdByRef = new Map<string, string>();
  const vendorResults: PromoteEntityResult[] = [];
  let firstVendorSlug: string | undefined;
  for (const v of payload.vendors) {
    // `vendorSlugById` was loaded by `inArray` over exactly these ids, so a miss IS
    // the existence test — a supplied id absent from it names a row that is gone, and
    // updating it would write nothing (AECI-568). Fall through to the create branch.
    const existingVendorSlug = v.supabaseId ? vendorSlugById.get(v.supabaseId) : undefined;
    if (v.supabaseId && existingVendorSlug === undefined) {
      staleSupabaseIds.push({ kind: 'vendor', ref: v.ref, supabaseId: v.supabaseId });
    }
    // Claimed wins over stale: a claimed id that vanished from `vendors` is not a
    // row we may recreate under review-app authority, so this test sits after the
    // stale bookkeeping but before either write branch.
    if (v.supabaseId && existingVendorSlug !== undefined && claimedVendorIds.has(v.supabaseId)) {
      // Still register the id: blocking means "don't overwrite this vendor's own
      // row", not "pretend it doesn't exist". An unrelated integration may
      // legitimately point `built_by_vendor_id` at it, and a NEW product in this
      // payload still needs the join row (and the slug suffix below).
      vendorIdByRef.set(v.ref, v.supabaseId);
      firstVendorSlug ??= existingVendorSlug;
      skipped.push({ ref: v.ref, kind: 'vendor', reason: BLOCKED_VENDOR_REASON });
      audit({
        actorType: 'system',
        action: 'promote.blocked',
        entityType: 'vendor',
        entityId: v.supabaseId,
      });
      continue;
    }
    if (v.supabaseId && existingVendorSlug !== undefined) {
      const slug = existingVendorSlug;
      stmts.push(
        db
          .update(vendors)
          .set({
            companyName: v.companyName,
            promotionStatus: 'promoted',
            ...vendorEditableData(v),
            ...(v.logoUrl !== undefined
              ? {
                  logoUrl: sql`CASE WHEN ${vendors.logoSource} IS NULL THEN ${v.logoUrl} ELSE ${vendors.logoUrl} END`,
                }
              : {}),
            // AFTER the projection spread so it overrides the plain value
            // `vendorEditableData` put there (AECI-981).
            ...fencedLastReviewedAt(vendors, v.lastReviewedAt),
          })
          .where(eq(vendors.id, v.supabaseId)),
      );
      if (reviewSignalRefused(v.lastReviewedAt, vendorMaintainedById.get(v.supabaseId))) {
        skipped.push({ ref: v.ref, kind: 'review-signal', reason: REFUSED_REVIEW_SIGNAL_VENDOR });
      }
      vendorIdByRef.set(v.ref, v.supabaseId);
      vendorResults.push({ ref: v.ref, id: v.supabaseId, slug, operation: 'updated' });
      firstVendorSlug ??= slug;
      audit({
        actorType: 'system',
        action: 'vendor.updated',
        entityType: 'vendor',
        entityId: v.supabaseId,
      });
    } else {
      const slug = generateSlug(v.companyName, vendorSlugs);
      const id = crypto.randomUUID();
      stmts.push(
        db.insert(vendors).values({
          id,
          slug,
          companyName: v.companyName,
          promotionStatus: 'promoted',
          ...vendorEditableData(v),
        }),
      );
      vendorIdByRef.set(v.ref, id);
      vendorResults.push({ ref: v.ref, id, slug, operation: 'created' });
      firstVendorSlug ??= slug;
      audit({
        actorType: 'system',
        action: 'vendor.created',
        entityType: 'vendor',
        entityId: id,
      });
    }
  }

  // ── Taxonomy (find-or-create: slug pass, then name pass, then mint) ────────
  // Each facet returns the resolved ids + the public results, AND records a
  // `{key → {slug,name}}` map (existing + just-created) for usefulness to
  // resolve against. New-term inserts are appended to the batch.
  //
  // AECI-970 (option A): an incoming value is normalized with `slugify` and looked
  // up against every stored row twice — by its `slug` first, then by
  // `slugify(name)` — before the mint path may run. The slug pass alone is what
  // minted `reality-capture-scan-to-bim` beside the seeded `reality-capture`
  // (AECI-926): the seeded row's NAME was `Reality Capture (Scan-to-BIM)`, which
  // slugified to the incoming key, but nothing looked at names. Two separate
  // passes (as in `resolveTrades`) make the precedence structural: a row's name
  // can never shadow another row's slug. There is no alias pass because these
  // tables have no `aliases` column. The mint itself is unchanged — making these
  // facets find-only is option B, which waits on the review app surfacing
  // `skipped[]` for them — but every mint is now reported post-commit as
  // `aeci.api.promote.taxonomy_created` (`logPromoteTaxonomyCreates`).
  const resolveTaxonomy = async (
    names: string[],
    model: TaxonomyTable,
    entity: 'category' | 'audience' | 'phase',
  ): Promise<{
    ids: string[];
    results: PromoteTaxonomyResult[];
    termByKey: Map<string, { slug: string; name: string }>;
  }> => {
    const existing = (await db
      .select({ id: model.idCol, slug: model.slugCol, name: model.nameCol })
      .from(model.table)) as Array<{ id: string; slug: string; name: string }>;
    const byKey = new Map<string, { id: string; slug: string; name: string }>();
    for (const r of existing) byKey.set(r.slug, r);
    for (const r of existing) {
      const key = safeSlugify(r.name);
      if (key && !byKey.has(key)) byKey.set(key, r);
    }
    const termByKey = new Map(
      [...byKey].map(([key, r]) => [key, { slug: r.slug, name: r.name }] as const),
    );
    const slugSet = new Set(existing.map((r) => r.slug));
    const ids: string[] = [];
    const results: PromoteTaxonomyResult[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const canonical = slugify(name);
      const found = byKey.get(canonical);
      if (found) {
        if (!seen.has(found.id)) {
          ids.push(found.id);
          // The STORED slug, not `canonical`: they differ on a name-pass hit, and
          // the cache purge and IndexNow read this slug to build `category:{slug}`.
          results.push({ slug: found.slug, id: found.id, operation: 'reused' });
          seen.add(found.id);
        }
        continue;
      }
      const slug = disambiguateSlug(canonical, [...slugSet]);
      slugSet.add(slug);
      const id = crypto.randomUUID();
      stmts.push(db.insert(model.table).values({ id, slug, name } as Record<string, unknown>));
      byKey.set(canonical, { id, slug, name });
      termByKey.set(canonical, { slug, name });
      termByKey.set(slug, { slug, name });
      ids.push(id);
      results.push({ slug, id, operation: 'created' });
      seen.add(id);
      audit({
        actorType: 'system',
        action: `${entity}.created`,
        entityType: entity,
        entityId: id,
      });
    }
    return { ids, results, termByKey };
  };

  const p = payload.product;
  // `writesProduct` gates every step that plans a write for the payload's product
  // (AECI-520). It has to gate taxonomy resolution too, not just the product block
  // below: `resolveTaxonomy` MINTS missing terms, so a blocked promote would
  // otherwise create orphan terms in the nav and purge every browse page it merely
  // mentioned.
  const writesProduct = Boolean(p) && !productBlocked;
  const emptyTax = {
    ids: [] as string[],
    results: [] as PromoteTaxonomyResult[],
    termByKey: new Map<string, { slug: string; name: string }>(),
  };
  const categories =
    writesProduct && p
      ? await resolveTaxonomy(
          p.categories,
          {
            table: taxonomyCategories,
            idCol: taxonomyCategories.id,
            slugCol: taxonomyCategories.slug,
            nameCol: taxonomyCategories.name,
          },
          'category',
        )
      : emptyTax;
  const audiences =
    writesProduct && p
      ? await resolveTaxonomy(
          p.audiences,
          {
            table: taxonomyAudiences,
            idCol: taxonomyAudiences.id,
            slugCol: taxonomyAudiences.slug,
            nameCol: taxonomyAudiences.name,
          },
          'audience',
        )
      : emptyTax;
  const phases =
    writesProduct && p
      ? await resolveTaxonomy(
          p.phases,
          {
            table: taxonomyPhases,
            idCol: taxonomyPhases.id,
            slugCol: taxonomyPhases.slug,
            nameCol: taxonomyPhases.name,
          },
          'phase',
        )
      : emptyTax;

  // ── Trades (find-only resolution against the seeded closed vocabulary) ─────
  // The fourth facet (§5.5a / AECI-542) deliberately diverges from the three
  // above: `taxonomy_trades` is a GOVERNED closed vocabulary (ADR 0008 /
  // `docs/TRADES_VOCABULARY.md` §3), so a trade is resolved **find-only** —
  // never find-or-create. A curator minting `paving-contractors` alongside
  // `paving-asphalt` would split a trade page's products across two permanent
  // URLs and destroy the SEO asset the facet exists to build, so an unmatched
  // value is dropped and reported in `skipped[]` (`kind: 'trade'`), exactly like
  // an unresolvable usefulness group or claim `dataObject`. No term is ever
  // created here, so no `trade.created` audit row is possible and every result
  // is `operation: 'reused'`.
  //
  // Matching is by `slug` → `name` → `alias`, case-insensitively
  // (`TRADES_VOCABULARY.md` §4). The three passes below make that precedence
  // structural rather than incidental: an alias can never shadow another term's
  // slug or name, whatever a future vocabulary edit adds. `safeSlugify`
  // normalizes both sides and returns `null` (→ unresolvable → `skipped`) rather
  // than throwing on a reserved or empty slug.
  const resolveTrades = async (
    values: string[],
    productRef: string,
  ): Promise<{ ids: string[]; results: PromoteTaxonomyResult[] }> => {
    const rows = await db
      .select({
        id: taxonomyTrades.id,
        slug: taxonomyTrades.slug,
        name: taxonomyTrades.name,
        aliases: taxonomyTrades.aliases,
      })
      .from(taxonomyTrades);

    const byKey = new Map<string, { id: string; slug: string }>();
    const addKey = (value: string | null | undefined, row: { id: string; slug: string }) => {
      const key = value ? safeSlugify(value) : null;
      if (key && !byKey.has(key)) byKey.set(key, row);
    };
    for (const row of rows) addKey(row.slug, row);
    for (const row of rows) addKey(row.name, row);
    for (const row of rows) for (const alias of row.aliases ?? []) addKey(alias, row);

    const ids: string[] = [];
    const results: PromoteTaxonomyResult[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const key = safeSlugify(value);
      const term = key ? byKey.get(key) : undefined;
      if (!term) {
        skipped.push({
          ref: productRef,
          kind: 'trade',
          reason: `trade "${value}" did not resolve to the seeded vocabulary`,
        });
        continue;
      }
      // Two payload values may name the same term ("HVAC" and "Mechanical" both
      // resolve to `hvac-mechanical`) — collapse them so the join insert can't
      // trip the composite primary key.
      if (seen.has(term.id)) continue;
      seen.add(term.id);
      ids.push(term.id);
      results.push({ slug: term.slug, id: term.id, operation: 'reused' });
    }
    return { ids, results };
  };

  // Load the vocabulary only when the payload actually carries trades — trades are
  // sparse by design, so most promotes skip this read entirely (same gate as the
  // `anyClaims` data-object load below).
  const trades =
    writesProduct && p && p.trades.length
      ? await resolveTrades(p.trades, p.ref)
      : { ids: [] as string[], results: [] as PromoteTaxonomyResult[] };

  // Trades this promote DROPS from the product. The response echoes only what was
  // SET, so without this a re-promote that clears a trade would purge nothing —
  // and because the facet is publication-gated (`TRADE_PUBLISH_MIN_PRODUCTS`), a
  // removal can push a term back under the floor and change `/trades`, the facet
  // sidebar, and the sitemap (`CACHE_STRATEGY.md` §2). Only an UPDATE can have
  // prior join rows, so a create skips the read.
  let removedTradeSlugs: string[] = [];
  if (writesProduct && p?.supabaseId) {
    const prior = await db
      .select({ slug: taxonomyTrades.slug })
      .from(productTrades)
      .innerJoin(taxonomyTrades, eq(taxonomyTrades.id, productTrades.tradeId))
      .where(eq(productTrades.productId, p.supabaseId));
    const kept = new Set(trades.results.map((r) => r.slug));
    removedTradeSlugs = prior.map((r) => r.slug).filter((slug) => !kept.has(slug));
  }

  // ── Usefulness (find-only resolution against existing+new terms) ───────────
  const resolveUsefulnessFacet = (
    groups: PromoteUsefulnessGroup[],
    termByKey: Map<string, { slug: string; name: string }>,
    productRef: string,
  ): UsefulnessGroup[] => {
    const resolveOne = (value?: string) => {
      if (!value) return undefined;
      const key = safeSlugify(value);
      return key ? termByKey.get(key) : undefined;
    };
    const merged = new Map<string, UsefulnessGroup>();
    for (const g of groups) {
      const term = resolveOne(g.slug) ?? resolveOne(g.name);
      if (!term) {
        skipped.push({
          ref: productRef,
          kind: 'usefulness',
          reason: `usefulness group "${g.slug ?? g.name}" did not resolve to an existing term`,
        });
        continue;
      }
      const existing = merged.get(term.slug);
      if (existing) existing.points.push(...g.points);
      else merged.set(term.slug, { slug: term.slug, name: term.name, points: [...g.points] });
    }
    return [...merged.values()];
  };

  // `undefined` → column untouched (omitted from the write); `null` → cleared to
  // SQL NULL (the `Prisma.DbNull` footgun is gone under Drizzle json mode);
  // object → the resolved value.
  let usefulnessData:
    | { audiences: UsefulnessGroup[]; phases: UsefulnessGroup[] }
    | null
    | undefined;
  if (writesProduct && p) {
    if (p.usefulness === null) {
      usefulnessData = null;
    } else if (p.usefulness) {
      usefulnessData = {
        audiences: resolveUsefulnessFacet(p.usefulness.audiences, audiences.termByKey, p.ref),
        phases: resolveUsefulnessFacet(p.usefulness.phases, phases.termByKey, p.ref),
      };
    }
  }

  // ── Resolvers (used by extensions + integrations) ─────────────────────────
  let productResult: PromoteEntityResult | null = null;
  let productId: string | undefined;

  const productExists = async (id: string): Promise<boolean> =>
    (await db.query.products.findFirst({ columns: { id: true }, where: eq(products.id, id) })) !==
    undefined;

  const resolveProduct = async (ref: EntityRef): Promise<string | null> => {
    if (ref.ref) return p && ref.ref === p.ref ? (productId ?? null) : null;
    if (ref.supabaseId) return (await productExists(ref.supabaseId)) ? ref.supabaseId : null;
    return null;
  };

  const resolveVendor = async (ref: EntityRef): Promise<string | null> => {
    if (ref.ref) return vendorIdByRef.get(ref.ref) ?? null;
    if (ref.supabaseId) {
      const row = await db.query.vendors.findFirst({
        columns: { id: true },
        where: eq(vendors.id, ref.supabaseId),
      });
      return row ? ref.supabaseId : null;
    }
    return null;
  };

  /**
   * Resolve one OPTIONAL integration link (`builtByVendor` / `poweredByProduct`) into
   * a value for the upsert, keeping three payload states apart (AECI-730):
   *
   *   - **key absent** → `undefined` → dropped by `compact()`, column left untouched.
   *   - **explicit `null`** → `null` → written, column cleared. That is how a curator
   *     removes a link, so it has to keep working.
   *   - **present but unresolvable** → `undefined` + `unresolved: true`. This is the
   *     defect: it used to collapse to `null`, so the write not only failed to link,
   *     it *cleared* a correct FK an earlier promote had set — with no report anywhere.
   *
   * Contrast the two ENDPOINTS, which are mandatory: an unresolvable one refuses the
   * whole row into `skipped[]`. These two are optional, so the row still lands.
   */
  const resolveLink = async (
    ref: EntityRef | null | undefined,
    resolve: (r: EntityRef) => Promise<string | null>,
  ): Promise<{ value: string | null | undefined; unresolved: boolean }> => {
    if (ref === undefined) return { value: undefined, unresolved: false };
    if (ref === null) return { value: null, unresolved: false };
    const id = await resolve(ref);
    return id ? { value: id, unresolved: false } : { value: undefined, unresolved: true };
  };

  // ── Product (+ join rows + extensions) ────────────────────────────────────
  if (writesProduct && p) {
    // The existence read the update branch already needed doubles as the guard: a
    // `supabaseId` with no row behind it means the review app's pointer is dead, so
    // create instead of no-op-updating a row that isn't there (AECI-568).
    // `maintainedBy` rides along for the AECI-981 fence — see the vendor read above.
    const existing = p.supabaseId
      ? await db.query.products.findFirst({
          // `usefulnessSource` rides the read the update branch already needed
          // (AECI-963), so the coexistence receipt below costs no extra query.
          columns: { slug: true, maintainedBy: true, usefulnessSource: true },
          where: eq(products.id, p.supabaseId),
        })
      : undefined;
    if (p.supabaseId && !existing) {
      staleSupabaseIds.push({ kind: 'product', ref: p.ref, supabaseId: p.supabaseId });
    }
    if (p.supabaseId && existing) {
      const slug = existing.slug;
      productId = p.supabaseId;
      productResult = { ref: p.ref, id: p.supabaseId, slug, operation: 'updated' };
      // AECI-963. Tell the review app its `usefulness` was fenced, rather than
      // letting a curator keep editing a field that no longer ships. Only when
      // they actually SENT one — a push that omits the field preserved nothing.
      // Advisory by construction: the authoritative guard is the CASE WHEN in the
      // UPDATE below, evaluated a moment later. See {@link PromotePreserved}.
      if (usefulnessData !== undefined && existing.usefulnessSource !== null) {
        preserved.push({
          ref: p.ref,
          kind: 'usefulness',
          reason: `usefulness is ${existing.usefulnessSource}-authored and is no longer promote-writable`,
          count: 1,
        });
      }
      stmts.push(
        db
          .update(products)
          .set({
            ...compact({
              name: p.name,
              promotionStatus: 'promoted',
              ...productEditableData(p),
              // AECI-963 — the usefulness half of the same coexistence fence the
              // `logoUrl` block below implements (AECI-955 / ADR 0032, now ADR
              // 0033). Once a vendor has authored this section
              // (`usefulness_source` non-null) the review app no longer owns the
              // column, and a routine re-promote must not overwrite their copy.
              //
              // Tested INSIDE the UPDATE rather than from a planning read, for
              // the reason the logo fence gives: a vendor edit landing between
              // the plan and the commit still wins. `undefined` keeps its
              // ordinary meaning — column untouched — so this sits outside the
              // CASE entirely rather than writing `usefulness` to itself.
              //
              // `JSON.stringify` is load-bearing. The column is `mode: 'json'`,
              // but Drizzle's serializer runs on the ordinary `.set()` path only;
              // inside a raw `sql` template the value is bound verbatim, so an
              // object would land as `[object Object]`.
              ...(usefulnessData === undefined
                ? {}
                : {
                    usefulness: sql`CASE WHEN ${products.usefulnessSource} IS NULL THEN ${
                      usefulnessData === null ? null : JSON.stringify(usefulnessData)
                    } ELSE ${products.usefulness} END`,
                  }),
              ...(p.logoUrl !== undefined
                ? {
                    logoUrl: sql`CASE WHEN ${products.logoSource} IS NULL THEN ${p.logoUrl} ELSE ${products.logoUrl} END`,
                  }
                : {}),
              // AFTER the projection spread so it overrides the plain value
              // `productEditableData` put there (AECI-981).
              ...fencedLastReviewedAt(products, p.lastReviewedAt),
            }),
            // Set-once (AECI-581 / §13 D6). This branch re-asserts
            // `promotion_status: 'promoted'` on EVERY re-promote — `product.updated`
            // outnumbers `product.created` ~2.7:1 — so a plain `promotedAt:
            // promotedAtIso` here would mean *last* promoted and buy nothing over
            // `updated_at`. COALESCE fills only a NULL, with no extra read. Sits
            // outside `compact()` because it is an SQL expression, not a value.
            promotedAt: sql`COALESCE(${products.promotedAt}, ${promotedAtIso})`,
          })
          .where(eq(products.id, p.supabaseId)),
      );
      if (reviewSignalRefused(p.lastReviewedAt, existing.maintainedBy)) {
        skipped.push({ ref: p.ref, kind: 'review-signal', reason: REFUSED_REVIEW_SIGNAL_PRODUCT });
      }
      audit({
        actorType: 'system',
        action: 'product.updated',
        entityType: 'product',
        entityId: p.supabaseId,
      });
    } else {
      const slug = generateSlug(p.name, productSlugs, firstVendorSlug);
      const id = crypto.randomUUID();
      productId = id;
      productResult = { ref: p.ref, id, slug, operation: 'created' };
      stmts.push(
        db.insert(products).values({
          id,
          slug,
          name: p.name,
          promotionStatus: 'promoted',
          // A create IS the first promote, so there is nothing to preserve here.
          promotedAt: promotedAtIso,
          ...(usefulnessData === undefined ? {} : { usefulness: usefulnessData }),
          ...productEditableData(p),
        }),
      );
      audit({
        actorType: 'system',
        action: 'product.created',
        entityType: 'product',
        entityId: id,
      });
    }

    // Replace join rows to reflect the pushed state exactly. Deletes are no-ops
    // for a fresh product; on update they clear the prior joins.
    const pid = productId;
    stmts.push(db.delete(productVendors).where(eq(productVendors.productId, pid)));
    stmts.push(db.delete(productCategories).where(eq(productCategories.productId, pid)));
    stmts.push(db.delete(productAudiences).where(eq(productAudiences.productId, pid)));
    stmts.push(db.delete(productPhases).where(eq(productPhases.productId, pid)));
    stmts.push(db.delete(productTrades).where(eq(productTrades.productId, pid)));
    stmts.push(db.delete(productExtensions).where(eq(productExtensions.productId, pid)));

    if (payload.vendors.length) {
      stmts.push(
        db
          .insert(productVendors)
          .values(
            payload.vendors.map((v, i) => ({
              productId: pid,
              vendorId: vendorIdByRef.get(v.ref)!,
              isPrimary: v.isPrimary ?? i === 0,
            })),
          )
          .onConflictDoNothing(),
      );
    }
    if (categories.ids.length) {
      stmts.push(
        db
          .insert(productCategories)
          .values(categories.ids.map((categoryId) => ({ productId: pid, categoryId })))
          .onConflictDoNothing(),
      );
    }
    if (audiences.ids.length) {
      stmts.push(
        db
          .insert(productAudiences)
          .values(audiences.ids.map((audienceId) => ({ productId: pid, audienceId })))
          .onConflictDoNothing(),
      );
    }
    if (phases.ids.length) {
      stmts.push(
        db
          .insert(productPhases)
          .values(phases.ids.map((phaseId) => ({ productId: pid, phaseId })))
          .onConflictDoNothing(),
      );
    }
    // `taxonomy_trades` rows are seeded (never created here), so this insert has
    // no new-term statement to order behind — unlike the three facets above.
    if (trades.ids.length) {
      stmts.push(
        db
          .insert(productTrades)
          .values(trades.ids.map((tradeId) => ({ productId: pid, tradeId })))
          .onConflictDoNothing(),
      );
    }

    // Extensions: host products must already be promoted (by supabaseId).
    const hostIds: string[] = [];
    for (const host of p.extensionOf) {
      const hostId = await resolveProduct(host);
      if (!hostId || hostId === pid) {
        skipped.push({
          ref: p.ref,
          kind: 'extension',
          reason: `host product ${host.supabaseId ?? host.ref} not found or self-referential`,
        });
        continue;
      }
      hostIds.push(hostId);
    }
    if (hostIds.length) {
      stmts.push(
        db
          .insert(productExtensions)
          .values(hostIds.map((hostProductId) => ({ productId: pid, hostProductId })))
          .onConflictDoNothing(),
      );
      audit({
        actorType: 'system',
        action: 'product.extension_created',
        entityType: 'product',
        entityId: pid,
      });
    }
  } else if (p && productBlocked) {
    // `productId`/`productResult` stay unset, so the product is OMITTED from the
    // response — which is what keeps it out of the cache purge, IndexNow, Google
    // Indexing, and the Algolia sync without touching any of them.
    skipped.push({ ref: p.ref, kind: 'product', reason: BLOCKED_PRODUCT_REASON });
    audit({
      actorType: 'system',
      action: 'promote.blocked',
      entityType: 'product',
      entityId: p.supabaseId as string,
    });
  }

  // ── Data-object resolver (find-only, for claims — §6.2) ───────────────────
  // Claims resolve their `dataObject` against the seeded, frozen
  // `taxonomy_data_objects` vocabulary by slug OR alias (never find-or-create).
  // The matching rule lives in `lib/data-object-vocabulary.ts` because the vendor
  // authoring API (AECI-301) needs the identical one; what differs is only the
  // failure mode — a batch job lands a miss in `skipped[]` with `kind: 'claim'`,
  // an interactive caller gets a 400.
  //
  // Loaded once, and only when a claim is actually present, mirroring the
  // usefulness find-only path (`resolveUsefulnessFacet`).
  const anyClaims = payload.integrations.some((i) => i.claims.length > 0);
  const resolveDataObject: DataObjectResolver = anyClaims
    ? await loadDataObjectResolver(db)
    : () => undefined;

  // ── Integrations ──────────────────────────────────────────────────────────
  const integrationResults: PromoteIntegrationResult[] = [];
  // Endpoint product ids per integration result (parallel to `integrationResults`),
  // used to backfill `sourceSlug`/`targetSlug` after the loop (§6.2 → pair derivers).
  // `poweredById` rides along so the connector product's own page can be purged
  // too (Stage 1.5 Addendum B).
  //
  // §12.5's count decision is CLOSED — resolved as option B by §13.5 and shipped by
  // AECI-721: a connector counts the edges it powers. That count lives on the
  // EVIDENCED table, so the connector joins `affectedProducts` on the
  // routes-to-evidenced-pair branch above, where the row it counts is actually
  // written. It is still not added here: an edge that stays in `integrations`
  // carrying a `powered_by` is a Convention-A self-reference, whose connector is
  // already one of the two endpoints and so is already in the set.
  const integrationEndpoints: Array<{
    result: PromoteIntegrationResult;
    sourceId: string;
    targetId: string;
    poweredById: string | null;
    /**
     * The two endpoint product ids this edge moved AWAY from, or `null` when it did
     * not move (AECI-953). Resolved to slugs in the backfill pass below and echoed on
     * the result so `cacheTagsForPromote` can purge the OLD pair page — the page whose
     * content just vanished, and the one no other rule reaches.
     */
    movedFromIds: readonly [string, string] | null;
  }> = [];
  const affectedProducts = new Set<string>();
  if (productId) affectedProducts.add(productId);
  // Claim work, collected per resolved integration and planned in one pass after
  // the loop (AECI-604 — see the `planClaimIngest` call below).
  const claimIngestItems: ClaimIngestItem[] = [];
  // AECI-1011: every insert the twin guard let through, so a sentinel abort can be
  // told apart from an AECI-1005 fence abort after the batch fails.
  const twinCandidates: TwinCandidate[] = [];

  // An integration touching THIS payload's blocked product is skipped too
  // (AECI-520).
  //
  // SCOPE, precisely: this cascades off THIS payload's blocked product only. A
  // payload promoting some other product may still write an integration whose far
  // endpoint is a claimed vendor's product, and that is intentional: owning a
  // PRODUCT does not make a vendor the owner of every integration touching it.
  //
  // Integrations are vendor-owned, and AECi seeds them (ADR 0035). The owner of an
  // integration is its `built_by_vendor_id`, and ownership is enforced per ROW by
  // the AECI-1005 fence below, keyed on `claimed_at`: once the owner has claimed an
  // edge, promote writes nothing to it, whichever product the payload is about.
  // Until then the edge is still AECi's seed and promote keeps curating it. So
  // checking ownership of every endpoint here would block legitimate seeding for
  // no ownership reason, and it would still miss a third-party owner, which owns
  // neither endpoint.
  const touchesBlockedProduct = (ref: EntityRef): boolean =>
    productBlocked &&
    ((ref.ref !== undefined && ref.ref === p?.ref) ||
      (ref.supabaseId != null && ref.supabaseId === p?.supabaseId));

  for (const intg of payload.integrations) {
    // `poweredByProduct` is checked alongside the two endpoints, not left to
    // `resolveProduct`'s degrade-to-null: for a BLOCKED product that null is silent
    // data loss. `resolveProduct` returns null for a `ref` pointing at a product
    // that was never planned, and `linkData` then writes
    // `powered_by_product_id = null` — wiping an existing link on a promote whose
    // entire purpose was to leave that product alone, with nothing in `skipped[]`
    // to show for it.
    if (
      touchesBlockedProduct(intg.sourceProduct) ||
      touchesBlockedProduct(intg.targetProduct) ||
      (intg.poweredByProduct != null && touchesBlockedProduct(intg.poweredByProduct))
    ) {
      skipped.push({ ref: intg.ref, kind: 'integration', reason: BLOCKED_INTEGRATION_REASON });
      continue;
    }
    const sourceId = await resolveProduct(intg.sourceProduct);
    const targetId = await resolveProduct(intg.targetProduct);
    if (!sourceId || !targetId) {
      skipped.push({
        ref: intg.ref,
        kind: 'integration',
        reason: 'source or target product is not promoted yet',
      });
      continue;
    }
    if (sourceId === targetId) {
      skipped.push({
        ref: intg.ref,
        kind: 'integration',
        reason: 'source and target resolve to the same product (self-link not allowed)',
      });
      continue;
    }
    // The two OPTIONAL links. `compact()` is what makes the AECI-730 guard work:
    // an unresolvable link resolves to `undefined` and is dropped from the write,
    // so the column is left untouched instead of being cleared to NULL. The two
    // endpoints above are already non-null, so `compact()` never drops them.
    const builtBy = await resolveLink(intg.builtByVendor, resolveVendor);
    const poweredBy = await resolveLink(intg.poweredByProduct, resolveProduct);

    const linkData = {
      sourceProductId: sourceId,
      targetProductId: targetId,
      ...compact({ builtByVendorId: builtBy.value, poweredByProductId: poweredBy.value }),
    };

    // ── AECI-721: does this edge belong in `integrations` at all? ───────────
    // The delivered tier spans two tables (`STAGE_1_5_SPEC.md` §13.1). An edge whose
    // connector is a real third product — neither of its own endpoints — is
    // connector-delivered and belongs in `connector_evidenced_pairs`.
    //
    // WITHOUT THIS, THE MIGRATION UNDOES ITSELF. The next Procore promote would
    // re-insert all 12 Agave edges into `integrations`, and every count site would
    // then see them twice — once per table — because both tables are summed.
    //
    // The self-reference exclusion is §13.2(a) Convention A: ~60 production edges
    // name one of their own endpoints as the connector, deliberately, and the
    // destination's `connector_evidenced_pairs_distinct_connector` CHECK would refuse
    // them. An edge whose connector did not resolve (Zapier, Workato — parked by
    // AECI-700) also stays, because `connector_product_id` is NOT NULL; that is the
    // population AECI-730 exists to make observable.
    //
    // AECI-750: `resolveLink` is tri-state, so narrow to a RESOLVED id first. Both
    // `null` (explicit clear) and `undefined` (unresolvable) fall through to
    // `integrations` — `connector_product_id` is NOT NULL, and "an edge whose
    // connector did not resolve also stays" is this branch's own rule above. That
    // reproduces the pre-merge routing exactly; only the WRITE gains the guard.
    const payloadConnectorId = typeof poweredBy.value === 'string' ? poweredBy.value : null;

    let result: PromoteIntegrationResult;
    // LOCATE BEFORE ROUTING (AECI-888). An update may MOVE an endpoint, so the OLD
    // products have to be recomputed too (the AECI-86 drift fix), and the pre-read has to
    // happen pre-batch anyway. What changed is that it now reads BOTH anchor tables:
    // migration `0027` preserves ids verbatim across the move, so an id living on the
    // other side is not a dead pointer and must not take the create branch.
    const located = await locateEdge(db, intg.supabaseId);
    // ── AECI-1005: the ownership fence. A claimed row is the vendor's. ────────
    // Checked before EVERY write branch below, including both cross-table moves,
    // and before the claim ingest is queued, so nothing about this edge is planned:
    // not its columns, not its endpoints, not its table, not its claims. The
    // `promote.blocked` row is the same audit trail AECI-520 leaves for a blocked
    // vendor or product, and `catalogWrites` excludes it, so an all-fenced promote
    // still reports `wrote: false`.
    if (claimFenceRefuses(located)) {
      skipped.push({ ref: intg.ref, kind: 'integration', reason: REFUSED_CLAIMED_INTEGRATION });
      audit({
        actorType: 'system',
        action: 'promote.blocked',
        entityType: 'integration',
        entityId: located!.id,
      });
      continue;
    }
    // The commit-time half: the row was unclaimed when we read it, so abort the whole
    // batch if it is claimed by the time the batch runs. Pushed AHEAD of this edge's
    // writes, and only for a row that already exists in `integrations`, the one arm
    // a claim can reach.
    if (located?.table === 'integrations') {
      stmts.push(promoteClaimFenceSentinel(db, located.id));
    }
    // The AECI-981 fence receipt, pushed ONCE here rather than per branch. `located`
    // answers it for all four write branches at the same grain: a create cannot be
    // vendor-maintained, and both the same-table UPDATE and the cross-table move
    // refuse the supplied date on a `'vendor'` row.
    if (reviewSignalRefused(intg.lastReviewedAt, located?.row.maintainedBy)) {
      skipped.push({
        ref: intg.ref,
        kind: 'review-signal',
        reason: REFUSED_REVIEW_SIGNAL_INTEGRATION,
      });
    }
    // Kept under its old name for the AECI-730 `preserved` branch below, which needs the
    // STORED `powered_by_product_id` — not the payload's — to know whose product page
    // still needs purging. Narrowed to the `integrations` arm because that is the only
    // table with the column.
    const existing = located?.table === 'integrations' ? located.row : undefined;

    // ── Which table does this edge belong in, given BOTH inputs? ─────────────
    //
    // The payload alone cannot answer it. §3.6's absent-means-untouched rule says an
    // OMITTED `poweredByProduct` is "no opinion", and AECI-730 says an UNRESOLVABLE one
    // leaves the stored value alone — so in both cases the edge stays wherever it already
    // is, which for a migrated edge is `connector_evidenced_pairs`. Routing those to
    // `integrations` on the strength of a key nobody stated is inference from absence,
    // which is exactly what ADR 0030 refuses.
    //
    // So: a RESOLVED third-party connector routes to the evidenced tier, as before. An
    // unstated one routes by WHERE THE ROW LIVES. Only an EXPLICIT `null` moves an edge
    // back out of the evidenced tier, because only an explicit null is a statement.
    const connectorStated = poweredBy.value !== undefined;
    const storedConnectorId =
      located?.table === 'evidenced' ? located.row.connectorProductId : null;
    // An unstated key inherits the stored connector. Convention A (§13.2a) still applies
    // to the inherited value: if an endpoint has since MOVED onto the connector, the
    // destination's `connector_evidenced_pairs_distinct_connector` CHECK would reject the
    // row and fail the whole batch — an outage on a routine re-promote. That edge belongs
    // in `integrations` by the same rule that keeps ~60 production self-references there,
    // so let it fall through and carry the connector in `powered_by_product_id` instead.
    const connectorId = connectorStated ? payloadConnectorId : storedConnectorId;
    const routesToEvidencedPair =
      connectorId !== null && connectorId !== sourceId && connectorId !== targetId;

    // An unstated key that inherits its connector must not CLEAR the stored column on the
    // way past. `compact()` already drops `poweredByProductId` when it is `undefined`, so
    // the unrouted-but-inherited case leaves the column exactly as it was.

    if (routesToEvidencedPair) {
      // WHERE the preserved id already lives decides the write (see
      // `planEvidencedPairWrite`). The migration keeps the id verbatim across the
      // move, so a re-promote of a migrated edge finds it in the evidenced table, not in
      // `integrations` — routing it to a fresh-id INSERT would collide on
      // `connector_evidenced_pairs_pair_idx`. `locateEdge` above answers that for both
      // branches now (AECI-888); this branch used to run its own second read.
      const existingEvidenced = located?.table === 'evidenced' ? located.row : undefined;
      // A supplied id that resolves in neither table is dead — the create branch
      // mints a new one, and we report the stale pointer the same way the
      // `integrations` branch does (AECI-568).
      if (intg.supabaseId && !located) {
        staleSupabaseIds.push({ kind: 'integration', ref: intg.ref, supabaseId: intg.supabaseId });
      }

      const evidenced = planEvidencedPairWrite({
        db,
        intg,
        sourceId,
        targetId,
        connectorProductId: connectorId,
        builtByVendorId: builtBy.value,
        existing: located,
      });
      stmts.push(...evidenced.statements);
      // AECI-996 — the pair's A is the LOWER id, the payload's claims speak source →
      // target. When the source sorts second the frames disagree: payload claims are
      // flipped on ingest (`frameReversed`), and claims an `integrations` row carries
      // IN are flipped here, after the re-home above, so both land in the pair's frame.
      const evidencedFrameReversed = sourceId > targetId;
      const evidencedReframe =
        located?.table === 'integrations' && evidencedFrameReversed
          ? planClaimReframe(await loadReframeClaims(db, located.id))
          : null;
      if (evidencedReframe) {
        const rendered = reframeStatements(db, evidencedReframe.ops);
        stmts.push(...rendered.statements);
        for (const entry of rendered.audits) audit(entry);
      }
      // AECI-953 — did this edge's pair URL move? The row and its audit entry are
      // emitted in the post-loop slug pass (AECI-991), still in this same batch.
      const evidencedMove = endpointMoveFrom({
        from: locatedEndpointPair(located) ?? [sourceId, targetId],
        to: [sourceId, targetId],
      });
      result = { ref: intg.ref, id: evidenced.id, operation: evidenced.operation };
      audit({
        actorType: 'system',
        action:
          evidenced.operation === 'updated'
            ? 'connector_evidenced_pair.updated'
            : 'connector_evidenced_pair.created',
        entityType: 'connector_evidenced_pair',
        entityId: evidenced.id,
        // Symmetric with the de-route below (AECI-888). Same action and same entity id
        // whether the pair was updated in place or moved in from `integrations`, so
        // without this the move leaves no trace anyone can search for.
        ...(located?.table === 'integrations'
          ? { metadata: { movedFrom: 'integrations' as const } }
          : {}),
      });
      // Recompute the OLD endpoints too when this edge already existed — its
      // endpoints (or the connector it counted for) may have moved. The integrations
      // pre-read carries the old source/target; the evidenced pre-read carries the
      // old canonical pair plus the old connector.
      if (existing) {
        affectedProducts.add(existing.sourceProductId);
        affectedProducts.add(existing.targetProductId);
      }
      if (existingEvidenced) {
        affectedProducts.add(existingEvidenced.productAId);
        affectedProducts.add(existingEvidenced.productBId);
        affectedProducts.add(existingEvidenced.connectorProductId);
      }
      // Report each link this write had to leave out (AECI-730). The evidenced
      // branch `continue`s past the shared reporter below, so without this the
      // connector-delivered tier is invisible to
      // `aeci.api.promote.unresolved_link` — `field:built_by` under-counts by
      // exactly this tier, which is the defect AECI-730 exists to close, silently
      // reintroduced on the new table (AECI-750).
      //
      // `powered_by` CAN be unresolved here since AECI-888, and it could not before.
      // An unresolvable key is UNSTATED, so an edge already in this table inherits its
      // stored connector and stays routed — where the old code sent it to the
      // `integrations` branch and reported it there. Dropping it here would silently
      // move the connector-delivered tier out of `field:powered_by` too, which is the
      // same under-count `built_by` above exists to prevent.
      if (poweredBy.unresolved) {
        unresolvedLinks.push(
          unresolvedLinkEntry(intg.ref, 'powered_by', intg.poweredByProduct, result.operation),
        );
      }
      if (builtBy.unresolved) {
        unresolvedLinks.push(
          unresolvedLinkEntry(intg.ref, 'built_by', intg.builtByVendor, result.operation),
        );
      }
      integrationResults.push(result);
      // Endpoints AND the connector: §12.5 option B counts the edge for the
      // connector's own `integration_count` too, so it has to be recomputed.
      integrationEndpoints.push({
        result,
        sourceId,
        targetId,
        poweredById: connectorId,
        movedFromIds: evidencedMove,
      });
      affectedProducts.add(sourceId);
      affectedProducts.add(targetId);
      affectedProducts.add(connectorId);
      if (result.operation === 'updated' || intg.claims.length) {
        claimIngestItems.push({
          anchorId: evidenced.id,
          anchorKind: 'evidenced_pair',
          ref: intg.ref,
          claims: intg.claims,
          isNewAnchor: result.operation !== 'updated',
          frameReversed: evidencedFrameReversed,
          ...(evidencedReframe ? { existingAfterReframe: evidencedReframe.after } : {}),
        });
      }
      continue;
    }
    // ── AECI-1011 / AECI-1012: the VENDOR_OWNED_TWIN guard. ──────────────────
    // This edge is about to land in `integrations` as an unclaimed, AECi-curated row.
    // If a vendor already holds a strong match for what the row will BE after this
    // write (the same two products in either order, the same connector, the same
    // `mechanism_kind`, an owner that agrees or is unknown), the write would put a
    // second row beside the vendor's. The review app cannot see vendor-created rows,
    // and a curator re-adding the pair under a new upstream id is exactly this case.
    // So skip it, name the vendor's row, and write nothing else about this edge: no
    // row, no claims, no move, no partial update. Live OR retired: a retired row is
    // the owner's withdrawal, and a live twin would undo it in public (the AECI-1010
    // gap, ADR 0035). It never deletes anything, and an edge whose only match is
    // AECi-curated is written as before.
    //
    // Three writes here can create a new match, and all three are guarded:
    //   1. an INSERT (brand new, or the AECI-568 fallback for a dead id);
    //   2. a DE-ROUTE, the move INSERT out of `connector_evidenced_pairs`
    //      (`planIntegrationWrite`'s `evidenced` branch). On a match the evidenced
    //      row is left exactly as it is: never deleted, never updated;
    //   3. an UPDATE of an unclaimed row that changes any field in the key: its
    //      endpoints (as a pair), its connector, its `mechanism_kind` or its owner.
    //      A kind change (`api` to `native` beside a vendor's `native` row) or an owner
    //      change (to NULL, or to the vendor's own id) makes a match as surely as a
    //      re-point does. An UPDATE that changes none of the four leaves the key as it
    //      was, so it cannot create a match that did not already exist and is not
    //      asked. A direction swap of the same two products changes no key field.
    //      An UPDATE is skipped only for a NEW twin: a vendor-held row the stored row
    //      already twinned does not count, so the write goes through.
    // The evidenced branch above needs no guard: every row it writes carries a
    // third-party connector, and no vendor-held row has one (a vendor create cannot
    // set `powered_by`, and a claim is refused on a connector-powered row).
    const storedIntegration = located?.table === 'integrations' ? located.row : null;
    const finalConnectorId =
      poweredBy.value === undefined
        ? located?.table === 'evidenced'
          ? // A de-route with an unstated key carries the inherited connector below.
            located.row.connectorProductId
          : (storedIntegration?.poweredByProductId ?? null)
        : poweredBy.value;
    // Every key field as the row will hold it after this write. An absent (or
    // unresolvable) field keeps the stored value, exactly as the UPDATE does.
    const finalOwnerId =
      builtBy.value === undefined ? (storedIntegration?.builtByVendorId ?? null) : builtBy.value;
    const finalMechanismKind =
      intg.mechanismKind === undefined
        ? (storedIntegration?.mechanismKind ?? null)
        : intg.mechanismKind;
    const repointed =
      storedIntegration !== null &&
      (!samePair(
        [storedIntegration.sourceProductId, storedIntegration.targetProductId],
        [sourceId, targetId],
      ) ||
        finalConnectorId !== storedIntegration.poweredByProductId);
    const keyChanged =
      repointed ||
      (storedIntegration !== null &&
        (finalMechanismKind !== storedIntegration.mechanismKind ||
          finalOwnerId !== storedIntegration.builtByVendorId));
    if (!located || located.table === 'evidenced' || keyChanged) {
      // On an UPDATE, the guard asks only about a NEW twin (ruled on AECI-1012). A
      // vendor-held row the stored row already twinned is excluded, so an
      // already-twinned curated row keeps receiving curator updates (the owner
      // backfill is exactly that push). The row itself is excluded too: if it is
      // claimed mid-promote, the sentinel must not read it as its own twin, so the
      // abort is reported as the AECI-1005 claim race it is.
      const excludeIds: string[] = [];
      if (storedIntegration !== null && located) {
        excludeIds.push(located.id);
        const alreadyTwinned = await findStrongMatches(
          db,
          {
            productIds: [storedIntegration.sourceProductId, storedIntegration.targetProductId],
            poweredByProductId: storedIntegration.poweredByProductId,
            ownerVendorId: storedIntegration.builtByVendorId,
            mechanismKind: storedIntegration.mechanismKind,
            excludeIds: [located.id],
          },
          { vendorHeldOnly: true },
        );
        excludeIds.push(...alreadyTwinned.map((row) => row.id));
      }
      const twinCandidate: TwinCandidate = {
        productIds: [sourceId, targetId],
        poweredByProductId: finalConnectorId,
        ownerVendorId: finalOwnerId,
        mechanismKind: finalMechanismKind,
        ...(excludeIds.length ? { excludeIds } : {}),
      };
      const [twin] = await findStrongMatches(db, twinCandidate, { vendorHeldOnly: true });
      if (twin) {
        // A dead pointer is still a dead pointer when its insert is skipped: report
        // it, or the strand audit never learns the upstream id is stale (AECI-568).
        if (intg.supabaseId && !located) {
          staleSupabaseIds.push({
            kind: 'integration',
            ref: intg.ref,
            supabaseId: intg.supabaseId,
          });
        }
        skipped.push({
          ref: intg.ref,
          kind: 'integration',
          reason: VENDOR_OWNED_TWIN,
          existingId: twin.id,
        });
        audit({
          actorType: 'system',
          action: 'promote.blocked',
          entityType: 'integration',
          entityId: twin.id,
          metadata: {
            reason: VENDOR_OWNED_TWIN,
            ref: intg.ref,
            ...(intg.supabaseId ? { supabaseId: intg.supabaseId } : {}),
            // `re-point` when the pair or connector moves, `update` when only the
            // kind or the owner changes.
            ...(located
              ? {
                  write:
                    located.table === 'evidenced' ? 'de-route' : repointed ? 're-point' : 'update',
                }
              : {}),
          },
        });
        continue;
      }
      // The commit-time half: a vendor create (or claim) that lands between this
      // read and the batch aborts the whole promote, as the AECI-1005 fence does.
      twinCandidates.push(twinCandidate);
      stmts.push(vendorOwnedTwinSentinel(db, twinCandidate));
    }
    // Only a pointer dead in BOTH tables is stale (AECI-888 narrows AECI-568). An id
    // resolving in `connector_evidenced_pairs` used to land here and take the create
    // branch, which is precisely how the old row was stranded.
    if (intg.supabaseId && !located) {
      staleSupabaseIds.push({ kind: 'integration', ref: intg.ref, supabaseId: intg.supabaseId });
    }
    // A move out of the evidenced tier changes the OLD pair's endpoints and its
    // connector, and §13.5 option B counts the edge for the connector's own
    // `integration_count` — so all three have to be recomputed or the connector's hub
    // keeps counting an edge it no longer carries.
    const movedFromEvidenced = located?.table === 'evidenced' ? located.row : null;
    if (movedFromEvidenced) {
      affectedProducts.add(movedFromEvidenced.productAId);
      affectedProducts.add(movedFromEvidenced.productBId);
      affectedProducts.add(movedFromEvidenced.connectorProductId);
    }
    if (existing) {
      affectedProducts.add(existing.sourceProductId);
      affectedProducts.add(existing.targetProductId);
    }

    // A move out of the evidenced tier is an INSERT, and `compact()`'s absent-means-
    // untouched rule does not survive one: there is no prior row to leave untouched, so
    // an omitted `poweredByProduct` would land NULL. That is not "no opinion", it is a
    // silent discard of the only record that this edge was connector-delivered.
    //
    // It only arises on the Convention A path — an unstated connector that was inherited
    // from the pair and has since become an endpoint. Carry it into
    // `powered_by_product_id`, which is exactly where the ~60 production self-referential
    // rows keep theirs. An EXPLICIT `null` is untouched by this: it is a statement, it
    // survives `compact()`, and it correctly writes NULL.
    const inheritedConnectorId =
      movedFromEvidenced && !connectorStated ? movedFromEvidenced.connectorProductId : null;
    const written = planIntegrationWrite({
      db,
      intg,
      linkData: inheritedConnectorId
        ? { ...linkData, poweredByProductId: inheritedConnectorId }
        : linkData,
      existing: located,
    });
    stmts.push(...written.statements);
    // AECI-996 — the mirror of the evidenced branch. Claims coming OUT of a pair are in
    // its canonical frame (A = lower id) and must land in this row's source → target
    // frame, which differs exactly when the source sorts second.
    const integrationReframe =
      located?.table === 'evidenced' && sourceId > targetId
        ? planClaimReframe(await loadReframeClaims(db, located.id))
        : null;
    if (integrationReframe) {
      const rendered = reframeStatements(db, integrationReframe.ops);
      stmts.push(...rendered.statements);
      for (const entry of rendered.audits) audit(entry);
    }
    // AECI-953 — the case this feature exists for. `existing` (or, on a de-route, the
    // evidenced row) carries the PRE-update endpoints; `sourceId`/`targetId` are the
    // post-update ones. When they name a different pair the edge's public URL just
    // moved, and the old one needs a 301 rather than an empty page.
    const endpointMove = endpointMoveFrom({
      from: locatedEndpointPair(located) ?? [sourceId, targetId],
      to: [sourceId, targetId],
    });
    const integrationId = written.id;
    result = { ref: intg.ref, id: written.id, operation: written.operation };
    audit({
      actorType: 'system',
      action: written.operation === 'updated' ? 'integration.updated' : 'integration.created',
      entityType: 'integration',
      entityId: written.id,
      // A cross-table move is otherwise indistinguishable from an ordinary update in
      // `audit_log` — same action, same entity id. Recording it is what makes the
      // AECI-798 shape visible after the fact instead of only on the public page.
      ...(movedFromEvidenced
        ? { metadata: { movedFrom: 'connector_evidenced_pairs' as const } }
        : {}),
    });
    // Report each link the write had to leave out (AECI-730). Pushed HERE, after the
    // branch, because `outcome` is decided by whether the row was created (column is
    // NULL) or updated (column left exactly as it was — the clobber guard).
    if (poweredBy.unresolved) {
      unresolvedLinks.push(
        unresolvedLinkEntry(intg.ref, 'powered_by', intg.poweredByProduct, result.operation),
      );
    }
    if (builtBy.unresolved) {
      unresolvedLinks.push(
        unresolvedLinkEntry(intg.ref, 'built_by', intg.builtByVendor, result.operation),
      );
    }

    integrationResults.push(result);
    // `undefined` means the column was left untouched, so what still applies is the
    // value already stored — the update branch's pre-read carries it. Anything else
    // (a resolved id, or an explicit `null` clear) is what was actually written.
    //
    // On a DE-ROUTE the written value is `null`, and using it would purge nothing: the
    // old connector's `product:{slug}` hub still lists this edge and would keep serving
    // it from cache (`CACHE_STRATEGY.md` §"Bounded gap"). The connector we just moved
    // away from is the one whose page went stale, so it is the one to purge.
    const poweredById =
      movedFromEvidenced?.connectorProductId ??
      (poweredBy.value === undefined ? (existing?.poweredByProductId ?? null) : poweredBy.value);
    integrationEndpoints.push({
      result,
      sourceId,
      targetId,
      poweredById,
      movedFromIds: endpointMove,
    });

    // ── Claims (replace-by-ORIGIN — §6.2, reworked by AECI-604) ─────────────
    // Deferred to a single `planClaimIngest` call after this loop so the whole
    // payload's existing claims load in ONE read instead of one per integration.
    // Queued for every resolved integration that is an update (so an empty
    // `claims[]` still retires AECi's prior curation) or that carries claims.
    // `isNewIntegration` is keyed off the resolved `operation`, not off
    // `intg.supabaseId`: a stale id took the create branch above, so `integrationId`
    // is brand new and nothing can pre-exist on it (AECI-568).
    if (result.operation === 'updated' || intg.claims.length) {
      claimIngestItems.push({
        anchorId: integrationId,
        anchorKind: 'integration',
        ref: intg.ref,
        claims: intg.claims,
        isNewAnchor: result.operation !== 'updated',
        ...(integrationReframe ? { existingAfterReframe: integrationReframe.after } : {}),
      });
    }

    affectedProducts.add(sourceId);
    affectedProducts.add(targetId);
  }

  // ── Claim ingest (AECI-604 / STAGE_2_ATTESTATIONS_SPEC.md §3) ──────────────
  // Claims are merged BY ORIGIN, not replaced wholesale: a claim whose identity
  // triple survives keeps its id (and therefore its vendor attestations), only
  // `origin = 'aeci'` claims the payload dropped are deleted, only `source =
  // 'aeci'` attestations are replaced, and an AECi claim a vendor still attests is
  // converted to vendor origin rather than deleted. `lib/promote-claims.ts` owns
  // the rule; this call site only splices the plan in. Runs after the integration
  // loop, so every claim statement still follows its integration's INSERT/UPDATE.
  const claimPlan = await planClaimIngest(db, resolveDataObject, claimIngestItems);
  stmts.push(...claimPlan.statements);
  for (const entry of claimPlan.audits) audit(entry);
  skipped.push(...claimPlan.skipped);
  preserved.push(...claimPlan.preserved);

  // ── Backfill integration result slugs (§6.2 → pair cache tag + pair URLs) ──
  // The pair derivers need both endpoint slugs. Seed the map with the in-payload
  // product (a freshly-created product is not yet readable from D1), then read
  // the slugs of any endpoints referenced by `supabaseId` in one batched query.
  if (integrationEndpoints.length) {
    const slugByProductId = new Map<string, string>();
    if (productId && productResult) slugByProductId.set(productId, productResult.slug);
    const needSlugs = new Set<string>();
    for (const { sourceId, targetId, poweredById, movedFromIds } of integrationEndpoints) {
      if (!slugByProductId.has(sourceId)) needSlugs.add(sourceId);
      if (!slugByProductId.has(targetId)) needSlugs.add(targetId);
      if (poweredById && !slugByProductId.has(poweredById)) needSlugs.add(poweredById);
      // AECI-953 — the OLD endpoints. One of the two is usually still an endpoint and
      // already in the set; the one the edge moved away from is not, and it is the page
      // that just went stale.
      for (const id of movedFromIds ?? []) {
        if (!slugByProductId.has(id)) needSlugs.add(id);
      }
    }
    if (needSlugs.size) {
      const rows = await db.query.products.findMany({
        columns: { id: true, slug: true },
        where: inArray(products.id, [...needSlugs]),
      });
      for (const row of rows) slugByProductId.set(row.id, row.slug);
    }
    for (const { result, sourceId, targetId, poweredById, movedFromIds } of integrationEndpoints) {
      result.sourceSlug = slugByProductId.get(sourceId);
      result.targetSlug = slugByProductId.get(targetId);
      if (poweredById) result.poweredBySlug = slugByProductId.get(poweredById);
      if (movedFromIds) {
        const [a, b] = movedFromIds;
        const fromA = slugByProductId.get(a);
        const fromB = slugByProductId.get(b);
        // Both or neither — `pairCacheTag` needs two slugs, and half a pair names no
        // page. The same rule governs the durable row below: a move we cannot name in
        // URL terms is a move we cannot redirect.
        if (fromA && fromB) {
          result.movedFromSlugs = [fromA, fromB];
          const toA = result.sourceSlug;
          const toB = result.targetSlug;
          // AECI-953's durable half, planned HERE since AECI-991 because the row is
          // keyed on slugs and slugs are not resolvable inside the integration loop.
          // Still the same `db.batch` as the endpoint update that caused it (§26.1);
          // `catalogWrites` is snapshotted after this block, so these count as writes.
          const [canonA, canonB] = [fromA, fromB].sort();
          stmts.push(
            db
              .insert(integrationEndpointMoves)
              .values({
                integrationId: result.id,
                fromProductASlug: canonA,
                fromProductBSlug: canonB,
              })
              // A replayed step or a repeated move is a no-op on the composite PK
              // rather than a constraint failure.
              .onConflictDoNothing(),
          );
          // Its own action rather than metadata on the enclosing `integration.updated`:
          // that row's `metadata.movedFrom` already means "moved between anchor TABLES"
          // (AECI-888), and an endpoint move is a different event that needs to be
          // searchable on its own.
          //
          // Both ids AND slugs are recorded. Ids alone is what made the AECI-991
          // rebuild need a hand-written map: once the product row is deleted, an id in
          // `before_state` names nothing and no query recovers the slug it had. The
          // slugs make this row a sufficient record of the move on its own.
          audit({
            actorType: 'system',
            action: 'integration.endpoint_moved',
            entityType: 'integration',
            entityId: result.id,
            beforeState: { productIds: [a, b].sort(), productSlugs: [canonA, canonB] },
            afterState: {
              productIds: [sourceId, targetId].sort(),
              productSlugs: toA && toB ? [toA, toB].sort() : undefined,
            },
          });
        }
      }
    }
  }

  // Snapshot BEFORE the audit rows are appended: this is "did catalog state
  // actually change?", which is what the home-stats refresh gates on. A
  // fully-blocked promote (AECI-520) writes only `promote.blocked` audit rows, so
  // counting `stmts` after the append would schedule a refresh for a promote that
  // changed nothing. Until the claimed-vendor block existed, no audit row could
  // occur without an accompanying write, so the two points were equivalent.
  const catalogWrites = stmts.length;

  // ── Audit rows (appended last; same atomic batch as the writes above) ─────
  for (const entry of auditEntries) stmts.push(auditInsert(db, entry));

  const response: PromoteResponse = {
    vendors: vendorResults,
    product: productResult,
    integrations: integrationResults,
    taxonomy: {
      categories: categories.results,
      audiences: audiences.results,
      phases: phases.results,
      trades: trades.results,
    },
    skipped,
    preserved,
    unresolvedLinks,
  };

  // `wrote` means "this promote changed CATALOG state". Two things must stay out of
  // the count, for the same reason and from opposite ends of the batch:
  //   - the `promote_jobs` ledger row (AECI-571), which is unshifted BELOW — it is
  //     bookkeeping, not a change, so `wrote` is read before it joins the batch;
  //   - the `audit_log` rows appended just above (AECI-520), which a fully-blocked
  //     promote emits WITHOUT any accompanying write.
  // Either one counted would make an all-skipped promote claim a write and fire a
  // pointless home-stats refresh.
  const wrote = catalogWrites > 0;

  if (opts.jobId) {
    // FIRST in the batch, deliberately: a replay then trips the primary key before any
    // duplicate row is even attempted, and the failing statement is unambiguous in the
    // error message. Safe to lead with — `promote_jobs` has no foreign keys, so it sits
    // outside the vendors → taxonomy → product → joins → integrations → audits ordering
    // contract the rest of this batch depends on.
    stmts.unshift(
      db.insert(promoteJobs).values({
        jobId: opts.jobId,
        result: buildPromoteJobLedger({
          response,
          removedTradeSlugs,
          wrote,
          auditEntries,
          staleSupabaseIds,
          affectedProducts,
        }),
      }),
    );
  }

  // ── BATCH: one atomic unit (§26.1). A replayed commit trips the `promote_jobs`
  //    primary key → the WHOLE batch rolls back and the recorded result is returned
  //    (AECI-571). A racing duplicate slug trips a UNIQUE violation → 409
  //    SLUG_CONFLICT (AECI-98); any other failure rethrows → 500.
  if (stmts.length) {
    try {
      await db.batch(stmts as BatchTuple);
    } catch (err) {
      // Checked FIRST so a replay is always reported as a replay. In practice the ledger
      // insert is statement #1, so no other violation can fire on a replay — but the
      // ordering is load-bearing rather than incidental. Do not reorder.
      if (opts.jobId && isPromoteJobDuplicate(err)) {
        const prior = await db.query.promoteJobs.findFirst({
          where: eq(promoteJobs.jobId, opts.jobId),
        });
        // The primary key tripped but the row is unreadable: that is a genuine fault,
        // not a replay we can serve. Never guess — guessing means re-planning, and
        // re-planning is the duplicate this whole change exists to prevent.
        if (!prior) throw err;
        return replayPromoteJob(rc, dbCtx, opts.jobId, prior.result, 'batch-conflict');
      }
      // AECI-1005: an edge planned as unclaimed was claimed before the batch ran. The
      // whole batch rolled back, so nothing was written, including the ledger row, and
      // a re-push plans against the claimed row and skips it.
      if (isPromoteClaimFenceError(err)) {
        // AECI-1011: the twin sentinel raises the same SQLite error, so re-read to
        // say which one fired. Both mean "nothing was written; re-push".
        if (await anyVendorOwnedTwin(db, twinCandidates)) {
          throw new ApiError(
            409,
            'VENDOR_OWNED_TWIN_CREATED_DURING_PROMOTE',
            'A vendor created an integration that duplicates one in this bundle while the promote was running. Nothing was written; re-push the bundle.',
          );
        }
        throw new ApiError(
          409,
          'INTEGRATION_CLAIMED_DURING_PROMOTE',
          'An integration in this bundle was claimed by its owner while the promote was running. Nothing was written; re-push the bundle.',
        );
      }
      if (isSlugUniqueViolation(err)) {
        throw new ApiError(
          409,
          'SLUG_CONFLICT',
          'A concurrent promote generated a duplicate slug; retry the request.',
          { details: { target: slugConflictTarget(err) } },
        );
      }
      throw err;
    }
  }

  // ── Post-batch: recompute the denormalized counts for touched products
  //    (AECI-104; the brief lag is the drift sweep's backstop). Separate
  //    read+write under D1 (no interactive tx).
  if (affectedProducts.size) await recomputeProductCounts(db, affectedProducts);

  return {
    response,
    removedTradeSlugs,
    wrote,
    bookmark: dbCtx.getBookmark(),
    auditEntries,
    staleSupabaseIds,
  };
}

/**
 * The best-effort, post-commit tail of a promote: §26.5 audit forwards, edge-cache
 * purge, home-stats refresh, Algolia upsert, and the IndexNow buffer write. Every one of
 * them is fire-and-forget through `rc.waitUntil` and self-gates
 * on its own credentials, exactly as it did when this ran off the request — the
 * promote is already committed, so nothing here may throw or delay the result.
 *
 * Called by the Workflow AFTER the commit step resolves (not from inside it), so a
 * replayed step can never double-fire these. Synchronous by design: it dispatches
 * and returns, which is what lets the job reach `complete` the instant the batch
 * commits.
 */
export function dispatchPromoteHooks(
  rc: PromoteRunCtx,
  result: PromoteIngestResult,
  deps: PromoteIngestDeps = {},
): void {
  const dbFor = deps.dbFor ?? getDb;
  const syncAlgolia = deps.syncAlgolia ?? defaultAlgoliaSync;
  const notifyIndexNow = deps.notifyIndexNow ?? defaultIndexNowNotify;
  const refreshHomeStats = deps.refreshHomeStats ?? defaultHomeStatsRefresh;
  const { response, removedTradeSlugs, auditEntries, staleSupabaseIds } = result;

  // Best-effort §26.5 audit forwards AFTER the commit, as ONE request per vendor
  // carrying every entry (AECI-666). This used to loop `logToPosthog` per entry,
  // and because the §3.1 dual-run fires the Datadog twin from the same call site
  // a fat bundle opened TWO dozen-plus simultaneous connections from a single
  // invocation — on its own enough to exhaust the connection budget and start
  // losing the other hooks below. `logBatchToPosthog` no-ops per leg without
  // that leg's key, so the old combined gate is gone.
  logBatchToPosthog(rc, rc.env, rc.request, auditEntries.map(auditLogEvent));

  // AECI-105 → WC-5: enqueue the edge-cache tags this promote invalidated.
  // Best-effort, post-commit; no-ops without the queue producer.
  if (rc.env.CACHE_PURGE_QUEUE) {
    dispatchHook(
      rc,
      'cache-purge',
      purgeAfterPromote(
        rc,
        response,
        removedTradeSlugs,
        dbFor(rc.env, { bookmark: rc.bookmark() }).db,
      ),
    );
  }

  // AECI-305: refresh the `home.*` `stats_cache` keys the home page reads, then
  // purge `/` so its credibility strip + stats cards repaint with the new counts.
  // Those numbers come from the cache, not a live count, so without this the home
  // banner lags the catalog until the daily cron. Gate on an actual write (an
  // all-skipped promote changed nothing); best-effort, post-commit — the seam
  // never throws and self-gates the purge on the queue producer.
  if (result.wrote) {
    dispatchHook(rc, 'home-stats', refreshHomeStats(rc));
  }

  // AECI-139: push the promoted records to Algolia immediately (independent
  // best-effort task). No-ops without the Algolia secrets.
  if (rc.env.ALGOLIA_APP_ID && rc.env.ALGOLIA_ADMIN_KEY) {
    dispatchHook(rc, 'algolia-sync', syncAlgolia(rc, response));
  }

  // AECI-546: resolve the publication floor for any touched trade ONCE, shared
  // by both pings below. Started here (post-commit, so the count is current) but
  // deliberately not awaited — see `resolveTradeUrlOptions`. Resumes the write's
  // session via `rc.bookmark()` so the floor re-count can't read a lagging
  // replica once D1 read replication is enabled (AECI-250).
  const tradeUrls = resolveTradeUrlOptions(
    rc,
    dbFor(rc.env, { bookmark: rc.bookmark() }).db,
    response,
    removedTradeSlugs,
  );

  // AECI-236 → AECI-826: BUFFER the affected public URLs for the twenty-minute
  // IndexNow drain cron (§20.2/§20.5). This used to submit inline, which made one
  // promote one outbound request and rate-limited the channel to a standstill.
  // Best-effort, post-commit; no-ops without INDEXNOW_KEY + PUBLIC_SITE_URL.
  // Those are provisioned ONLY at launch (alongside `ALLOW_INDEXING=true`):
  // pinging IndexNow for a noindex'd site is a correctness bug, so the secret's
  // absence is the gate — and it gates the buffer too, so a pre-launch tier never
  // accumulates rows the drain would submit the moment a key appeared.
  if (rc.env.INDEXNOW_KEY && rc.env.PUBLIC_SITE_URL) {
    dispatchHook(rc, 'indexnow', notifyIndexNow(rc, response, tradeUrls));
  }

  // Surface any `skipped[]` entries (§4) in the observability plane: a completed job
  // with skips is
  // a partial promote — entities the push couldn't link — that neither the metrics
  // layer nor a `status: 'complete'` poll response can otherwise reveal.
  logPromoteSkips(rc, response.skipped);

  // Surface any stale-`supabaseId` fallbacks (AECI-568): the entity was created
  // rather than updated because the id the caller sent no longer resolves. The
  // response says `created`, but only this says *why* — that the review app was
  // holding a dead pointer.
  logPromoteStaleIds(rc, staleSupabaseIds);

  // Surface any optional integration link the write had to leave out (AECI-730).
  // Read off `response`, so an AECI-571 replay reports it too — the ledger stores the
  // response wholesale. `?? []` because a ledger row written before AECI-730 has no
  // such key, and this runs post-commit where a throw has nothing to roll back.
  logPromoteUnresolvedLinks(rc, response.unresolvedLinks ?? []);

  // Surface any category / audience / phase term this promote minted (AECI-970). A
  // mint is a new public browse URL with no copy, so it must never be silent.
  logPromoteTaxonomyCreates(rc, response);
}
