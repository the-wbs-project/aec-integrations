/**
 * AECi's view of endpoint vetoes on Sync Service pairs, and the lift (AECI-2042,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.2, `ADMIN_PANEL_SPEC.md` §5.12).
 *
 *   GET  /api/admin/vetoes?in_force=true|false — the vetoes in force (default), or ended.
 *   POST /api/admin/vetoes/:id/lift            — end a veto, with a required note.
 *
 * A veto is not judged (ruling 8): AECi does not review a veto before or after it takes
 * effect. The lift exists for one case: a veto filed through a seat that should not have
 * had it (a seat granted in error, a company that no longer makes the endpoint product).
 * The note is required and goes to the vetoing vendor and the owner. When more than one
 * vendor vetoed the pair, a lift ends only this one: the pair returns when none is left.
 * The lift recomputes `vetoed_at` on every row on the veto's pair key, so every row the
 * veto hid comes back together, including after the row it was filed on is gone.
 *
 * `requireAdmin()` → `rateLimit('write')` on the lift. One batch, the same as the vendor
 * withdraw's (`commitVetoChange`), with the admin as actor and the vendor that filed it
 * in `vendor_id`.
 */

import {
  AdminLiftVetoSchema,
  AdminVetoesResponseSchema,
  ApiErrorCode,
  ListAdminVetoesQuerySchema,
  VetoWriteResponseSchema,
  type AdminVetoesResponse,
} from '@aeci/shared';
import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { getDb } from '../db/client';
import {
  connectorEvidencedPairs,
  integrations,
  syncServicePairVetoes,
  vendors,
} from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
  isVetoRaceError,
  VETO_ENTITY_TYPE,
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
      })),
    };
    validateResponseInDev(c.env, () => AdminVetoesResponseSchema.parse(body));
    return json(body);
  };
}

/** `POST /api/admin/vetoes/:id/lift`. */
export function createAdminLiftVetoHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vetoId = c.req.param('id');
    if (!vetoId) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing id', { field: 'id' });
    const { note } = await parseJsonBody(c, AdminLiftVetoSchema);
    const { db } = writeDb(c, dbFor);
    const row = await db.query.syncServicePairVetoes.findFirst({
      where: eq(syncServicePairVetoes.id, vetoId),
    });
    if (!row) throw notFoundError('veto', { id: vetoId });
    if (row.endedAt !== null) {
      throw new ApiError(409, ApiErrorCode.VETO_NOT_IN_FORCE, 'This veto has already ended.');
    }
    const now = new Date().toISOString();
    const update = db
      .update(syncServicePairVetoes)
      .set({
        endedAt: now,
        endedHow: 'lifted',
        endedBy: session.userId,
        endNote: note,
        updatedAt: now,
      })
      .where(and(eq(syncServicePairVetoes.id, vetoId), isNull(syncServicePairVetoes.endedAt)));
    const audit = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: 'integration.veto_lifted',
      entityType: VETO_ENTITY_TYPE,
      entityId: vetoId,
      // AECI-1192: the row is about the vendor whose veto ended.
      vendorId: row.vendorId,
      beforeState: { ended_at: null },
      afterState: { ended_at: now, ended_how: 'lifted' },
      metadata: {
        source: ADMIN_VETO_AUDIT_SOURCE,
        reason: note,
        reasonVisibility: 'vendor',
      },
    };
    // The anchor, or another row on the veto's key when the anchor is gone. The
    // recompute is keyed on the veto row's own key either way.
    const target = await vetoNoticeTarget(db, row);
    if (!target) {
      try {
        await db.batch([update, vetoRowChangedSentinel(db), auditInsert(db, audit)] as BatchTuple);
      } catch (error) {
        if (isVetoRaceError(error) === 'changed') {
          throw new ApiError(409, ApiErrorCode.VETO_NOT_IN_FORCE, 'This veto has already ended.');
        }
        throw error;
      }
    } else {
      await commitVetoChange(c, db, {
        key: vetoKeyOf(row),
        target,
        vetoId,
        rowWrite: [update, vetoRowChangedSentinel(db)],
        audit,
        event: 'veto_lifted',
        actingVendorId: null,
        byVendorName: null,
        alsoTell: row.vendorId ? [row.vendorId] : [],
        ownerReason: note,
        now,
        stamp: (entry) => entry,
        changedError: () =>
          new ApiError(409, ApiErrorCode.VETO_NOT_IN_FORCE, 'This veto has already ended.'),
        origin: { auditSource: ADMIN_VETO_AUDIT_SOURCE, purgeSource: 'moderation' },
        hookPrefix: 'admin-veto-lift',
      });
    }
    const body = await vetoWriteBody(db, vetoId);
    validateResponseInDev(c.env, () => VetoWriteResponseSchema.parse(body));
    return json(body);
  };
}
