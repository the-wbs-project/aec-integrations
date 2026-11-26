/**
 * AECi's view of endpoint vetoes on Sync Service pairs, the lift, and the decision on a
 * Sync Service's objection (AECI-2042, AECI-2192; `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.2,
 * `ADMIN_PANEL_SPEC.md` §5.12).
 *
 *   GET   /api/admin/vetoes?in_force=true|false — the vetoes in force (default), or ended.
 *   POST  /api/admin/vetoes/:id/lift            — end a veto, with an end reason and a note.
 *   PATCH /api/admin/veto-objections/:id        — accept or decline an objection.
 *
 * Ruling 66 (2026-11-26, after counsel's Q73 and Q74): a removal takes effect when it is
 * sent and AECi does not check it first. AECi ends one only on five grounds, the
 * `REMOVAL_END_REASONS`: the three an objection may name (an account that should not
 * have had access, the wrong product, a reason plainly false on its face), the
 * vendor's claim ending or being suspended, and the law requiring it. AECi decides
 * nothing else, and not whether the vendor should support the integration. Both
 * vendors are told why: the end reason and the note go to the vetoing vendor, the
 * owners and the other endpoint vendors (`veto_lifted`).
 *
 * An objection's accept IS a lift whose end reason is the objection's ground, in the
 * same batch as the objection's own guarded UPDATE. A decline leaves the removal
 * standing and tells the objecting vendor why. A lift that is not an accept closes
 * any open objection (`closed`) in its batch. No automatic path ends a removal when a
 * claim ends (Chris ruled: manual).
 *
 * `requireAdmin()` → `rateLimit('write')` on both writes. One batch, the same as the
 * vendor withdraw's (`commitVetoChange`), with the admin as actor and the vendor that
 * filed it in `vendor_id`.
 */

import {
  AdminDecideVetoObjectionSchema,
  AdminLiftVetoSchema,
  AdminVetoesResponseSchema,
  ApiErrorCode,
  ListAdminVetoesQuerySchema,
  OBJECTION_ANSWER_BUSINESS_DAYS,
  VetoObjectionResponseSchema,
  VetoWriteResponseSchema,
  type AdminVetoesResponse,
  type RemovalEndReason,
  type VetoObjectionResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import {
  connectorEvidencedPairs,
  integrations,
  syncServicePairVetoes,
  syncServiceVetoObjections,
  vendors,
} from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { businessWindowEnd } from '../lib/business-days';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { ONE_ROW } from '../lib/integration-claims';
import {
  closeOpenObjectionStmt,
  isVetoRaceError,
  objectionWire,
  pairProducts,
  pairRightNotificationAudit,
  pairSlugsOf,
  VETO_ENTITY_TYPE,
  VETO_OBJECTION_ENTITY_TYPE,
  vetoKeyOf,
  vetoNoticeTarget,
  vetoRowChangedSentinel,
  vetoWireRows,
} from '../lib/sync-service-pair-rights';
import { commitVetoChange, vetoWriteBody } from '../lib/sync-service-veto-write';
import { parseJsonBody, type VendorContext } from './vendor-shared';

export const ADMIN_VETO_AUDIT_SOURCE = 'admin-moderation';

/** `GET /api/admin/vetoes`. Newest change first, 200 rows. Not rate-limited. */
export function createAdminListVetoesHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const query = ListAdminVetoesQuerySchema.parse(c.req.query());
    const { db } = dbFor(c.env);
    const rows = await db
      .select()
      .from(syncServicePairVetoes)
      .where(
        query.in_force
          ? isNull(syncServicePairVetoes.endedAt)
          : isNotNull(syncServicePairVetoes.endedAt),
      )
      // Newest first, id as tie-breaker: timestamp and id orderings stay BINARY.
      .orderBy(desc(syncServicePairVetoes.updatedAt), desc(syncServicePairVetoes.id))
      .limit(200);
    const wire = await vetoWireRows(db, rows);
    // The owner's name per row: two reads for the page, never one per row.
    const intIds = rows.map((r) => r.integrationId).filter((x): x is string => !!x);
    const pairIds = rows.map((r) => r.evidencedPairId).filter((x): x is string => !!x);
    const [intOwners, pairOwners] = await Promise.all([
      intIds.length
        ? db
            .select({ id: integrations.id, owner: vendors.companyName })
            .from(integrations)
            .leftJoin(vendors, eq(vendors.id, integrations.builtByVendorId))
            .where(
              // json_each, not inArray: D1 caps bound parameters per query.
              sql`${integrations.id} IN (SELECT value FROM json_each(${JSON.stringify(intIds)}))`,
            )
        : Promise.resolve([]),
      pairIds.length
        ? db
            .select({ id: connectorEvidencedPairs.id, owner: vendors.companyName })
            .from(connectorEvidencedPairs)
            .leftJoin(vendors, eq(vendors.id, connectorEvidencedPairs.builtByVendorId))
            .where(
              sql`${connectorEvidencedPairs.id} IN (SELECT value FROM json_each(${JSON.stringify(pairIds)}))`,
            )
        : Promise.resolve([]),
    ]);
    const ownerOf = new Map([...intOwners, ...pairOwners].map((r) => [r.id, r.owner ?? null]));
    const body: AdminVetoesResponse = {
      data: wire.map((v) => ({
        ...v,
        owner_name: v.pair.integration_id ? (ownerOf.get(v.pair.integration_id) ?? null) : null,
        objection_answer_due: objectionAnswerDue(v.objection),
      })),
    };
    validateResponseInDev(c.env, () => AdminVetoesResponseSchema.parse(body));
    return json(body);
  };
}

/**
 * When AECi must answer an open objection: five business days from when it was received
 * (the Listing Accuracy Policy), through the same `businessWindowEnd` the value-hide
 * clocks use. `null` once the objection is decided or closed.
 */
export function objectionAnswerDue(
  objection: { status: string; created_at: string } | null,
): string | null {
  if (!objection || objection.status !== 'open') return null;
  return businessWindowEnd(objection.created_at, OBJECTION_ANSWER_BUSINESS_DAYS);
}

function notInForceError(): ApiError {
  return new ApiError(409, ApiErrorCode.VETO_NOT_IN_FORCE, 'This removal has already ended.');
}

function objectionNotOpenError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.VETO_OBJECTION_NOT_OPEN,
    'This objection was already decided, or the removal ended. Reload to see where it stands.',
  );
}

type VetoRow = typeof syncServicePairVetoes.$inferSelect;

/**
 * End a veto as AECi: the guarded UPDATE with the end reason and the note, then the
 * shared batch. `extraFirst` runs ahead of it (an accept's guarded objection UPDATE and
 * its sentinel). Without it, any open objection is closed in the same batch.
 */
async function endVetoAsAdmin(
  c: VendorContext,
  db: Db,
  row: VetoRow,
  args: {
    endReason: RemovalEndReason;
    note: string;
    now: string;
    extraFirst?: BatchStmt[];
    extraAudit?: AuditLogEntry[];
    /** More vendors to tell (an accept tells the objecting vendor). */
    alsoTell?: readonly (string | null)[];
    changedError: () => ApiError;
    hookPrefix: string;
  },
): Promise<void> {
  const session = c.get('auth');
  const { now } = args;
  const update = db
    .update(syncServicePairVetoes)
    .set({
      endedAt: now,
      endedHow: 'lifted',
      endedBy: session.userId,
      endReason: args.endReason,
      endNote: args.note,
      updatedAt: now,
    })
    .where(and(eq(syncServicePairVetoes.id, row.id), isNull(syncServicePairVetoes.endedAt)));
  const audit: AuditLogEntry = {
    actorId: session.userId,
    actorType: auditActorType(session),
    action: 'integration.veto_lifted',
    entityType: VETO_ENTITY_TYPE,
    entityId: row.id,
    // AECI-1192: the row is about the vendor whose veto ended.
    vendorId: row.vendorId,
    beforeState: { ended_at: null },
    afterState: { ended_at: now, ended_how: 'lifted', end_reason: args.endReason },
    metadata: {
      source: ADMIN_VETO_AUDIT_SOURCE,
      reason: args.note,
      reasonVisibility: 'vendor',
      endReason: args.endReason,
    },
  };
  const rowWrite: BatchStmt[] = [
    ...(args.extraFirst ?? []),
    update,
    vetoRowChangedSentinel(db),
    ...(args.extraFirst ? [] : [closeOpenObjectionStmt(db, row.id, now)]),
  ];
  // The anchor, or another row on the veto's key when the anchor is gone. The
  // recompute is keyed on the veto row's own key either way.
  const target = await vetoNoticeTarget(db, row);
  if (!target) {
    try {
      await db.batch([
        ...rowWrite,
        auditInsert(db, audit),
        ...(args.extraAudit ?? []).map((entry) => auditInsert(db, entry)),
      ] as BatchTuple);
    } catch (error) {
      if (isVetoRaceError(error) === 'changed') throw args.changedError();
      throw error;
    }
    return;
  }
  await commitVetoChange(c, db, {
    key: vetoKeyOf(row),
    target,
    vetoId: row.id,
    rowWrite,
    audit,
    extraAudit: args.extraAudit,
    event: 'veto_lifted',
    actingVendorId: null,
    byVendorName: null,
    alsoTell: [row.vendorId, ...(args.alsoTell ?? [])].filter((id): id is string => !!id),
    ownerReason: args.note,
    endReason: args.endReason,
    now,
    stamp: (entry) => entry,
    changedError: args.changedError,
    origin: { auditSource: ADMIN_VETO_AUDIT_SOURCE, purgeSource: 'moderation' },
    hookPrefix: args.hookPrefix,
  });
}

/** `POST /api/admin/vetoes/:id/lift`. */
export function createAdminLiftVetoHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vetoId = c.req.param('id');
    if (!vetoId) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing id', { field: 'id' });
    const { note, end_reason: endReason } = await parseJsonBody(c, AdminLiftVetoSchema);
    const { db } = writeDb(c, dbFor);
    const row = await db.query.syncServicePairVetoes.findFirst({
      where: eq(syncServicePairVetoes.id, vetoId),
    });
    if (!row) throw notFoundError('veto', { id: vetoId });
    if (row.endedAt !== null) throw notInForceError();
    await endVetoAsAdmin(c, db, row, {
      endReason,
      note,
      now: new Date().toISOString(),
      changedError: notInForceError,
      hookPrefix: 'admin-veto-lift',
    });
    const body = await vetoWriteBody(db, vetoId);
    validateResponseInDev(c.env, () => VetoWriteResponseSchema.parse(body));
    return json(body);
  };
}

/** The token the objection's guards raise. */
const OBJECTION_CHANGED_TOKEN = 'veto-objection-changed';

function objectionChangedSentinel(db: Db): BatchStmt {
  return db
    .select({ guard: sql`CASE WHEN changes() = 0 THEN json(${OBJECTION_CHANGED_TOKEN}) END` })
    .from(ONE_ROW);
}

/**
 * `PATCH /api/admin/veto-objections/:id` (AECI-2192). Accept: the removal ends with the
 * objection's ground as its end reason, every row on the pair key returns through the
 * key-wide recompute, and both vendors are told why. Decline: the removal stands, and
 * the objecting vendor is told why. A note is required either way.
 */
export function createAdminDecideVetoObjectionHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const objectionId = c.req.param('id');
    if (!objectionId) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing id', { field: 'id' });
    const { decision, note } = await parseJsonBody(c, AdminDecideVetoObjectionSchema);
    const { db } = writeDb(c, dbFor);
    const objection = await db.query.syncServiceVetoObjections.findFirst({
      where: eq(syncServiceVetoObjections.id, objectionId),
    });
    if (!objection) throw notFoundError('veto_objection', { id: objectionId });
    if (objection.status !== 'open') throw objectionNotOpenError();
    const veto = await db.query.syncServicePairVetoes.findFirst({
      where: eq(syncServicePairVetoes.id, objection.vetoId),
    });
    if (!veto || veto.endedAt !== null) throw objectionNotOpenError();
    const now = new Date().toISOString();
    const status = decision === 'accept' ? 'accepted' : 'declined';
    const objectionUpdate = db
      .update(syncServiceVetoObjections)
      .set({
        status,
        decisionNote: note,
        decidedBy: session.userId,
        decidedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(syncServiceVetoObjections.id, objectionId),
          eq(syncServiceVetoObjections.status, 'open'),
        ),
      );
    const decisionAudit: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action:
        status === 'accepted'
          ? 'integration.veto_objection.accepted'
          : 'integration.veto_objection.declined',
      entityType: VETO_OBJECTION_ENTITY_TYPE,
      entityId: objectionId,
      vendorId: objection.vendorId,
      beforeState: { status: 'open' },
      afterState: { status, ground: objection.ground },
      metadata: {
        source: ADMIN_VETO_AUDIT_SOURCE,
        vetoId: veto.id,
        reason: note,
        reasonVisibility: 'vendor',
      },
    };

    if (decision === 'accept') {
      await endVetoAsAdmin(c, db, veto, {
        endReason: objection.ground,
        note,
        now,
        extraFirst: [objectionUpdate, objectionChangedSentinel(db)],
        extraAudit: [decisionAudit],
        alsoTell: [objection.vendorId],
        changedError: objectionNotOpenError,
        hookPrefix: 'admin-veto-objection-accept',
      });
    } else {
      // The removal stands. The objecting vendor is told why, in the same batch.
      const target = await vetoNoticeTarget(db, veto);
      const key = vetoKeyOf(veto);
      const named = await pairProducts(db, key);
      const actor = { actorId: session.userId, actorType: auditActorType(session) };
      const notice =
        objection.vendorId && target
          ? [
              pairRightNotificationAudit('portal-sync-service-veto', actor, target.anchor, {
                event: 'objection_declined',
                vendorId: objection.vendorId,
                integrationId: target.id,
                integrationName: target.name,
                reportKind: null,
                byVendorName: null,
                reason: note,
                pairPublic: false,
                pairSlugs: pairSlugsOf(key, named),
              }),
            ]
          : [];
      try {
        await db.batch([
          objectionUpdate,
          objectionChangedSentinel(db),
          // The removal is still in force at commit, else nothing is written.
          db
            .select({
              guard: sql`CASE WHEN NOT EXISTS (SELECT 1 FROM ${syncServicePairVetoes} WHERE ${syncServicePairVetoes.id} = ${veto.id} AND ${syncServicePairVetoes.endedAt} IS NULL) THEN json(${OBJECTION_CHANGED_TOKEN}) END`,
            })
            .from(ONE_ROW),
          auditInsert(db, decisionAudit),
          ...notice.map((entry) => auditInsert(db, entry)),
        ] as BatchTuple);
      } catch (error) {
        if (isVetoRaceError(error) === 'changed') throw objectionNotOpenError();
        throw error;
      }
    }
    const row = await db.query.syncServiceVetoObjections.findFirst({
      where: eq(syncServiceVetoObjections.id, objectionId),
    });
    const body: VetoObjectionResponse = { objection: objectionWire(row!) };
    validateResponseInDev(c.env, () => VetoObjectionResponseSchema.parse(body));
    return json(body);
  };
}
