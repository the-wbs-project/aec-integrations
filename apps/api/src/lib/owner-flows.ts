/**
 * A Sync Service's owner maintains the data flows on its own pairs (AECI-2039, ruling
 * 4 on AECI-2035, `STAGE_2_ATTESTATIONS_SPEC.md` §14.10).
 *
 * A Sync Service runs both sides of its pairs. So the pair's OWNER (the vendor in
 * `built_by_vendor_id`) confirms, removes, adds and changes the flows on it once it has
 * claimed the row. The two endpoint vendors still cannot answer (AECI-705, §14). An
 * Integration platform, or a connector whose kind is blank, stays closed to everyone.
 *
 * ── THE ANSWER IS NOT AN ATTESTATION ROW ────────────────────────────────────
 * It lives in `claim_owner_answers` (see `schema.ts`). The read paths that know about it
 * append ONE synthetic entry, `source = OWNER_ANSWER_SOURCE`, to a claim's attestation
 * list before the shared engine reads it ({@link withOwnerVote}). The engine then gives
 * `owner_confirmed` for a Yes and withholds the flow for a No
 * (`packages/shared/src/agreement.ts`). A reader that does not append it computes
 * exactly what it computed before this module existed.
 *
 * ── WHEN AN ANSWER COUNTS ───────────────────────────────────────────────────
 * {@link ownerAnswerCounts} is the one rule, shared by every reader and by the write
 * gate's own echo. All four must hold:
 *
 *   1. the connector product is a Sync Service (`isSyncService`);
 *   2. the row is claimed (`claimed_at`). Promote writes nothing to a claimed row, so
 *      the owner is the only party that keeps its flows;
 *   3. the answer's vendor is the row's owner now. An answer from a previous owner
 *      never speaks for a new one;
 *   4. the answer is live (`retracted_at IS NULL`).
 *
 * A row returned to AEC Integrations, or a connector re-classified away from Sync
 * Service, stops counting its owner's answers at once. That fails safe: a confirmed
 * flow reads "Listed by AEC Integrations" again, and a flow the owner added is withheld.
 */

import {
  ApiErrorCode,
  OWNER_ANSWER_SOURCE,
  claimDirectionForContext,
  computeAgreement,
  isClaimPubliclyBacked,
  isSyncService,
  type AgreementAttestation,
  type ClaimDirection,
  type OwnedFlow,
} from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  attestations,
  auditLog,
  claimOwnerAnswers,
  claims,
  connectorEvidencedPairs,
  integrations,
  products,
} from '../db/schema';
import { ApiError, notFoundError } from '../errors';

import { isConnectorPoweredEdge } from './connector-powered';
import { claimedAndLiveRefusal, ownershipRefusal } from './integration-owner-writes';

/** What decides whether an owner answer counts on one row. */
export interface OwnerFlowContext {
  /** The connector product is a Sync Service. */
  readonly syncService: boolean;
  /** `claimed_at` is set. */
  readonly claimed: boolean;
  /** `built_by_vendor_id`, or `null`. */
  readonly ownerVendorId: string | null;
}

/** An owner answer as the read configs load it. */
export interface RawOwnerAnswer {
  readonly asserted: boolean;
  readonly vendorId: string | null;
  readonly retractedAt: string | null;
}

/** The columns every read of `claim_owner_answers` selects, live rows only. */
export const ownerAnswersRelationConfig = {
  columns: { asserted: true, vendorId: true, retractedAt: true },
  where: isNull(claimOwnerAnswers.retractedAt),
} as const;

/** The row facts {@link ownerFlowContextOf} reads. Both anchor tables carry them. */
export interface OwnerFlowRowFacts {
  readonly claimedAt?: string | null;
  readonly builtByVendorId?: string | null;
}

/** A connector product as the read configs load it: its role and stored kind. */
export interface OwnerFlowConnectorFacts {
  readonly productRole?: string | null;
  readonly connectorKind?: string | null;
}

/** The context of one row, from its own columns and its connector product. */
export function ownerFlowContextOf(
  row: OwnerFlowRowFacts,
  connector: OwnerFlowConnectorFacts | null | undefined,
): OwnerFlowContext {
  return {
    syncService: isSyncService(connector?.productRole, connector?.connectorKind),
    claimed: row.claimedAt !== null && row.claimedAt !== undefined,
    ownerVendorId: row.builtByVendorId ?? null,
  };
}

/** True when the owner maintains this row's flows: a claimed Sync Service row. */
export function ownerMaintainsFlows(ctx: OwnerFlowContext): boolean {
  return ctx.syncService && ctx.claimed && ctx.ownerVendorId !== null;
}

/** The module's one rule. See the header, "When an answer counts". */
export function ownerAnswerCounts(ctx: OwnerFlowContext, answer: RawOwnerAnswer): boolean {
  return (
    ownerMaintainsFlows(ctx) && answer.retractedAt === null && answer.vendorId === ctx.ownerVendorId
  );
}

/**
 * The synthetic attestation entry for a claim's counting owner answer, or `null`.
 * Shaped as a full pair-page attestation row (every version stamp `null`), so it can
 * sit in any attestation list the mappers read. No stamp means no version window.
 */
export function ownerVote(
  ctx: OwnerFlowContext,
  answers: readonly RawOwnerAnswer[] | undefined,
): OwnerVoteRow | null {
  const answer = answers?.find((a) => ownerAnswerCounts(ctx, a));
  if (!answer) return null;
  return {
    source: OWNER_ANSWER_SOURCE,
    asserted: answer.asserted,
    attestedByVendorId: answer.vendorId,
    retractedAt: null,
    introducedAt: null,
    deprecatedAt: null,
    introducedVersionId: null,
    deprecatedVersionId: null,
  };
}

/** The synthetic entry. Never serialised: the public mappers drop it by source. */
export interface OwnerVoteRow extends AgreementAttestation {
  readonly introducedAt: null;
  readonly deprecatedAt: null;
  readonly introducedVersionId: null;
  readonly deprecatedVersionId: null;
}

/**
 * The claim with its counting owner answer appended to `attestations`, or the claim
 * unchanged. Run it on a row's claims BEFORE anything else reads them, so visibility
 * (`isClaimPubliclyBacked`), agreement and the refuted rule all see one list.
 */
export function withOwnerVote<
  A extends AgreementAttestation,
  C extends { attestations: readonly A[]; ownerAnswers?: readonly RawOwnerAnswer[] },
>(claim: C, ctx: OwnerFlowContext): C {
  const vote = ownerVote(ctx, claim.ownerAnswers);
  if (!vote) return claim;
  // The vote is a full attestation row with null stamps. `A` is the row type of the
  // config the claim came from, a superset of what the vote leaves `null`.
  return { ...claim, attestations: [...claim.attestations, vote as unknown as A] };
}

/** {@link withOwnerVote} over a row's claims. */
export function withOwnerVotes<
  A extends AgreementAttestation,
  C extends { attestations: readonly A[]; ownerAnswers?: readonly RawOwnerAnswer[] },
>(claimsOfRow: readonly C[], ctx: OwnerFlowContext): C[] {
  return claimsOfRow.map((claim) => withOwnerVote(claim, ctx));
}

/** True for the synthetic entry. The public wire mappers drop it. */
export function isOwnerVote(row: { source: string }): boolean {
  return row.source === OWNER_ANSWER_SOURCE;
}

// ─── The write target ────────────────────────────────────────────────────────

/** A row an owner flow write may land on, either table. */
export interface OwnerFlowTarget {
  readonly anchor: 'integration' | 'evidenced_pair';
  readonly id: string;
  readonly name: string | null;
  /** Endpoint A: `source_product_id`, or the pair's `product_a_id`. Directions frame on it. */
  readonly productAId: string;
  readonly productBId: string;
  readonly connectorProductId: string;
  readonly builtByVendorId: string | null;
  readonly claimedAt: string | null;
}

/**
 * The 403 for a row whose flows nobody but AEC Integrations keeps: a connector that is
 * not a Sync Service, or an `integrations` row no connector delivers. Asked after
 * ownership and BEFORE the claim, so an owner is never told to claim a row whose flows
 * a claim would not open.
 */
function notOwnerMaintainedError(): ApiError {
  return new ApiError(
    403,
    ApiErrorCode.FORBIDDEN,
    'Only the owner of an integration delivered by a Sync Service maintains its data flows. This integration is not one.',
  );
}

/**
 * Resolve the row behind `:id`, in either table, and apply the gate in order:
 *
 *   1. unknown id, or the caller neither owns it nor has an endpoint on it → 404;
 *   2. an endpoint vendor that is not the owner → 403 `INTEGRATION_NOT_OWNER` (or 409
 *      `INTEGRATION_OWNER_UNKNOWN`). Endpoint vendors never answer these flows;
 *   3. the connector is not a Sync Service, or no connector delivers the row → 403
 *      `FORBIDDEN`;
 *   4. not claimed → 409 `INTEGRATION_NOT_CLAIMED`;
 *   5. retired → 409 `INTEGRATION_RETIRED`.
 *
 * A seat is the whole remaining gate, on any plan: confirming data flows is a Free
 * capability since AECI-2038, and the owner holds no endpoint product to license.
 *
 * `{ read: true }` (AECI-2213, the history read) stops after step 3: an unclaimed or
 * retired row may read its history. The write routes never pass it, so their refusal
 * order is unchanged.
 */
export async function resolveOwnerFlowTarget(
  db: Db,
  vendorId: string,
  id: string,
  options: { readonly read?: boolean } = {},
): Promise<OwnerFlowTarget> {
  const row = await db.query.integrations.findFirst({ where: eq(integrations.id, id) });
  if (row) {
    const ownership = await ownershipRefusal(db, vendorId, row);
    if (ownership) throw ownership;
    const connectorId = row.poweredByProductId;
    if (!isConnectorPoweredEdge(row) || connectorId === null) throw notOwnerMaintainedError();
    if (!(await connectorIsSyncService(db, connectorId))) throw notOwnerMaintainedError();
    const refusal = options.read ? null : claimedAndLiveRefusal(row);
    if (refusal) throw refusal;
    return {
      anchor: 'integration',
      id: row.id,
      name: row.name,
      productAId: row.sourceProductId,
      productBId: row.targetProductId,
      connectorProductId: connectorId,
      builtByVendorId: row.builtByVendorId,
      claimedAt: row.claimedAt,
    };
  }
  const pair = await db.query.connectorEvidencedPairs.findFirst({
    where: eq(connectorEvidencedPairs.id, id),
  });
  if (!pair) throw notFoundError('integration', { id });
  const ownership = await ownershipRefusal(db, vendorId, {
    id: pair.id,
    builtByVendorId: pair.builtByVendorId,
    sourceProductId: pair.productAId,
    targetProductId: pair.productBId,
  });
  if (ownership) throw ownership;
  if (!(await connectorIsSyncService(db, pair.connectorProductId))) {
    throw notOwnerMaintainedError();
  }
  const refusal = options.read ? null : claimedAndLiveRefusal(pair);
  if (refusal) throw refusal;
  return {
    anchor: 'evidenced_pair',
    id: pair.id,
    name: pair.name,
    productAId: pair.productAId,
    productBId: pair.productBId,
    connectorProductId: pair.connectorProductId,
    builtByVendorId: pair.builtByVendorId,
    claimedAt: pair.claimedAt,
  };
}

async function connectorIsSyncService(db: Db, productId: string): Promise<boolean> {
  const product = await db.query.products.findFirst({
    columns: { productRole: true, connectorKind: true },
    where: eq(products.id, productId),
  });
  return isSyncService(product?.productRole, product?.connectorKind);
}

/** A claim an owner flow write addresses, with its row. */
export interface OwnerFlowClaim {
  readonly id: string;
  readonly dataObjectId: string;
  readonly direction: ClaimDirection;
  readonly target: OwnerFlowTarget;
}

/**
 * Resolve `:claimId` to its claim and row, then {@link resolveOwnerFlowTarget}. Every
 * 404 reads as the claim's, so a caller cannot tell "no such claim" from "a claim on a
 * row you do not touch". A reach-anchored claim (`connector_pair_id`) is a 404: no
 * delivered row stands behind it.
 */
export async function resolveOwnerFlowClaim(
  db: Db,
  vendorId: string,
  claimId: string,
): Promise<OwnerFlowClaim> {
  const claim = await db.query.claims.findFirst({
    columns: {
      id: true,
      integrationId: true,
      connectorEvidencedPairId: true,
      dataObjectId: true,
      direction: true,
    },
    where: eq(claims.id, claimId),
  });
  const anchorId = claim?.integrationId ?? claim?.connectorEvidencedPairId ?? null;
  if (!claim || anchorId === null) throw notFoundError('claim', { id: claimId });
  try {
    const target = await resolveOwnerFlowTarget(db, vendorId, anchorId);
    return {
      id: claim.id,
      dataObjectId: claim.dataObjectId,
      direction: claim.direction as ClaimDirection,
      target,
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw notFoundError('claim', { id: claimId });
    }
    throw error;
  }
}

// ─── The owner's read of its flows ───────────────────────────────────────────

/** What {@link loadOwnedFlows} needs of one owned row. */
export interface OwnedFlowRow {
  readonly id: string;
  readonly anchor: 'integration' | 'evidenced_pair';
  readonly ctx: OwnerFlowContext;
}

/**
 * Every row's flows as the owner reads them (`OwnedIntegration.flows`), keyed by row
 * id. ONE read per anchor table, through the partial claim indexes. The ids go in as
 * one JSON array through `json_each(?)`, never an `inArray` list: D1 caps bound
 * parameters per query, and an owner's row count has no fixed bound. `direction` is
 * framed against the row's endpoint A, the frame `OwnedIntegration.product_a` uses.
 * `agreement` is what the public pair page shows, and `public` is whether it shows the
 * flow at all (`isClaimPubliclyBacked`, the pair read's rule, AECI-2213). A flow the
 * owner removed is listed, so it can be put back.
 */
export async function loadOwnedFlows(
  db: Db,
  rows: readonly OwnedFlowRow[],
): Promise<Map<string, OwnedFlow[]>> {
  const out = new Map<string, OwnedFlow[]>();
  const integrationIds = rows.filter((r) => r.anchor === 'integration').map((r) => r.id);
  const pairIds = rows.filter((r) => r.anchor === 'evidenced_pair').map((r) => r.id);
  const claimConfig = {
    columns: {
      id: true,
      integrationId: true,
      connectorEvidencedPairId: true,
      direction: true,
      origin: true,
    },
    with: {
      dataObject: { columns: { slug: true, name: true, displayOrder: true } },
      attestations: {
        columns: { source: true, asserted: true, attestedByVendorId: true, retractedAt: true },
        where: isNull(attestations.retractedAt),
      },
      ownerAnswers: ownerAnswersRelationConfig,
    },
  } as const;
  const [onIntegrations, onPairs] = await Promise.all([
    integrationIds.length
      ? db.query.claims.findMany({
          ...claimConfig,
          where: sql`${claims.integrationId} IN (SELECT value FROM json_each(${JSON.stringify(integrationIds)}))`,
        })
      : Promise.resolve([]),
    pairIds.length
      ? db.query.claims.findMany({
          ...claimConfig,
          where: sql`${claims.connectorEvidencedPairId} IN (SELECT value FROM json_each(${JSON.stringify(pairIds)}))`,
        })
      : Promise.resolve([]),
  ]);
  const ctxById = new Map(rows.map((r) => [r.id, r.ctx]));
  // The curated order, kept beside the wire value. Local: a Worker isolate serves
  // concurrent requests, so no module-level state.
  const orderKey = new Map<string, number>();
  for (const claim of [...onIntegrations, ...onPairs]) {
    const rowId = claim.integrationId ?? claim.connectorEvidencedPairId;
    if (!rowId) continue;
    const ctx = ctxById.get(rowId);
    if (!ctx) continue;
    const counted = claim.ownerAnswers.find((a) => ownerAnswerCounts(ctx, a)) ?? null;
    const voted = withOwnerVote(claim, ctx);
    const list = out.get(rowId) ?? [];
    list.push({
      id: claim.id,
      data_object_slug: claim.dataObject.slug,
      data_object_name: claim.dataObject.name,
      direction: claimDirectionForContext(claim.direction as ClaimDirection, true),
      agreement: computeAgreement(voted.attestations),
      origin: claim.origin === 'vendor' ? 'vendor' : 'aeci',
      answer: counted === null ? null : counted.asserted ? 'yes' : 'no',
      // AECI-2213: the pair read's own visibility rule, on the same list with the
      // owner's vote appended, so the portal cell and the public page cannot disagree.
      public: isClaimPubliclyBacked(voted),
    });
    out.set(rowId, list);
    orderKey.set(claim.id, claim.dataObject.displayOrder ?? Number.MAX_SAFE_INTEGER);
  }
  for (const list of out.values()) {
    list.sort(
      (a, b) =>
        (orderKey.get(a.id) ?? 0) - (orderKey.get(b.id) ?? 0) ||
        compareText(a.data_object_name, b.data_object_name) ||
        DIRECTION_RANK[a.direction] - DIRECTION_RANK[b.direction] ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }
  return out;
}

/** The pair page's order: curated `display_order`, then name, then direction, then id. */
const DIRECTION_RANK = { outbound: 0, both: 1, inbound: 2 } as const;

/** The live owner answer row on a claim, for the retract half of a write. */
export async function liveOwnerAnswerId(db: Db, claimId: string): Promise<string | null> {
  const row = await db.query.claimOwnerAnswers.findFirst({
    columns: { id: true },
    where: and(eq(claimOwnerAnswers.claimId, claimId), isNull(claimOwnerAnswers.retractedAt)),
  });
  return row?.id ?? null;
}

// ─── The history of one data type (AECI-2213) ────────────────────────────────

/** A claim as the history read loads it. */
export interface OwnerFlowHistoryClaim {
  readonly id: string;
  readonly direction: ClaimDirection;
  readonly origin: string;
  readonly createdByVendorId: string | null;
  readonly createdAt: string;
  /**
   * Promote turned this AECi seed into a vendor row (`claim.converted`,
   * `promote-claims.ts` rule 4). `origin` is `'vendor'` now, but AECi listed it, so
   * the history reads its creation as `listed`. From the audit log, the durable record.
   */
  readonly converted: boolean;
}

/**
 * Who withdrew a retracted answer, from its `claim_owner_answer.retracted` audit row.
 * `vendorId` is the writing vendor (`commit()`'s `meta.vendorId`), not the answer's.
 */
export interface OwnerFlowHistoryRetractor {
  readonly vendorId: string | null;
  readonly actorType: string;
}

/** An owner answer as the history read loads it, retracted ones included. */
export interface OwnerFlowHistoryAnswer {
  readonly id: string;
  readonly claimId: string;
  readonly vendorId: string | null;
  readonly asserted: boolean;
  readonly createdAt: string;
  readonly retractedAt: string | null;
  /** Set only on a retracted answer whose retraction audit row was found. */
  readonly retractedBy?: OwnerFlowHistoryRetractor | null;
}

/** The writing vendor an owner flow audit row names in its metadata, or `null`. */
function metadataVendorId(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const value = (metadata as { vendorId?: unknown }).vendorId;
  return typeof value === 'string' ? value : null;
}

/**
 * Every claim on the row for one data object, every direction, and every owner answer
 * on them, retracted ones included. {@link ownerAnswersRelationConfig} loads live
 * answers only, so this reads `claim_owner_answers` directly. Three indexed reads:
 * `claims_identity_key` by anchor and data object, `claim_owner_answers_claim_idx`, then
 * `audit_log_entity_idx` for the two facts the rows themselves do not keep: which
 * claims promote converted to vendor origin (`claim.converted`), and who retracted
 * each withdrawn answer (`claim_owner_answer.retracted`). The audit read is one query
 * over both entity types.
 */
export async function loadOwnerFlowHistoryRows(
  db: Db,
  anchorId: string,
  dataObjectId: string,
): Promise<{ claims: OwnerFlowHistoryClaim[]; answers: OwnerFlowHistoryAnswer[] }> {
  const rows = await db.query.claims.findMany({
    columns: { id: true, direction: true, origin: true, createdByVendorId: true, createdAt: true },
    where: and(eq(claims.anchorId, anchorId), eq(claims.dataObjectId, dataObjectId)),
  });
  if (rows.length === 0) return { claims: [], answers: [] };
  const ids = rows.map((r) => r.id);
  const answers = await db.query.claimOwnerAnswers.findMany({
    columns: {
      id: true,
      claimId: true,
      vendorId: true,
      asserted: true,
      createdAt: true,
      retractedAt: true,
    },
    where: sql`${claimOwnerAnswers.claimId} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
  });
  const retractedIds = answers.filter((a) => a.retractedAt !== null).map((a) => a.id);
  const audits = await db
    .select({
      action: auditLog.action,
      entityId: auditLog.entityId,
      actorType: auditLog.actorType,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(
      sql`(${auditLog.entityType} = 'claim' AND ${auditLog.action} = 'claim.converted' AND ${auditLog.entityId} IN (SELECT value FROM json_each(${JSON.stringify(ids)})))
        OR (${auditLog.entityType} = 'claim_owner_answer' AND ${auditLog.action} = 'claim_owner_answer.retracted' AND ${auditLog.entityId} IN (SELECT value FROM json_each(${JSON.stringify(retractedIds)})))`,
    );
  const converted = new Set<string>();
  const retractors = new Map<string, OwnerFlowHistoryRetractor>();
  for (const row of audits) {
    if (row.entityId === null) continue;
    if (row.action === 'claim.converted') converted.add(row.entityId);
    else {
      // An answer is retracted once, so there is one row. Keep the first seen.
      if (!retractors.has(row.entityId)) {
        retractors.set(row.entityId, {
          vendorId: metadataVendorId(row.metadata),
          actorType: row.actorType,
        });
      }
    }
  }
  return {
    claims: rows.map((r) => ({
      ...r,
      direction: r.direction as ClaimDirection,
      converted: converted.has(r.id),
    })),
    answers: answers.map((a) => ({ ...a, retractedBy: retractors.get(a.id) ?? null })),
  };
}
