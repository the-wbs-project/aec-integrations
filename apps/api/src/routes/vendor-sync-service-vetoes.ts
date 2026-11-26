/**
 * An endpoint vendor's veto on a pair a Sync Service delivers (AECI-2042, ruling 8 on
 * AECI-2035, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.2, `API_CONTRACTS.md` §6.15b).
 *
 *   POST /api/vendor/integrations/:id/veto   — file a veto; the pair leaves the site (201).
 *   POST /api/vendor/vetoes/:id/withdraw     — the vetoing vendor withdraws it (200).
 *   GET  /api/vendor/vetoes                  — vetoes filed, and vetoes on pairs owned.
 *
 * ── THE GATE ────────────────────────────────────────────────────────────────
 * `requireVendor()` → `rateLimit('write')` on the two writes, then
 * `resolvePairRightTarget` (`lib/sync-service-pair-rights.ts`): an endpoint vendor of a
 * pair whose connector is a Sync Service, and not its owner. A seat is the whole gate.
 * The read is not rate-limited.
 *
 * ── NOT JUDGED ──────────────────────────────────────────────────────────────
 * A veto takes effect the moment it is filed (ruled 2026-11-24 on AECI-2042). AECi does
 * not check it first. The reason is required, so the owner learns why, and it is never
 * public.
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
  FileVetoSchema,
  VendorVetoesResponseSchema,
  VetoWriteResponseSchema,
  type VendorVetoesResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, desc, eq, isNull } from 'drizzle-orm';

import { getDb } from '../db/client';
import { syncServicePairVetoes, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
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
    const { reason } = await parseJsonBody(c, FileVetoSchema);

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
        afterState: { vetoed_at: now, reason },
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
      ownerReason: reason,
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
        rowWrite: [update, vetoRowChangedSentinel(db)],
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
