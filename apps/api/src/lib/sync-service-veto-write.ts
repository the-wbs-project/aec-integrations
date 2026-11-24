/**
 * The shared write of a veto, a withdraw and a lift (AECI-2042,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.2). The vendor routes
 * (`routes/vendor-sync-service-vetoes.ts`) and the admin lift
 * (`routes/admin-sync-service-vetoes.ts`) differ only in the row write and in how they
 * stamp their audit rows: a vendor route passes `vendorAuditEntry`, the admin route
 * stamps the vendor itself.
 *
 * One batch: the row write (the INSERT, or the guarded UPDATE and its `changes()`
 * sentinel), the anchor's `vetoed_at` recomputed from the table, the audit row, one
 * `notification.sent` per owner and other endpoint vendor, and the three
 * `integration_count` recomputes. After commit, the retire's tail.
 */

import { ApiErrorCode, type VetoWriteResponse } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, isNull } from 'drizzle-orm';

import type { Db } from '../db/client';
import { syncServicePairVetoes, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { afterRetireCommit } from '../routes/integration-retire-write';
import type { VendorContext } from '../routes/vendor-shared';
import { auditInsert, type BatchStmt, type BatchTuple } from './audit';
import { auditActorType } from './authz';
import {
  anchorIsPublic,
  isVetoRaceError,
  pairProducts,
  pairRightNotificationAudit,
  pairSlugsOf,
  vetoAnchorOf,
  vetoAudience,
  vetoCountRecomputes,
  vetoedAtRecompute,
  vetoWireRows,
  type PairRightTarget,
} from './sync-service-pair-rights';

/** The veto's wire row after a write, and whether the pair is public now. */
export async function vetoWriteBody(db: Db, vetoId: string): Promise<VetoWriteResponse> {
  const row = await db.query.syncServicePairVetoes.findFirst({
    where: eq(syncServicePairVetoes.id, vetoId),
  });
  if (!row) throw notFoundError('veto', { id: vetoId });
  const [veto] = await vetoWireRows(db, [row]);
  const anchor = vetoAnchorOf(row);
  return {
    veto: veto!,
    pair_public: await anchorIsPublic(db, anchor?.anchor ?? null, anchor?.id ?? null),
  };
}

/** The owner's slug for the purge tag, or `null`. */
async function ownerSlug(
  db: Db,
  ownerId: string | null,
): Promise<{ id: string; slug: string } | null> {
  if (!ownerId) return null;
  const row = await db.query.vendors.findFirst({
    columns: { id: true, slug: true },
    where: eq(vendors.id, ownerId),
  });
  return row ?? null;
}

/**
 * The veto, withdraw and lift share everything after the row write: the recompute,
 * the audit and notices, the counts, the batch, and the tail. `rowWrite` is the INSERT
 * or the guarded UPDATE plus its sentinel.
 */
export async function commitVetoChange(
  c: VendorContext,
  db: Db,
  args: {
    target: PairRightTarget;
    vetoId: string;
    rowWrite: BatchStmt[];
    audit: AuditLogEntry;
    event: 'vetoed' | 'veto_withdrawn' | 'veto_lifted';
    actingVendorId: string | null;
    byVendorName: string | null;
    /** Extra recipients (a lift tells the vendor whose veto ended). */
    alsoTell?: readonly string[];
    /** The reason the owner reads on a veto; the note on a lift. */
    ownerReason: string | null;
    now: string;
    /** How the caller stamps its rows: `vendorAuditEntry` on a vendor route. */
    stamp: (entry: AuditLogEntry) => AuditLogEntry;
    origin?: { auditSource: string; purgeSource: 'moderation' };
    hookPrefix: string;
  },
): Promise<void> {
  const { target, now } = args;
  const session = c.get('auth');
  const actor = { actorId: session.userId, actorType: auditActorType(session) };
  const [audience, named] = await Promise.all([
    vetoAudience(db, target, args.actingVendorId),
    pairProducts(db, target),
  ]);
  const pairSlugs = pairSlugsOf(target, named);
  // Whether the pair is public after the batch: no other veto in force after this
  // write, and not retired. Read before the batch, so the notice is computed once.
  const othersInForce = await db
    .select({ id: syncServicePairVetoes.id })
    .from(syncServicePairVetoes)
    .where(
      and(
        target.anchor === 'integration'
          ? eq(syncServicePairVetoes.integrationId, target.id)
          : eq(syncServicePairVetoes.evidencedPairId, target.id),
        isNull(syncServicePairVetoes.endedAt),
      ),
    );
  const othersLeft = othersInForce.filter((r) => r.id !== args.vetoId).length;
  const pairPublic =
    args.event === 'vetoed' ? false : othersLeft === 0 && target.retiredAt === null;

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
    },
  };
  const audits = [audit, ...notices];
  const stmts: BatchStmt[] = [
    ...args.rowWrite,
    vetoedAtRecompute(db, target, now),
    ...audits.map((entry) => auditInsert(db, args.stamp(entry))),
    ...vetoCountRecomputes(db, target),
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
    if (race === 'changed') {
      throw new ApiError(
        409,
        ApiErrorCode.VETO_NOT_IN_FORCE,
        'This veto has already ended. Reload to see where it stands.',
      );
    }
    throw error;
  }

  const owner = await ownerSlug(db, target.builtByVendorId);
  const connector = named.get(target.connectorProductId);
  afterRetireCommit(c, db, {
    mode: args.event === 'vetoed' ? 'retire' : 'restore',
    integrationId: target.id,
    productIds: [...new Set([target.productAId, target.productBId, target.connectorProductId])],
    owner,
    pairSlugs,
    connectorSlug: connector?.slug ?? null,
    audits,
    hookPrefix: args.hookPrefix,
    syncFailureMessage: `aeci.api.${args.hookPrefix}.algolia_sync_failed`,
    ...(args.origin ? { origin: args.origin } : {}),
  });
}
