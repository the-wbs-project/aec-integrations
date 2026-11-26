/**
 * An endpoint vendor's veto on a pair a Sync Service delivers (AECI-2042, ruling 8 on
 * AECI-2035, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.2, `API_CONTRACTS.md` §6.15b).
 *
 *   POST /api/vendor/integrations/:id/veto   — file a veto; the pair leaves the site (201).
 *   POST /api/vendor/vetoes/:id/withdraw     — the vetoing vendor withdraws it (200).
 *   GET  /api/vendor/vetoes                  — vetoes filed, and vetoes on pairs owned.
 *   POST /api/vendor/vetoes/:id/objections   — the Sync Service objects (201, AECI-2192).
 *
 * ── THE GATE ────────────────────────────────────────────────────────────────
 * `requireVendor()` → `rateLimit('write')` on the three writes, then, on a veto,
 * `resolvePairRightTarget` (`lib/sync-service-pair-rights.ts`): an endpoint vendor of a
 * pair whose connector is a Sync Service, and not its owner. A seat is the whole gate.
 * An objection's gate is `vetoesOwnedByWhere`. The read is not rate-limited.
 *
 * ── NOT CHECKED FIRST (ruling 66, after counsel's Q73 and Q74) ─────────────
 * A veto takes effect the moment it is filed. AECi does not check it first. The vendor
 * picks one reason from a fixed list (`REMOVAL_REASON_CODES`), recorded with the time.
 * The Sync Service is told at once, with the reason and how to object. Nothing public
 * carries the removal. AECi looks at an objection afterwards, on three grounds only.
 *
 * ── ONE BATCH ───────────────────────────────────────────────────────────────
 * The gate sentinel and the veto INSERT (or the guarded withdraw UPDATE and its
 * `changes()` sentinel), `vetoed_at` recomputed from the table on every row on the pair
 * key in both tables, the `integration.vetoed` /
 * `integration.veto_withdrawn` audit row, one `notification.sent` row per owner and
 * other endpoint vendor, and the three `integration_count` recomputes (both endpoints
 * and the connector). A second veto by the same vendor trips the open-veto unique
 * index and answers `409 VETO_DUPLICATE` with nothing written. A row, connector, owner
 * or seat change between the gate and the commit trips `pairRightTargetSentinel` and
 * answers `409 VETO_PAIR_CHANGED` with nothing written.
 *
 * After commit, the retire's tail (`afterRetireCommit`): by-id Algolia sync of every row
 * on the key, the three products and every vendor of them; purge `pair:`, both endpoint
 * `product:` tags, the connector's `product:` tag, `vendor:{owner}` of every row's
 * owner, `index:products`, `taxonomy`
 * and `sitemap`; queue the pair re-crawl.
 */

import {
  ApiErrorCode,
  FileVetoObjectionSchema,
  FileVetoSchema,
  OBJECTION_GROUND_LABELS,
  REMOVAL_REASON_LABELS,
  VendorVetoesResponseSchema,
  VetoObjectionResponseSchema,
  VetoWriteResponseSchema,
  isRemovalReasonCode,
  type VendorVetoesResponse,
  type VetoObjectionResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { getDb } from '../db/client';
import { syncServicePairVetoes, syncServiceVetoObjections, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { sendVetoObjectionSubmittedNotification } from '../lib/email';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { ONE_ROW } from '../lib/integration-claims';
import {
  closeOpenObjectionStmt,
  objectionWire,
  pairProducts,
  pairSlugsOf,
  VETO_OBJECTION_ENTITY_TYPE,
  isVetoRaceError,
  pairKeyOf,
  pairRightTargetSentinel,
  resolvePairRightTarget,
  VETO_ENTITY_TYPE,
  vetoesOwnedByWhere,
  vetoKeyOf,
  vetoNoticeTarget,
  vetoPairChangedError,
  vetoRowChangedSentinel,
  vetoWireRows,
} from '../lib/sync-service-pair-rights';
import { commitVetoChange, vetoWriteBody } from '../lib/sync-service-veto-write';
import {
  AUDIT_SOURCE,
  parseJsonBody,
  sessionVendorId,
  vendorAuditEntry,
  type VendorContext,
} from './vendor-shared';

const LIST_CAP = 100;

function param(c: VendorContext, name: 'id'): string {
  const value = c.req.param(name);
  if (!value) throw new ApiError(400, 'VALIDATION_FAILED', `Missing ${name}`, { field: name });
  return value;
}

/** `POST /api/vendor/integrations/:id/veto`. 201 with the veto. */
export function createFileVetoHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);
    const { target } = await resolvePairRightTarget(db, vendorId, param(c, 'id'));
    // AECI-2192 (ruling 66): one reason from the fixed list. The `reason` column keeps
    // its NOT NULL and holds the code's English label, so the row reads on its own.
    const { reason_code: reasonCode } = await parseJsonBody(c, FileVetoSchema);
    const reason = REMOVAL_REASON_LABELS[reasonCode];

    // One veto in force per vendor per pair: answered here, and by the unique index
    // if two land at once.
    const existing = await db.query.syncServicePairVetoes.findFirst({
      columns: { id: true },
      where: and(
        eq(syncServicePairVetoes.connectorProductId, target.connectorProductId),
        eq(syncServicePairVetoes.productAId, target.productAId),
        eq(syncServicePairVetoes.productBId, target.productBId),
        eq(syncServicePairVetoes.vendorId, vendorId),
        isNull(syncServicePairVetoes.endedAt),
      ),
    });
    if (existing) {
      throw new ApiError(
        409,
        ApiErrorCode.VETO_DUPLICATE,
        'Your company already removed this integration from its product.',
      );
    }

    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const vetoingName =
      (
        await db.query.vendors.findFirst({
          columns: { companyName: true },
          where: eq(vendors.id, vendorId),
        })
      )?.companyName ?? null;
    const insert = db.insert(syncServicePairVetoes).values({
      id,
      integrationId: target.anchor === 'integration' ? target.id : null,
      evidencedPairId: target.anchor === 'evidenced_pair' ? target.id : null,
      connectorProductId: target.connectorProductId,
      productAId: target.productAId,
      productBId: target.productBId,
      vendorId,
      vendorName: vetoingName,
      reason,
      reasonCode,
      filedBy: session.userId,
      filedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await commitVetoChange(c, db, {
      key: pairKeyOf(target),
      target,
      vetoId: id,
      // The gate again, at commit: the row still has this connector and these
      // endpoints, the connector is still a Sync Service, the caller still holds an
      // endpoint and is still not the owner. Otherwise nothing is written.
      rowWrite: [pairRightTargetSentinel(db, target, vendorId), insert],
      audit: {
        actorId: session.userId,
        actorType: auditActorType(session),
        action: 'integration.vetoed',
        entityType: VETO_ENTITY_TYPE,
        entityId: id,
        // The filed time and the fixed reason are the record ruling 66 asks for.
        afterState: { vetoed_at: now, filed_at: now, reason_code: reasonCode },
        metadata: {
          source: AUDIT_SOURCE,
          vendorId,
          connectorProductId: target.connectorProductId,
          ownerVendorId: target.builtByVendorId,
        },
      },
      event: 'vetoed',
      actingVendorId: vendorId,
      byVendorName: vetoingName,
      ownerReason: null,
      reasonCode,
      now,
      stamp: (entry) => vendorAuditEntry(c, entry),
      // The INSERT carries no `changes()` sentinel, so a "changed" abort is the gate's.
      changedError: vetoPairChangedError,
      hookPrefix: 'vendor-veto',
    });
    const body = await vetoWriteBody(db, id);
    validateResponseInDev(c.env, () => VetoWriteResponseSchema.parse(body));
    return json(body, { status: 201 });
  };
}

/** `POST /api/vendor/vetoes/:id/withdraw`. Only a seat of the vetoing vendor. */
export function createWithdrawVetoHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);
    const vetoId = param(c, 'id');
    const row = await db.query.syncServicePairVetoes.findFirst({
      where: eq(syncServicePairVetoes.id, vetoId),
    });
    // Another vendor's veto is the same 404 as an unknown id.
    if (!row || row.vendorId !== vendorId) throw notFoundError('veto', { id: vetoId });
    if (row.endedAt !== null) {
      throw new ApiError(409, ApiErrorCode.VETO_NOT_IN_FORCE, 'This veto has already ended.');
    }
    const now = new Date().toISOString();
    const update = db
      .update(syncServicePairVetoes)
      .set({ endedAt: now, endedHow: 'withdrawn', endedBy: session.userId, updatedAt: now })
      .where(
        and(
          eq(syncServicePairVetoes.id, vetoId),
          eq(syncServicePairVetoes.vendorId, vendorId),
          isNull(syncServicePairVetoes.endedAt),
        ),
      );
    const audit: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: 'integration.veto_withdrawn',
      entityType: VETO_ENTITY_TYPE,
      entityId: vetoId,
      beforeState: { ended_at: null },
      afterState: { ended_at: now, ended_how: 'withdrawn' },
      metadata: { source: AUDIT_SOURCE, vendorId },
    };
    // The anchor, or another row on the veto's key when the anchor is gone. The
    // recompute is keyed on the veto row's own key either way.
    const target = await vetoNoticeTarget(db, row);
    if (!target) {
      // No row is on the key any more. The veto still ends, so the pair key may be
      // added again; there is no row to recompute and nobody to tell.
      await db
        .batch([
          update,
          vetoRowChangedSentinel(db),
          closeOpenObjectionStmt(db, vetoId, now),
          auditInsert(db, vendorAuditEntry(c, audit)),
        ] as BatchTuple)
        .catch((error: unknown) => {
          if (isVetoRaceError(error) === 'changed') {
            throw new ApiError(409, ApiErrorCode.VETO_NOT_IN_FORCE, 'This veto has already ended.');
          }
          throw error;
        });
    } else {
      await commitVetoChange(c, db, {
        key: vetoKeyOf(row),
        target,
        vetoId,
        // A withdrawn removal closes any open objection to it (AECI-2192).
        rowWrite: [update, vetoRowChangedSentinel(db), closeOpenObjectionStmt(db, vetoId, now)],
        audit,
        event: 'veto_withdrawn',
        actingVendorId: vendorId,
        byVendorName: row.vendorName,
        ownerReason: null,
        now,
        stamp: (entry) => vendorAuditEntry(c, entry),
        changedError: () =>
          new ApiError(409, ApiErrorCode.VETO_NOT_IN_FORCE, 'This veto has already ended.'),
        hookPrefix: 'vendor-veto-withdraw',
      });
    }
    const body = await vetoWriteBody(db, vetoId);
    validateResponseInDev(c.env, () => VetoWriteResponseSchema.parse(body));
    return json(body);
  };
}

/** The token the objection gate raises. */
const OBJECTION_GATE_TOKEN = 'veto-objection-gate';

/** True when the open-objection unique index refused the INSERT (any depth of cause). */
function isObjectionDuplicateError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (/UNIQUE constraint failed: sync_service_veto_objections/i.test(text)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function objectionDuplicateError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.VETO_OBJECTION_DUPLICATE,
    'An objection to this removal is already with AEC Integrations.',
  );
}

/**
 * `POST /api/vendor/vetoes/:id/objections` (AECI-2192, ruling 66). The Sync Service
 * objects to a removal on one of three grounds. 201 with the objection.
 *
 * The gate: the veto is in force, and the caller's vendor owns a row on its pair key
 * or holds its connector product (`vetoesOwnedByWhere`, the predicate of the owner's
 * "Removed from your integrations" list). Anyone else gets the 404 an unknown id gets.
 * The gate is read here and asserted again in the batch, so a withdraw, a lift or an
 * owner change that lands in between writes nothing (`409 VETO_NOT_IN_FORCE`). One
 * open objection per removal, by the partial unique index (`409 VETO_OBJECTION_DUPLICATE`).
 *
 * It always routes to AECi. The batch writes the objection and its audit row and tells
 * no vendor: like an AECi-routed contest (§11b.8), the removing vendor learns of an
 * objection only when AECi accepts it. After commit the AECi alert email goes to
 * `SUPPORT_EMAIL`. Filing hides and shows nothing, so nothing is purged.
 */
export function createFileVetoObjectionHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);
    const vetoId = param(c, 'id');
    const [veto] = await db
      .select()
      .from(syncServicePairVetoes)
      .where(and(eq(syncServicePairVetoes.id, vetoId), vetoesOwnedByWhere(vendorId)))
      .limit(1);
    if (!veto) throw notFoundError('veto', { id: vetoId });
    const payload = await parseJsonBody(c, FileVetoObjectionSchema);
    if (veto.endedAt !== null) {
      throw new ApiError(409, ApiErrorCode.VETO_NOT_IN_FORCE, 'This removal has already ended.');
    }
    const open = await db.query.syncServiceVetoObjections.findFirst({
      columns: { id: true },
      where: and(
        eq(syncServiceVetoObjections.vetoId, vetoId),
        eq(syncServiceVetoObjections.status, 'open'),
      ),
    });
    if (open) throw objectionDuplicateError();

    const now = new Date().toISOString();
    const objectorName =
      (
        await db.query.vendors.findFirst({
          columns: { companyName: true },
          where: eq(vendors.id, vendorId),
        })
      )?.companyName ?? null;
    const id = crypto.randomUUID();
    const sourceUrl = payload.ground === 'reason_plainly_false' ? payload.source_url! : null;
    const audit: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: 'integration.veto_objection.filed',
      entityType: VETO_OBJECTION_ENTITY_TYPE,
      entityId: id,
      afterState: { status: 'open', ground: payload.ground, source_url: sourceUrl },
      metadata: { source: AUDIT_SOURCE, vendorId, vetoId, vetoVendorId: veto.vendorId },
    };
    const v = syncServicePairVetoes;
    try {
      await db.batch([
        // The gate again, at commit: still in force, and the caller still owns a row on
        // the key or holds the connector. Otherwise nothing is written.
        db
          .select({
            guard: sql`CASE WHEN NOT EXISTS (SELECT 1 FROM ${v} WHERE ${v.id} = ${vetoId} AND ${v.endedAt} IS NULL AND ${vetoesOwnedByWhere(vendorId)}) THEN json(${OBJECTION_GATE_TOKEN}) END`,
          })
          .from(ONE_ROW),
        db.insert(syncServiceVetoObjections).values({
          id,
          vetoId,
          vendorId,
          vendorName: objectorName,
          ground: payload.ground,
          explanation: payload.explanation,
          sourceUrl,
          filedBy: session.userId,
          status: 'open',
          createdAt: now,
          updatedAt: now,
        }),
        auditInsert(db, vendorAuditEntry(c, audit)),
      ] as BatchTuple);
    } catch (error) {
      if (isObjectionDuplicateError(error)) throw objectionDuplicateError();
      if (isVetoRaceError(error) === 'changed') {
        throw new ApiError(
          409,
          ApiErrorCode.VETO_NOT_IN_FORCE,
          'This removal ended, or your company’s link to it changed. Nothing was sent.',
        );
      }
      throw error;
    }

    // The AECi alert, after commit. A failed send never changes the 201.
    const key = vetoKeyOf(veto);
    const target = await vetoNoticeTarget(db, veto);
    const named = await pairProducts(db, key);
    c.executionCtx.waitUntil(
      sendVetoObjectionSubmittedNotification(c, {
        objectionId: id,
        integrationName: target?.name ?? 'this integration',
        objectorVendorName: objectorName ?? 'A vendor',
        removingVendorName: veto.vendorName ?? 'A vendor',
        removalReason: isRemovalReasonCode(veto.reasonCode)
          ? REMOVAL_REASON_LABELS[veto.reasonCode]
          : veto.reason,
        ground: OBJECTION_GROUND_LABELS[payload.ground],
        explanation: payload.explanation,
        sourceUrl,
        pairSlugs: pairSlugsOf(key, named),
      }).then(
        () => undefined,
        () => undefined,
      ),
    );
    const row = await db.query.syncServiceVetoObjections.findFirst({
      where: eq(syncServiceVetoObjections.id, id),
    });
    const body: VetoObjectionResponse = { objection: objectionWire(row!) };
    validateResponseInDev(c.env, () => VetoObjectionResponseSchema.parse(body));
    return json(body, { status: 201 });
  };
}

/** `GET /api/vendor/vetoes`. Not rate-limited: a read. */
export function createListVendorVetoesHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const { db } = dbFor(c.env);
    // Newest change first, id as the tie-breaker (an id ordering stays BINARY).
    const [filed, received] = await Promise.all([
      db
        .select()
        .from(syncServicePairVetoes)
        .where(eq(syncServicePairVetoes.vendorId, vendorId))
        .orderBy(desc(syncServicePairVetoes.updatedAt), desc(syncServicePairVetoes.id))
        .limit(LIST_CAP),
      db
        .select()
        .from(syncServicePairVetoes)
        .where(vetoesOwnedByWhere(vendorId))
        .orderBy(desc(syncServicePairVetoes.updatedAt), desc(syncServicePairVetoes.id))
        .limit(LIST_CAP),
    ]);
    const body: VendorVetoesResponse = {
      filed: await vetoWireRows(db, filed),
      received: await vetoWireRows(db, received),
    };
    validateResponseInDev(c.env, () => VendorVetoesResponseSchema.parse(body));
    return json(body);
  };
}
