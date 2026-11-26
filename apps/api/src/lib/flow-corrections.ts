/**
 * AECi corrects one data flow on a claimed Sync Service pair (AECI-2139,
 * `STAGE_2_ATTESTATIONS_SPEC.md` §14.10, `ADMIN_PANEL_SPEC.md` §5.12).
 *
 * The owner of a claimed Sync Service pair maintains its flows (AECI-2039). When a
 * verifiable public source shows one flow is wrong, AECi removes it, or moves it to the
 * right direction. The rest of the integration stays listed. A live correction lives in
 * `claim_aeci_corrections` and withholds its claim from every public read through
 * `withOwnerVote` (`./owner-flows`). The owner cannot undo it: every owner write on a
 * corrected claim answers `409 FLOW_CORRECTED_BY_AECI` ({@link flowCorrectedError}).
 *
 * This module holds the gate, the commit-time sentinels and the admin read shape. The
 * routes are in `routes/admin-flow-corrections.ts`.
 */

import {
  ApiErrorCode,
  isSyncService,
  type AdminFlowCorrection,
  type ClaimDirection,
  type FlowCorrectionBlock,
  type FlowCorrectionDirection,
} from '@aeci/shared';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  claimAeciCorrections,
  claims,
  connectorEvidencedPairs,
  integrations,
  products,
  taxonomyDataObjects,
} from '../db/schema';
import { ApiError, notFoundError } from '../errors';

import type { BatchStmt } from './audit';
import { isConnectorPoweredEdge } from './connector-powered';
import { ONE_ROW } from './integration-claims';
import { integrationRetiredError, integrationVetoedError } from './live-integration';
import type { OwnerFlowTarget } from './owner-flows';

/** The claim a correction addresses, with its row. */
export interface AdminFlowClaim {
  readonly id: string;
  readonly dataObject: { readonly id: string; readonly slug: string; readonly name: string };
  readonly direction: ClaimDirection;
  readonly origin: string;
  /** The row, as the owner's own writes frame it. `builtByVendorId` is the owner. */
  readonly target: OwnerFlowTarget & { readonly builtByVendorId: string };
}

/** The facts {@link flowCorrectionBlock} reads of one row. */
export interface FlowCorrectionRowFacts {
  readonly syncService: boolean;
  readonly claimedAt: string | null;
  readonly builtByVendorId: string | null;
  readonly retiredAt: string | null;
  readonly vetoedAt: string | null;
}

/**
 * Why AECi cannot correct this row's flows here, or `null`. In the gate's order: the
 * connector, then the claim, then a retire, then a veto.
 *
 *   - `not_sync_service`: nobody but AECi keeps the flows, and the review app holds them.
 *   - `not_claimed`: promote still writes the row, so the correction belongs upstream.
 *   - `retired`, `vetoed`: no public page shows the row.
 */
export function flowCorrectionBlock(row: FlowCorrectionRowFacts): FlowCorrectionBlock | null {
  if (!row.syncService) return 'not_sync_service';
  if (row.claimedAt === null || row.builtByVendorId === null) return 'not_claimed';
  if (row.retiredAt !== null) return 'retired';
  if (row.vetoedAt !== null) return 'vetoed';
  return null;
}

function blockError(block: FlowCorrectionBlock): ApiError {
  switch (block) {
    case 'not_sync_service':
      return new ApiError(
        403,
        ApiErrorCode.FLOW_CORRECTION_NOT_AVAILABLE,
        'Only a data flow on an integration a Sync Service delivers can be corrected here. Correct this one in the review app.',
      );
    case 'not_claimed':
      return new ApiError(
        409,
        ApiErrorCode.INTEGRATION_NOT_CLAIMED,
        'Nobody has claimed this integration, so the review app holds its data flows. Retract the flow there instead.',
      );
    case 'retired':
      return integrationRetiredError();
    case 'vetoed':
      return integrationVetoedError();
  }
}

/** The `409` an owner write on a corrected flow answers. Nothing was written. */
export function flowCorrectedError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.FLOW_CORRECTED_BY_AECI,
    'AEC Integrations corrected this data flow on a public source, so it cannot be changed here. Contact AEC Integrations if the correction is wrong.',
  );
}

/** The `409` a second correction of a corrected flow answers. */
export function flowAlreadyCorrectedError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.FLOW_ALREADY_CORRECTED,
    'This data flow already carries an AEC Integrations correction. Lift it before correcting the flow again.',
  );
}

async function connectorIsSyncService(db: Db, productId: string | null): Promise<boolean> {
  if (productId === null) return false;
  const product = await db.query.products.findFirst({
    columns: { productRole: true, connectorKind: true },
    where: eq(products.id, productId),
  });
  return isSyncService(product?.productRole, product?.connectorKind);
}

/**
 * The row behind one anchor id, either table, with the facts the gate reads. `null`
 * when neither table holds it.
 */
export async function loadFlowCorrectionRow(
  db: Db,
  anchor: 'integration' | 'evidenced_pair',
  id: string,
): Promise<{ target: OwnerFlowTarget; facts: FlowCorrectionRowFacts } | null> {
  if (anchor === 'integration') {
    const row = await db.query.integrations.findFirst({ where: eq(integrations.id, id) });
    if (!row) return null;
    const connectorId = isConnectorPoweredEdge(row) ? row.poweredByProductId : null;
    return {
      target: {
        anchor,
        id: row.id,
        name: row.name,
        productAId: row.sourceProductId,
        productBId: row.targetProductId,
        connectorProductId: connectorId ?? '',
        builtByVendorId: row.builtByVendorId,
        claimedAt: row.claimedAt,
      },
      facts: {
        syncService: await connectorIsSyncService(db, connectorId),
        claimedAt: row.claimedAt,
        builtByVendorId: row.builtByVendorId,
        retiredAt: row.retiredAt,
        vetoedAt: row.vetoedAt,
      },
    };
  }
  const pair = await db.query.connectorEvidencedPairs.findFirst({
    where: eq(connectorEvidencedPairs.id, id),
  });
  if (!pair) return null;
  return {
    target: {
      anchor,
      id: pair.id,
      name: pair.name,
      productAId: pair.productAId,
      productBId: pair.productBId,
      connectorProductId: pair.connectorProductId,
      builtByVendorId: pair.builtByVendorId,
      claimedAt: pair.claimedAt,
    },
    facts: {
      syncService: await connectorIsSyncService(db, pair.connectorProductId),
      claimedAt: pair.claimedAt,
      builtByVendorId: pair.builtByVendorId,
      retiredAt: pair.retiredAt,
      vetoedAt: pair.vetoedAt,
    },
  };
}

/** The live correction on a claim, or `undefined`. One probe of the live index. */
export async function liveCorrectionOf(
  db: Db,
  claimId: string,
): Promise<typeof claimAeciCorrections.$inferSelect | undefined> {
  return db.query.claimAeciCorrections.findFirst({
    where: and(eq(claimAeciCorrections.claimId, claimId), isNull(claimAeciCorrections.retractedAt)),
  });
}

/** True when any of the claims carries a live correction. One read. */
export async function anyLiveCorrection(db: Db, claimIds: readonly string[]): Promise<boolean> {
  if (claimIds.length === 0) return false;
  const row = await db
    .select({ id: claimAeciCorrections.id })
    .from(claimAeciCorrections)
    .where(
      and(
        sql`${claimAeciCorrections.claimId} IN (SELECT value FROM json_each(${JSON.stringify(claimIds)}))`,
        isNull(claimAeciCorrections.retractedAt),
      ),
    )
    .limit(1);
  return row.length > 0;
}

/**
 * Resolve `:claimId` and apply the gate in order:
 *
 *   1. unknown claim, or a reach-anchored one (no delivered row) → `404`;
 *   2. the connector is not a Sync Service, or no connector delivers the row →
 *      `403 FLOW_CORRECTION_NOT_AVAILABLE`;
 *   3. not claimed → `409 INTEGRATION_NOT_CLAIMED` (the review app holds those flows);
 *   4. retired → `409 INTEGRATION_RETIRED`;
 *   5. vetoed → `409 INTEGRATION_VETOED`;
 *   6. already corrected → `409 FLOW_ALREADY_CORRECTED`.
 *
 * {@link pairCorrectionSentinel} re-asserts 3 to 5 at commit, and the partial unique
 * index `claim_aeci_corrections_live_key` re-asserts 6.
 */
export async function resolveAdminFlowTarget(db: Db, claimId: string): Promise<AdminFlowClaim> {
  const claim = await db
    .select({
      id: claims.id,
      integrationId: claims.integrationId,
      connectorEvidencedPairId: claims.connectorEvidencedPairId,
      direction: claims.direction,
      origin: claims.origin,
      dataObjectId: taxonomyDataObjects.id,
      dataObjectSlug: taxonomyDataObjects.slug,
      dataObjectName: taxonomyDataObjects.name,
    })
    .from(claims)
    .innerJoin(taxonomyDataObjects, eq(taxonomyDataObjects.id, claims.dataObjectId))
    .where(eq(claims.id, claimId))
    .then((rows) => rows[0]);
  if (!claim) throw notFoundError('claim', { id: claimId });
  const anchor = claim.integrationId
    ? ({ anchor: 'integration', id: claim.integrationId } as const)
    : claim.connectorEvidencedPairId
      ? ({ anchor: 'evidenced_pair', id: claim.connectorEvidencedPairId } as const)
      : null;
  if (!anchor) throw notFoundError('claim', { id: claimId });
  const row = await loadFlowCorrectionRow(db, anchor.anchor, anchor.id);
  if (!row) throw notFoundError('claim', { id: claimId });
  const block = flowCorrectionBlock(row.facts);
  if (block) throw blockError(block);
  if (await liveCorrectionOf(db, claim.id)) throw flowAlreadyCorrectedError();
  return {
    id: claim.id,
    dataObject: { id: claim.dataObjectId, slug: claim.dataObjectSlug, name: claim.dataObjectName },
    direction: claim.direction as ClaimDirection,
    origin: claim.origin,
    target: { ...row.target, builtByVendorId: row.facts.builtByVendorId as string },
  };
}

/**
 * The guarded row `UPDATE` and its sentinel, for a correction or a lift: the row is
 * still owned by the same vendor, claimed, live, unvetoed and delivered by the same
 * connector. It stamps `updated_at` only, so the owner's freshness cursor moves. Never
 * `vendor_edited_at`: the "Maintained by" stamp is the owner's, not AECi's (§4.5.8).
 * A racing handback, owner reassign, retire or veto aborts the batch.
 */
export function pairCorrectionSentinel(
  db: Db,
  target: OwnerFlowTarget & { readonly builtByVendorId: string },
  now: string,
): BatchStmt[] {
  const guard =
    target.anchor === 'integration'
      ? db
          .update(integrations)
          .set({ updatedAt: now })
          .where(
            and(
              eq(integrations.id, target.id),
              eq(integrations.builtByVendorId, target.builtByVendorId),
              isNotNull(integrations.claimedAt),
              isNull(integrations.retiredAt),
              isNull(integrations.vetoedAt),
              eq(integrations.poweredByProductId, target.connectorProductId),
            ),
          )
      : db
          .update(connectorEvidencedPairs)
          .set({ updatedAt: now })
          .where(
            and(
              eq(connectorEvidencedPairs.id, target.id),
              eq(connectorEvidencedPairs.builtByVendorId, target.builtByVendorId),
              isNotNull(connectorEvidencedPairs.claimedAt),
              isNull(connectorEvidencedPairs.retiredAt),
              isNull(connectorEvidencedPairs.vetoedAt),
              eq(connectorEvidencedPairs.connectorProductId, target.connectorProductId),
            ),
          );
  return [
    guard,
    db
      .select({ guard: sql`CASE WHEN changes() = 0 THEN json('flow-correction-row-changed') END` })
      .from(ONE_ROW),
  ];
}

/**
 * A batch statement that ABORTS an OWNER write when any claim it touches carries a
 * live AECi correction at commit. The pre-check refused the write already, so this
 * catches only a correction that landed between the read and the batch.
 */
export function noLiveCorrectionSentinel(db: Db, claimIds: readonly string[]): BatchStmt {
  return db
    .select({
      guard: sql`CASE WHEN EXISTS (SELECT 1 FROM ${claimAeciCorrections} WHERE ${claimAeciCorrections.claimId} IN (SELECT value FROM json_each(${JSON.stringify(claimIds)})) AND ${claimAeciCorrections.retractedAt} IS NULL) THEN json('flow-corrected-by-aeci') END`,
    })
    .from(ONE_ROW);
}

/** True for the unique-index refusal a racing second correction trips. */
export function isLiveCorrectionConflict(error: unknown): boolean {
  return errorTextMatches(
    error,
    /claim_aeci_corrections_live_key|UNIQUE constraint failed: claim_aeci_corrections/,
  );
}

/** True for any `json()` sentinel abort. */
export function isSentinelAbort(error: unknown): boolean {
  return errorTextMatches(error, /malformed JSON|flow-correction-|flow-corrected-by-aeci/i);
}

function errorTextMatches(error: unknown, pattern: RegExp): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (pattern.test(text)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** One correction row with what the admin read names it by. */
export interface AdminFlowCorrectionRow {
  readonly correction: typeof claimAeciCorrections.$inferSelect;
  readonly anchor: 'integration' | 'evidenced_pair';
  readonly anchorId: string;
  readonly integrationName: string | null;
  readonly dataObjectSlug: string;
  readonly dataObjectName: string;
  readonly direction: string;
  readonly replacementDirection: string | null;
}

/** The admin wire shape of one correction. */
export function toAdminFlowCorrection(row: AdminFlowCorrectionRow): AdminFlowCorrection {
  const c = row.correction;
  return {
    id: c.id,
    claim_id: c.claimId,
    replacement_claim_id: c.replacementClaimId,
    anchor_id: row.anchorId,
    anchor: row.anchor,
    integration_name: row.integrationName,
    data_object_slug: row.dataObjectSlug,
    data_object_name: row.dataObjectName,
    direction: row.direction as FlowCorrectionDirection,
    replacement_direction:
      c.replacementClaimId === null ? null : (row.replacementDirection as FlowCorrectionDirection),
    source_url: c.sourceUrl,
    reason: c.reason,
    internal_note: c.internalNote,
    created_by: c.createdBy,
    created_at: c.createdAt,
    retracted_at: c.retractedAt,
    retracted_by: c.retractedBy,
    retracted_reason: c.retractedReason,
  };
}
