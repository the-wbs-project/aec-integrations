/**
 * AECi corrects one data flow on a claimed Sync Service pair (AECI-2139,
 * `STAGE_2_ATTESTATIONS_SPEC.md` §14.10, `ADMIN_PANEL_SPEC.md` §5.12,
 * `API_CONTRACTS.md` §6.15b).
 *
 *   POST /api/admin/flows/:claimId/correction         — remove or redirect one flow (201).
 *   POST /api/admin/flow-corrections/:id/lift         — lift a correction (200).
 *   GET  /api/admin/flows?integrationId=…|pairId=…    — one row's flows, for the form (200).
 *   GET  /api/admin/vendors/:id/flow-corrections      — the live corrections on its rows (200).
 *
 * Why it exists: the owner of a claimed Sync Service pair maintains its flows, and
 * promote writes nothing to a claimed row. Before this, a flow a public source showed to
 * be wrong could only come off the site by taking the whole integration off. Now AECi
 * corrects that one flow. The rest of the integration stays listed.
 *
 * The rules:
 *
 * 1. **Admin only, rate-limited after the guard**, on the two writes. The GETs are reads:
 *    no limiter, no audit row.
 * 2. **The gate** (`resolveAdminFlowTarget`): a Sync Service row, claimed, live, not
 *    vetoed, and the flow not corrected already. An owner-routed data flow report stays
 *    the owner's (§11e.4). AECi may still correct the flow here, on a public source.
 * 3. **The effect.** A removal withholds the claim from every public read. A redirect
 *    also makes the right-direction claim public: a new claim with `origin 'aeci'` when
 *    none has that identity, nothing more when a public one does, and a live `aeci`
 *    attestation on one that is not backed. When the owner answered No on the
 *    right-direction claim the redirect refuses (`409 FLOW_DIRECTION_REMOVED_BY_OWNER`):
 *    AECi removes instead. `claims.direction` is never rewritten.
 * 4. **One batch.** The guarded row `UPDATE` (`updated_at` only, never the owner's
 *    "Maintained by" stamp) and its sentinel, the replacement writes, the correction
 *    row (its partial unique index stops a racing second one), the audit rows and the
 *    owner's notice. A lift is the guarded `UPDATE … WHERE retracted_at IS NULL`, its
 *    sentinel, the audit row and the notice.
 * 5. **After commit**, purge the pair page, both endpoint pages and the connector's
 *    page (`ownerFlowPurgeTags`), and forward the audit rows. Claims do not feed Algolia.
 */

import {
  AdminCorrectFlowSchema,
  AdminFlowCorrectionResponseSchema,
  AdminFlowCorrectionsResponseSchema,
  AdminFlowsQuerySchema,
  AdminFlowsResponseSchema,
  AdminLiftFlowCorrectionSchema,
  ApiErrorCode,
  computeAgreement,
  isClaimPubliclyBacked,
  orderedPairSlugs,
  vendorVisibleReasonMetadata,
  type AdminFlow,
  type AdminFlowCorrectionResponse,
  type AdminFlowCorrectionsResponse,
  type AdminFlowsResponse,
  type ClaimDirection,
  type FlowCorrectionDirection,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { compareText } from '@aeci/shared/text-sort';
import { and, desc, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import { getDb, type Db } from '../db/client';
import {
  attestations,
  claimAeciCorrections,
  claims,
  connectorEvidencedPairs,
  integrations,
  products,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { aeciOverrideNotificationAudit } from '../lib/aeci-override-notifications';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { vendorAuditStamp } from '../lib/audit-vendor';
import { auditActorType } from '../lib/authz';
import { assertClaimProvenance, claimProvenance } from '../lib/attestation-authority';
import {
  flowAlreadyCorrectedError,
  flowCorrectionBlock,
  isLiveCorrectionConflict,
  isSentinelAbort,
  liveCorrectionOf,
  loadFlowCorrectionRow,
  pairCorrectionSentinel,
  resolveAdminFlowTarget,
  toAdminFlowCorrection,
  type AdminFlowClaim,
  type AdminFlowCorrectionRow,
} from '../lib/flow-corrections';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { ONE_ROW } from '../lib/integration-claims';
import {
  ownerAnswerCounts,
  ownerFlowContextOf,
  ownerFlowPurgeTags,
  ownerFlowTargetSlugs,
  withOwnerVote,
  type OwnerFlowContext,
  type OwnerFlowTarget,
} from '../lib/owner-flows';
import { ADMIN_ORIGIN, FIELD_OVERRIDE_AUDIT_SOURCE } from './admin-field-overrides';
import { afterVendorWrite, parseJsonBody, type VendorContext } from './vendor-shared';

/** `audit_log.entity_type` of a correction row. */
const ENTITY_TYPE = 'claim_aeci_correction';

/** The row's `audit_log.entity_type`, as every owner write names it. */
function rowEntityType(target: OwnerFlowTarget): 'integration' | 'connector_evidenced_pair' {
  return target.anchor === 'integration' ? 'integration' : 'connector_evidenced_pair';
}

function param(c: VendorContext, name: 'claimId' | 'id'): string {
  const value = c.req.param(name);
  if (!value) throw new ApiError(400, 'VALIDATION_FAILED', `Missing ${name}`, { field: name });
  return value;
}

/** The claim with this identity on the row, or `undefined`. One probe of `claims_identity_key`. */
async function claimWithIdentity(
  db: Db,
  anchorId: string,
  dataObjectId: string,
  direction: ClaimDirection,
): Promise<{ id: string; origin: string } | undefined> {
  return db.query.claims.findFirst({
    columns: { id: true, origin: true },
    where: and(
      eq(claims.anchorId, anchorId),
      eq(claims.dataObjectId, dataObjectId),
      eq(claims.direction, direction),
    ),
  });
}

/** The connector product's role and kind, for the owner-flow context. */
async function connectorFacts(db: Db, productId: string) {
  return db.query.products.findFirst({
    columns: { productRole: true, connectorKind: true },
    where: eq(products.id, productId),
  });
}

/** What a redirect writes for the right-direction flow. */
type Replacement =
  | { kind: 'new'; id: string }
  | { kind: 'public'; id: string }
  | { kind: 'back'; id: string; attestationId: string };

/**
 * How a redirect makes the right-direction flow public (rule 3). Refuses when that flow
 * already carries a correction, or when the owner removed it.
 */
async function planReplacement(
  db: Db,
  flow: AdminFlowClaim,
  direction: ClaimDirection,
  ctx: OwnerFlowContext,
): Promise<Replacement> {
  const existing = await claimWithIdentity(db, flow.target.id, flow.dataObject.id, direction);
  if (!existing) return { kind: 'new', id: crypto.randomUUID() };
  if (await liveCorrectionOf(db, existing.id)) throw flowAlreadyCorrectedError();
  const loaded = await db.query.claims.findFirst({
    columns: { id: true, origin: true },
    where: eq(claims.id, existing.id),
    with: {
      attestations: {
        columns: { source: true, asserted: true, attestedByVendorId: true, retractedAt: true },
        where: isNull(attestations.retractedAt),
      },
      ownerAnswers: {
        columns: { asserted: true, vendorId: true, retractedAt: true },
        where: (t, { isNull: none }) => none(t.retractedAt),
      },
    },
  });
  if (!loaded) return { kind: 'new', id: crypto.randomUUID() };
  const answer = loaded.ownerAnswers.find((a) => ownerAnswerCounts(ctx, a));
  if (answer && !answer.asserted) {
    throw new ApiError(
      409,
      ApiErrorCode.FLOW_DIRECTION_REMOVED_BY_OWNER,
      'The company that offers this integration removed the flow in that direction. Remove this flow instead.',
    );
  }
  if (isClaimPubliclyBacked(withOwnerVote(loaded, ctx))) return { kind: 'public', id: loaded.id };
  // Nobody stands behind it: AECi lists it now, as on a seeded flow.
  return { kind: 'back', id: loaded.id, attestationId: crypto.randomUUID() };
}

/**
 * A batch statement that aborts a redirect when the owner removed the right-direction
 * flow after the pre-check.
 */
function replacementNotRemovedSentinel(db: Db, claimId: string, ownerVendorId: string): BatchStmt {
  return db
    .select({
      guard: sql`CASE WHEN EXISTS (SELECT 1 FROM claim_owner_answers WHERE claim_id = ${claimId} AND vendor_id = ${ownerVendorId} AND retracted_at IS NULL AND asserted = 0) THEN json('flow-correction-replacement-removed') END`,
    })
    .from(ONE_ROW);
}

// ─── POST /api/admin/flows/:claimId/correction ───────────────────────────────

export function createCorrectFlowHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const claimId = param(c, 'claimId');
    const body = await parseJsonBody(c, AdminCorrectFlowSchema);
    const { db } = writeDb(c, dbFor);

    const flow = await resolveAdminFlowTarget(db, claimId);
    const owner = flow.target.builtByVendorId;
    const direction = body.action === 'redirect' ? (body.direction as ClaimDirection) : null;
    if (direction !== null && direction === flow.direction) {
      throw new ApiError(
        422,
        ApiErrorCode.FLOW_NO_CHANGE,
        'The flow already runs in that direction. Choose another direction, or remove it.',
        { field: 'direction' },
      );
    }
    const connector = await connectorFacts(db, flow.target.connectorProductId);
    const ctx = ownerFlowContextOf(flow.target, connector);
    const replacement = direction ? await planReplacement(db, flow, direction, ctx) : null;

    const [stamp, slugs] = await Promise.all([
      vendorAuditStamp(db, owner),
      ownerFlowTargetSlugs(db, flow.target),
    ]);
    const pairSlugs = slugs.a && slugs.b ? orderedPairSlugs(slugs.a, slugs.b) : null;
    const now = new Date().toISOString();
    const correctionId = crypto.randomUUID();
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    // `integrationId` names the row, so the owner's ownership record is re-sent
    // (`mirrorTargets`), as on every owner flow write.
    const meta = {
      source: FIELD_OVERRIDE_AUDIT_SOURCE,
      claimId: flow.id,
      integrationId: flow.target.id,
      anchorId: flow.target.id,
      anchor: flow.target.anchor,
      correctionId,
    };

    const stmts: BatchStmt[] = [...pairCorrectionSentinel(db, flow.target, now)];
    const audits: AuditLogEntry[] = [];

    if (replacement?.kind === 'new') {
      const provenance = claimProvenance(null);
      const row = {
        id: replacement.id,
        integrationId: flow.target.anchor === 'integration' ? flow.target.id : null,
        connectorEvidencedPairId: flow.target.anchor === 'evidenced_pair' ? flow.target.id : null,
        dataObjectId: flow.dataObject.id,
        direction: direction as ClaimDirection,
        origin: provenance.origin,
        createdByVendorId: provenance.createdByVendorId,
        createdAt: now,
        updatedAt: now,
      };
      assertClaimProvenance(row);
      stmts.push(db.insert(claims).values(row));
      audits.push({
        ...actor,
        action: 'claim.created',
        entityType: 'claim',
        entityId: row.id,
        ...stamp,
        afterState: {
          anchor_id: flow.target.id,
          data_object_slug: flow.dataObject.slug,
          direction: row.direction,
          origin: row.origin,
        },
        metadata: { ...meta, claimId: row.id, reason: 'aeci-flow-correction' },
      });
    }
    if (replacement && replacement.kind !== 'new') {
      stmts.push(replacementNotRemovedSentinel(db, replacement.id, owner));
    }
    if (replacement?.kind === 'back') {
      stmts.push(
        db.insert(attestations).values({
          id: replacement.attestationId,
          claimId: replacement.id,
          source: 'aeci',
          asserted: true,
          attestedByVendorId: null,
          createdAt: now,
          updatedAt: now,
        }),
      );
      audits.push({
        ...actor,
        action: 'attestation.created',
        entityType: 'attestation',
        entityId: replacement.attestationId,
        ...stamp,
        afterState: { claim_id: replacement.id, source: 'aeci', asserted: true },
        metadata: { ...meta, claimId: replacement.id, reason: 'aeci-flow-correction' },
      });
    }

    // The correction row: a racing second correction trips the live index here and the
    // whole batch, replacement included, rolls back.
    stmts.push(
      db.insert(claimAeciCorrections).values({
        id: correctionId,
        claimId: flow.id,
        replacementClaimId: replacement?.id ?? null,
        reason: body.reason,
        internalNote: body.internalNote ?? null,
        sourceUrl: body.sourceUrl,
        createdBy: session.userId,
        createdAt: now,
        updatedAt: now,
      }),
    );
    audits.unshift({
      ...actor,
      action: 'claim_aeci_correction.created',
      entityType: ENTITY_TYPE,
      entityId: correctionId,
      ...stamp,
      afterState: {
        claim_id: flow.id,
        action: body.action,
        direction: flow.direction,
        replacement_claim_id: replacement?.id ?? null,
        replacement_direction: direction,
      },
      metadata: {
        ...meta,
        action: body.action,
        dataObjectSlug: flow.dataObject.slug,
        entityType: rowEntityType(flow.target),
        sourceUrl: body.sourceUrl,
        ...vendorVisibleReasonMetadata(body),
      },
    });
    audits.push(
      aeciOverrideNotificationAudit('portal-flow-corrected-by-aeci', actor, {
        event: 'flow_corrected',
        vendorId: owner,
        reason: body.reason,
        correctionId,
        entityType: rowEntityType(flow.target),
        entityId: flow.target.id,
        integrationName: flow.target.name,
        pairSlugs,
        dataObjectName: flow.dataObject.name,
        sourceUrl: body.sourceUrl,
        redirected: replacement !== null,
      }),
    );
    stmts.push(...audits.map((entry) => auditInsert(db, entry)));

    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (isLiveCorrectionConflict(error)) throw flowAlreadyCorrectedError();
      if (isSentinelAbort(error)) {
        // Ask the gate again, so a race answers what the pre-check would have.
        const again = await resolveAdminFlowTarget(db, claimId);
        if (replacement && direction) await planReplacement(db, again, direction, ctx);
      }
      if (isSentinelAbort(error) || /UNIQUE constraint failed: claims/.test(String(error))) {
        throw new ApiError(
          409,
          ApiErrorCode.INTEGRATION_CHANGED_WHILE_SAVING,
          'This integration changed while it was being saved. Reload and try again.',
        );
      }
      throw error;
    }

    afterVendorWrite(c, ownerFlowPurgeTags(slugs), audits, undefined, db, ADMIN_ORIGIN);

    const response: AdminFlowCorrectionResponse = {
      correction: await loadAdminCorrection(db, correctionId),
    };
    validateResponseInDev(c.env, () => AdminFlowCorrectionResponseSchema.parse(response));
    return json(response, { status: 201 });
  };
}

// ─── POST /api/admin/flow-corrections/:id/lift ───────────────────────────────

export function createLiftFlowCorrectionHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const id = param(c, 'id');
    const body = await parseJsonBody(c, AdminLiftFlowCorrectionSchema);
    const { db } = writeDb(c, dbFor);

    const correction = await db.query.claimAeciCorrections.findFirst({
      where: eq(claimAeciCorrections.id, id),
    });
    if (!correction) throw notFoundError('flow_correction', { id });
    if (correction.retractedAt) throw liftedError();
    const claim = await db.query.claims.findFirst({
      columns: { integrationId: true, connectorEvidencedPairId: true },
      where: eq(claims.id, correction.claimId),
      with: { dataObject: { columns: { name: true } } },
    });
    const located = claim?.integrationId
      ? await loadFlowCorrectionRow(db, 'integration', claim.integrationId)
      : claim?.connectorEvidencedPairId
        ? await loadFlowCorrectionRow(db, 'evidenced_pair', claim.connectorEvidencedPairId)
        : null;
    if (!claim || !located) throw notFoundError('flow_correction', { id });
    const target = located.target;
    // The owner NOW is told: it maintains the flow again. A row nobody owns tells nobody.
    const owner = located.facts.claimedAt !== null ? located.facts.builtByVendorId : null;

    const [stamp, slugs] = await Promise.all([
      vendorAuditStamp(db, owner),
      ownerFlowTargetSlugs(db, target),
    ]);
    const pairSlugs = slugs.a && slugs.b ? orderedPairSlugs(slugs.a, slugs.b) : null;
    const now = new Date().toISOString();
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const audits: AuditLogEntry[] = [
      {
        ...actor,
        action: 'claim_aeci_correction.retracted',
        entityType: ENTITY_TYPE,
        entityId: correction.id,
        ...stamp,
        beforeState: { retracted_at: null },
        afterState: { retracted_at: now },
        metadata: {
          source: FIELD_OVERRIDE_AUDIT_SOURCE,
          correctionId: correction.id,
          claimId: correction.claimId,
          integrationId: target.id,
          anchorId: target.id,
          anchor: target.anchor,
          entityType: rowEntityType(target),
          ...vendorVisibleReasonMetadata(body),
        },
      },
    ];
    if (owner) {
      audits.push(
        aeciOverrideNotificationAudit('portal-flow-correction-lifted-by-aeci', actor, {
          event: 'flow_correction_lifted',
          vendorId: owner,
          reason: body.reason,
          correctionId: correction.id,
          entityType: rowEntityType(target),
          entityId: target.id,
          integrationName: target.name,
          pairSlugs,
          dataObjectName: claim.dataObject.name,
          sourceUrl: correction.sourceUrl,
        }),
      );
    }

    try {
      await db.batch([
        db
          .update(claimAeciCorrections)
          .set({
            retractedAt: now,
            retractedBy: session.userId,
            retractedReason: body.reason,
            updatedAt: now,
          })
          .where(and(eq(claimAeciCorrections.id, id), isNull(claimAeciCorrections.retractedAt))),
        // A double-click or a second admin lifting at once: the loser writes nothing.
        db
          .select({ guard: sql`CASE WHEN changes() = 0 THEN json('flow-correction-lifted') END` })
          .from(ONE_ROW),
        ...audits.map((entry) => auditInsert(db, entry)),
      ] as BatchTuple);
    } catch (error) {
      if (isSentinelAbort(error)) throw liftedError();
      throw error;
    }

    // The flow follows its owner's answer again, so the public pages change.
    afterVendorWrite(c, ownerFlowPurgeTags(slugs), audits, undefined, db, ADMIN_ORIGIN);

    const response: AdminFlowCorrectionResponse = {
      correction: await loadAdminCorrection(db, id),
    };
    validateResponseInDev(c.env, () => AdminFlowCorrectionResponseSchema.parse(response));
    return json(response);
  };
}

function liftedError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.FLOW_CORRECTION_LIFTED,
    'This correction has already been lifted.',
  );
}

// ─── The admin reads ─────────────────────────────────────────────────────────

const replacementClaims = alias(claims, 'replacement_claims');

/** The correction rows, named, for the admin. `where` narrows them. */
async function adminCorrectionRows(
  db: Db,
  where: ReturnType<typeof and>,
): Promise<AdminFlowCorrectionRow[]> {
  const rows = await db
    .select({
      correction: claimAeciCorrections,
      integrationId: claims.integrationId,
      pairId: claims.connectorEvidencedPairId,
      integrationName: sql<
        string | null
      >`coalesce(${integrations.name}, ${connectorEvidencedPairs.name})`,
      dataObjectSlug: taxonomyDataObjects.slug,
      dataObjectName: taxonomyDataObjects.name,
      direction: claims.direction,
      replacementDirection: replacementClaims.direction,
    })
    .from(claimAeciCorrections)
    .innerJoin(claims, eq(claims.id, claimAeciCorrections.claimId))
    .innerJoin(taxonomyDataObjects, eq(taxonomyDataObjects.id, claims.dataObjectId))
    .leftJoin(integrations, eq(integrations.id, claims.integrationId))
    .leftJoin(
      connectorEvidencedPairs,
      eq(connectorEvidencedPairs.id, claims.connectorEvidencedPairId),
    )
    .leftJoin(replacementClaims, eq(replacementClaims.id, claimAeciCorrections.replacementClaimId))
    .where(where)
    // Newest first. Timestamps and ids order BINARY (`API_CONTRACTS.md` §3.2).
    .orderBy(desc(claimAeciCorrections.createdAt), asc(claimAeciCorrections.id));
  return rows.flatMap((row) => {
    const anchorId = row.integrationId ?? row.pairId;
    if (anchorId === null) return [];
    return [
      {
        correction: row.correction,
        anchor: row.integrationId ? ('integration' as const) : ('evidenced_pair' as const),
        anchorId,
        integrationName: row.integrationName,
        dataObjectSlug: row.dataObjectSlug,
        dataObjectName: row.dataObjectName,
        direction: row.direction,
        replacementDirection: row.replacementDirection,
      },
    ];
  });
}

async function loadAdminCorrection(db: Db, id: string) {
  const [row] = await adminCorrectionRows(db, and(eq(claimAeciCorrections.id, id)));
  if (!row) throw notFoundError('flow_correction', { id });
  return toAdminFlowCorrection(row);
}

/** `GET /api/admin/vendors/:id/flow-corrections`: live corrections on rows it owns. */
export function createAdminVendorFlowCorrectionsHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = param(c, 'id');
    const { db } = dbFor(c.env);
    const vendor = await db.query.vendors.findFirst({
      columns: { id: true },
      where: eq(vendors.id, vendorId),
    });
    if (!vendor) throw notFoundError('vendor', { id: vendorId });
    const rows = await adminCorrectionRows(
      db,
      and(
        isNull(claimAeciCorrections.retractedAt),
        or(
          eq(integrations.builtByVendorId, vendorId),
          eq(connectorEvidencedPairs.builtByVendorId, vendorId),
        ),
      ),
    );
    const response: AdminFlowCorrectionsResponse = { corrections: rows.map(toAdminFlowCorrection) };
    validateResponseInDev(c.env, () => AdminFlowCorrectionsResponseSchema.parse(response));
    return json(response);
  };
}

/** The pair page's direction order, for a stable list. */
const DIRECTION_RANK: Record<FlowCorrectionDirection, number> = { a_to_b: 0, both: 1, b_to_a: 2 };

/** `GET /api/admin/flows?integrationId=…|pairId=…`: every flow on one row. */
export function createAdminFlowsHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const query = AdminFlowsQuerySchema.safeParse({
      integrationId: c.req.query('integrationId'),
      pairId: c.req.query('pairId'),
    });
    if (!query.success) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Give exactly one of integrationId or pairId', {
        field: 'integrationId',
      });
    }
    const { db } = dbFor(c.env);
    const anchor = query.data.integrationId ? 'integration' : 'evidenced_pair';
    const anchorId = (query.data.integrationId ?? query.data.pairId) as string;
    const located = await loadFlowCorrectionRow(db, anchor, anchorId);
    if (!located) throw notFoundError('integration', { id: anchorId });
    const { target, facts } = located;

    const connector = target.connectorProductId
      ? await connectorFacts(db, target.connectorProductId)
      : undefined;
    const ctx = ownerFlowContextOf(target, connector);
    const [endpointRows, claimRows, corrections] = await Promise.all([
      db
        .select({ id: products.id, name: products.name })
        .from(products)
        .where(or(eq(products.id, target.productAId), eq(products.id, target.productBId))),
      db.query.claims.findMany({
        columns: { id: true, direction: true, origin: true },
        where: eq(claims.anchorId, anchorId),
        with: {
          dataObject: { columns: { slug: true, name: true, displayOrder: true } },
          attestations: {
            columns: { source: true, asserted: true, attestedByVendorId: true, retractedAt: true },
            where: isNull(attestations.retractedAt),
          },
          ownerAnswers: {
            columns: { asserted: true, vendorId: true, retractedAt: true },
            where: (t, { isNull: none }) => none(t.retractedAt),
          },
          aeciCorrections: {
            columns: { retractedAt: true },
            where: isNull(claimAeciCorrections.retractedAt),
          },
        },
      }),
      adminCorrectionRows(
        db,
        and(
          isNull(claimAeciCorrections.retractedAt),
          anchor === 'integration'
            ? eq(claims.integrationId, anchorId)
            : eq(claims.connectorEvidencedPairId, anchorId),
        ),
      ),
    ]);
    const name = new Map(endpointRows.map((r) => [r.id, r.name]));
    const correctionByClaim = new Map(corrections.map((row) => [row.correction.claimId, row]));
    const order = new Map(
      claimRows.map((claim) => [
        claim.id,
        claim.dataObject.displayOrder ?? Number.MAX_SAFE_INTEGER,
      ]),
    );
    const flows: AdminFlow[] = claimRows
      .map((claim): AdminFlow => {
        const voted = withOwnerVote(claim, ctx);
        const answer = claim.ownerAnswers.find((a) => ownerAnswerCounts(ctx, a)) ?? null;
        const correction = correctionByClaim.get(claim.id);
        return {
          claim_id: claim.id,
          data_object_slug: claim.dataObject.slug,
          data_object_name: claim.dataObject.name,
          direction: claim.direction as FlowCorrectionDirection,
          origin: claim.origin === 'vendor' ? 'vendor' : 'aeci',
          public: isClaimPubliclyBacked(voted),
          agreement: computeAgreement(voted.attestations),
          owner_answer: answer === null ? null : answer.asserted ? 'yes' : 'no',
          correction: correction ? toAdminFlowCorrection(correction) : null,
        };
      })
      .sort(
        (a, b) =>
          (order.get(a.claim_id) ?? 0) - (order.get(b.claim_id) ?? 0) ||
          compareText(a.data_object_name, b.data_object_name) ||
          DIRECTION_RANK[a.direction] - DIRECTION_RANK[b.direction] ||
          (a.claim_id < b.claim_id ? -1 : a.claim_id > b.claim_id ? 1 : 0),
      );
    const response: AdminFlowsResponse = {
      anchor_id: target.id,
      anchor,
      name: target.name,
      product_a: { id: target.productAId, name: name.get(target.productAId) ?? '' },
      product_b: { id: target.productBId, name: name.get(target.productBId) ?? '' },
      blocked: flowCorrectionBlock(facts),
      flows,
    };
    validateResponseInDev(c.env, () => AdminFlowsResponseSchema.parse(response));
    return json(response);
  };
}
