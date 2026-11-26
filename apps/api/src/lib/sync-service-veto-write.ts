/**
 * The shared write of a veto, a withdraw and a lift (AECI-2042,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.2). The vendor routes
 * (`routes/vendor-sync-service-vetoes.ts`) and the admin lift
 * (`routes/admin-sync-service-vetoes.ts`) differ only in the row write and in how they
 * stamp their audit rows: a vendor route passes `vendorAuditEntry`, the admin route
 * stamps the vendor itself.
 *
 * One batch: the row write (the gate sentinel and the INSERT, or the guarded UPDATE and
 * its `changes()` sentinel), `vetoed_at` recomputed from the table on EVERY row on the
 * pair key in both tables, the audit row, one `notification.sent` per owner and other
 * endpoint vendor, and the three `integration_count` recomputes. After commit, the
 * retire's tail, over every row on the key.
 */

import {
  ApiErrorCode,
  type RemovalEndReason,
  type RemovalReasonCode,
  type VetoWriteResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { eq, inArray } from 'drizzle-orm';

import type { Db } from '../db/client';
import { syncServicePairVetoes, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { afterRetireCommit } from '../routes/integration-retire-write';
import type { VendorContext } from '../routes/vendor-shared';
import { auditInsert, type BatchStmt, type BatchTuple } from './audit';
import { auditActorType } from './authz';
import {
  isVetoRaceError,
  openVetoOnKeyWhere,
  pairKeyIsPublic,
  pairProducts,
  pairRightNotificationAudit,
  pairSlugsOf,
  rowsOnPairKey,
  vetoAudience,
  vetoCountRecomputes,
  vetoedAtKeyRecompute,
  vetoKeyOf,
  vetoWireRows,
  type PairKey,
  type PairRightTarget,
} from './sync-service-pair-rights';

/** The veto's wire row after a write, and whether its pair key is public now. */
export async function vetoWriteBody(db: Db, vetoId: string): Promise<VetoWriteResponse> {
  const row = await db.query.syncServicePairVetoes.findFirst({
    where: eq(syncServicePairVetoes.id, vetoId),
  });
  if (!row) throw notFoundError('veto', { id: vetoId });
  const [veto] = await vetoWireRows(db, [row]);
  return { veto: veto!, pair_public: await pairKeyIsPublic(db, vetoKeyOf(row)) };
}

/** The owners' slugs for the purge tags. */
async function ownerSlugs(
  db: Db,
  ownerIds: readonly string[],
): Promise<{ id: string; slug: string }[]> {
  if (ownerIds.length === 0) return [];
  return db
    .select({ id: vendors.id, slug: vendors.slug })
    .from(vendors)
    .where(inArray(vendors.id, [...ownerIds]))
    .orderBy(vendors.id);
}

/**
 * The veto, withdraw and lift share everything after the row write: the key-wide
 * recompute, the audit and notices, the counts, the batch, and the tail. `rowWrite` is
 * the gate sentinel and the INSERT, or the guarded UPDATE plus its sentinel. `key` is
 * the veto row's pair key; `target` is a row on it that names the pair in notices (the
 * anchor, or another row on the key when the anchor is gone).
 */
export async function commitVetoChange(
  c: VendorContext,
  db: Db,
  args: {
    key: PairKey;
    target: PairRightTarget;
    vetoId: string;
    rowWrite: BatchStmt[];
    audit: AuditLogEntry;
    /** More audit rows for the same batch (an objection's decision row, AECI-2192). */
    extraAudit?: readonly AuditLogEntry[];
    event: 'vetoed' | 'veto_withdrawn' | 'veto_lifted';
    actingVendorId: string | null;
    byVendorName: string | null;
    /** Extra recipients (a lift tells the vendor whose veto ended). */
    alsoTell?: readonly string[];
    /** The note on a lift. Since AECI-2192 a veto passes `null` here and its fixed
     *  `reasonCode` instead, so no free text reaches the Sync Service. */
    ownerReason: string | null;
    /** AECI-2192: the removal's fixed reason, on a veto. Owners only. */
    reasonCode?: RemovalReasonCode | null;
    /** AECI-2192: why AECi ended the removal, on a lift. Everyone told. */
    endReason?: RemovalEndReason | null;
    now: string;
    /** How the caller stamps its rows: `vendorAuditEntry` on a vendor route. */
    stamp: (entry: AuditLogEntry) => AuditLogEntry;
    /** The 409 a sentinel abort answers. A withdraw and a lift: the veto ended. */
    changedError: () => ApiError;
    origin?: { auditSource: string; purgeSource: 'moderation' };
    hookPrefix: string;
  },
): Promise<void> {
  const { key, target, now } = args;
  const session = c.get('auth');
  const actor = { actorId: session.userId, actorType: auditActorType(session) };
  const keyRows = await rowsOnPairKey(db, key);
  const [audience, named] = await Promise.all([
    vetoAudience(
      db,
      target,
      args.actingVendorId,
      keyRows.map((r) => r.builtByVendorId),
    ),
    pairProducts(db, key),
  ]);
  const pairSlugs = pairSlugsOf(key, named);
  // Whether the pair is public after the batch: no other veto in force on the key after
  // this write, and some row on the key not retired. Read before the batch, so the
  // notice is computed once.
  const othersInForce = await db
    .select({ id: syncServicePairVetoes.id })
    .from(syncServicePairVetoes)
    .where(openVetoOnKeyWhere(key));
  const othersLeft = othersInForce.filter((r) => r.id !== args.vetoId).length;
  const pairPublic =
    args.event === 'vetoed' ? false : othersLeft === 0 && keyRows.some((r) => r.retiredAt === null);

  const recipients = [
    ...audience.owners.map((id) => ({ id, owner: true })),
    ...audience.endpoints.map((id) => ({ id, owner: false })),
    ...(args.alsoTell ?? [])
      .filter((id) => !audience.owners.includes(id) && !audience.endpoints.includes(id))
      .map((id) => ({ id, owner: false })),
  ];
  const notices = recipients.map((r) =>
    pairRightNotificationAudit('portal-sync-service-veto', actor, target.anchor, {
      event: args.event,
      vendorId: r.id,
      integrationId: target.id,
      integrationName: target.name,
      reportKind: null,
      byVendorName: args.byVendorName,
      // The veto's reason is the owner's to read. The other endpoint vendors get the
      // fact, not the text. A lift note goes to everyone it names.
      reason: args.event === 'veto_lifted' || r.owner ? args.ownerReason : null,
      // The fixed reason goes to the Sync Service (the owners) with how to object
      // (ruling 66). The other endpoint vendors get the fact only.
      reasonCode: r.owner ? (args.reasonCode ?? null) : null,
      endReason: args.event === 'veto_lifted' ? (args.endReason ?? null) : null,
      pairPublic,
      pairSlugs,
    }),
  );
  const audit: AuditLogEntry = {
    ...args.audit,
    metadata: {
      ...(args.audit.metadata ?? {}),
      pairPublic,
      anchor: target.anchor,
      integrationId: target.id,
      // Every row on the key whose visibility this write recomputes.
      keyRowIds: keyRows.map((r) => r.id),
    },
  };
  const audits = [audit, ...(args.extraAudit ?? []), ...notices];
  const stmts: BatchStmt[] = [
    ...args.rowWrite,
    ...vetoedAtKeyRecompute(db, key, now),
    ...audits.map((entry) => auditInsert(db, args.stamp(entry))),
    ...vetoCountRecomputes(db, key),
  ];
  try {
    await db.batch(stmts as BatchTuple);
  } catch (error) {
    const race = isVetoRaceError(error);
    if (race === 'duplicate') {
      throw new ApiError(
        409,
        ApiErrorCode.VETO_DUPLICATE,
        'Your company already removed this integration from its product.',
      );
    }
    if (race === 'changed') throw args.changedError();
    throw error;
  }

  // The tail covers every row on the key as it stands after the commit: the by-id
  // Algolia sync of each row, and the `vendor:` tag of each row's owner. The pair,
  // product and connector tags are the key's, so they are the same for every row.
  const after = await rowsOnPairKey(db, key);
  const rowIds = [...new Set([target.id, ...keyRows.map((r) => r.id), ...after.map((r) => r.id)])];
  const ownerIds = [
    ...new Set(
      [
        target.builtByVendorId,
        ...keyRows.map((r) => r.builtByVendorId),
        ...after.map((r) => r.builtByVendorId),
      ].filter((id): id is string => id !== null),
    ),
  ].sort();
  const owners = await ownerSlugs(db, ownerIds);
  const connector = named.get(key.connectorProductId);
  afterRetireCommit(c, db, {
    mode: args.event === 'vetoed' ? 'retire' : 'restore',
    integrationId: target.id,
    alsoIntegrationIds: rowIds,
    productIds: [...new Set([key.productAId, key.productBId, key.connectorProductId])],
    owner: owners[0] ?? null,
    alsoOwners: owners,
    pairSlugs,
    connectorSlug: connector?.slug ?? null,
    audits,
    hookPrefix: args.hookPrefix,
    syncFailureMessage: `aeci.api.${args.hookPrefix}.algolia_sync_failed`,
    ...(args.origin ? { origin: args.origin } : {}),
  });
}
