/**
 * AECi's queue of Sync Service pair reports (AECI-2042, `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §11e, `ADMIN_PANEL_SPEC.md` §5.12). Shown on `/admin/contests` beside the field
 * contests.
 *
 *   GET   /api/admin/pair-contests?status=&protests=  — the queue (default: open reports)
 *   PATCH /api/admin/pair-contests/:id                — accept or decline an AECi-routed report
 *   PATCH /api/admin/pair-contests/:id/protest        — uphold or reject a protest (advice only)
 *
 * `requireAdmin()` → `rateLimit('write')` on the two writes.
 *
 * An existence accept needs a note and a proof link (ruling 9: AECi retires on proof).
 * On a vendor-held row it runs the admin retire batch (`planAdminRetire`) with the note
 * as the reason, and adds the report's decision to the same batch. On an AECi-held row
 * the admin retire is closed (promote owns that row, §4.6.4), so the accept writes no
 * catalog data and the operator retracts the pair in the review app
 * (`docs/runbooks/catalog.md`). A data flow accept on an unclaimed pair writes nothing
 * here either: the review app holds those flows.
 */

import {
  AdminDecidePairContestSchema,
  AdminDecidePairProtestSchema,
  AdminPairContestsResponseSchema,
  ApiErrorCode,
  ListAdminPairContestsQuerySchema,
  PairContestResponseSchema,
  type AdminPairContestsResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, desc, eq } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import { syncServicePairContests } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { isVendorHeld } from '../lib/integration-claims';
import { isRetireRaceError } from '../lib/integration-retire';
import { locateRetireTarget, retireTargetOf } from '../lib/retire-target';
import {
  isPairContestRaceError,
  pairContestChangedSentinel,
  PAIR_CONTEST_ENTITY_TYPE,
  pairContestWireRows,
  type PairContestRow,
} from '../lib/sync-service-pair-contests';
import { pairRightNotificationAudit } from '../lib/sync-service-pair-rights';
import { afterAdminRetire, planAdminRetire } from './admin-integration-retire';
import { contestBody } from './vendor-pair-contests';
import { afterVendorWrite, parseJsonBody, type VendorContext } from './vendor-shared';

export const ADMIN_PAIR_CONTEST_SOURCE = 'admin-moderation';
const ADMIN_ORIGIN = { auditSource: ADMIN_PAIR_CONTEST_SOURCE, purgeSource: 'moderation' } as const;

/** `GET /api/admin/pair-contests`. Oldest open first, so the queue reads in filing order. */
export function createAdminListPairContestsHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const query = ListAdminPairContestsQuerySchema.parse(c.req.query());
    const { db } = dbFor(c.env);
    const t = syncServicePairContests;
    // Timestamp then id: both BINARY orderings.
    const rows = await db
      .select()
      .from(t)
      .where(query.protests ? eq(t.protestStatus, 'open') : eq(t.status, query.status))
      .orderBy(query.status === 'open' && !query.protests ? t.createdAt : desc(t.updatedAt), t.id)
      .limit(200);
    const body: AdminPairContestsResponse = { data: await pairContestWireRows(db, rows) };
    validateResponseInDev(c.env, () => AdminPairContestsResponseSchema.parse(body));
    return json(body);
  };
}

async function loadRow(db: Db, id: string): Promise<PairContestRow> {
  const row = await db.query.syncServicePairContests.findFirst({
    where: eq(syncServicePairContests.id, id),
  });
  if (!row) throw notFoundError('pair_contest', { id });
  return row;
}

function notOpenError(): ApiError {
  return new ApiError(409, ApiErrorCode.PAIR_CONTEST_NOT_OPEN, 'Already decided or withdrawn.');
}

/** The submitter's notice of AECi's decision. */
function decisionNotice(
  c: VendorContext,
  row: PairContestRow,
  wire: Awaited<ReturnType<typeof pairContestWireRows>>[number] | undefined,
  event: 'report_accepted' | 'report_declined' | 'protest_decided',
  vendorId: string,
  reason: string | null,
): AuditLogEntry {
  const session = c.get('auth');
  const a = wire?.pair.product_a?.slug;
  const b = wire?.pair.product_b?.slug;
  return pairRightNotificationAudit(
    'portal-sync-service-pair-report',
    { actorId: session.userId, actorType: auditActorType(session) },
    row.integrationId ? 'integration' : 'evidenced_pair',
    {
      event,
      vendorId,
      integrationId: row.integrationId ?? row.evidencedPairId!,
      integrationName: wire?.pair.name ?? null,
      reportKind: row.kind as 'existence' | 'data_flow',
      byVendorName: null,
      reason,
      pairPublic: null,
      pairSlugs: a && b ? [a, b] : null,
    },
  );
}

/** `PATCH /api/admin/pair-contests/:id`. */
export function createAdminDecidePairContestHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const id = c.req.param('id');
    if (!id) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing id', { field: 'id' });
    const payload = await parseJsonBody(c, AdminDecidePairContestSchema);
    const { db } = writeDb(c, dbFor);
    const row = await loadRow(db, id);
    if (row.routedTo !== 'aeci') {
      throw new ApiError(
        409,
        ApiErrorCode.CONTEST_ROUTED_TO_OWNER,
        'The owner decides this report. AEC Integrations does not.',
      );
    }
    if (row.status !== 'open') throw notOpenError();
    const accepted = payload.decision === 'accept';
    const note = payload.note?.trim() || null;
    if (accepted && !note) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'A note is required to accept a report.', {
        field: 'note',
      });
    }
    if (accepted && row.kind === 'existence' && !payload.source_url) {
      throw new ApiError(
        400,
        'VALIDATION_FAILED',
        'A link to the proof is required to accept an existence report.',
        { field: 'sourceUrl' },
      );
    }

    const now = new Date().toISOString();
    const anchorId = row.integrationId ?? row.evidencedPairId!;
    const located =
      accepted && row.kind === 'existence' ? await locateRetireTarget(db, anchorId) : null;
    const target = located ? retireTargetOf(located) : null;
    const mode: string | null = !accepted
      ? null
      : row.kind === 'data_flow'
        ? 'upstream-only'
        : !target
          ? 'upstream-only'
          : target.retiredAt !== null
            ? 'already-retired'
            : isVendorHeld(target)
              ? 'retired'
              : 'upstream-only';

    const [wire] = await pairContestWireRows(db, [row]);
    const audits: AuditLogEntry[] = [
      {
        actorId: session.userId,
        actorType: auditActorType(session),
        action: accepted
          ? 'integration.pair_contest.accepted'
          : 'integration.pair_contest.declined',
        entityType: PAIR_CONTEST_ENTITY_TYPE,
        entityId: row.id,
        // AECI-1192: the row is about the vendor that filed the report.
        vendorId: row.submitterVendorId,
        beforeState: { status: 'open' },
        afterState: { status: accepted ? 'accepted' : 'declined', accept_mode: mode },
        metadata: {
          source: ADMIN_PAIR_CONTEST_SOURCE,
          ...(note ? { reason: note, reasonVisibility: 'vendor' } : {}),
          ...(payload.source_url ? { sourceUrl: payload.source_url } : {}),
          ...(mode ? { appliedMode: mode } : {}),
        },
      },
      decisionNotice(
        c,
        row,
        wire,
        accepted ? 'report_accepted' : 'report_declined',
        row.submitterVendorId,
        note,
      ),
    ];
    const decide: BatchStmt[] = [
      db
        .update(syncServicePairContests)
        .set({
          status: accepted ? 'accepted' : 'declined',
          decisionNote: note,
          decidedBy: session.userId,
          decidedAt: now,
          acceptMode: mode,
          updatedAt: now,
        })
        .where(
          and(
            eq(syncServicePairContests.id, row.id),
            eq(syncServicePairContests.status, 'open'),
            eq(syncServicePairContests.routedTo, 'aeci'),
          ),
        ),
      pairContestChangedSentinel(db),
      ...audits.map((entry) => auditInsert(db, entry)),
    ];

    if (mode === 'retired' && located) {
      // Ruling 9: retire on proof, through the admin retire, in one batch.
      const plan = await planAdminRetire(c, db, located, 'retire', {
        reason: note!,
        internalNote: `Existence report ${row.id} accepted. Proof: ${payload.source_url}`,
      });
      try {
        await db.batch([...decide, ...plan.batch.stmts] as BatchTuple);
      } catch (error) {
        if (isPairContestRaceError(error) || isRetireRaceError(error)) {
          const current = await loadRow(db, row.id);
          throw current.status !== 'open'
            ? notOpenError()
            : new ApiError(
                409,
                ApiErrorCode.PAIR_CONTEST_CHANGED,
                'The integration changed while you were deciding. Reload and try again.',
              );
        }
        throw error;
      }
      afterAdminRetire(c, db, plan, anchorId, 'retire', audits);
    } else {
      try {
        await db.batch(decide as BatchTuple);
      } catch (error) {
        if (!isPairContestRaceError(error)) throw error;
        throw notOpenError();
      }
      afterVendorWrite(c, [], audits, undefined, db, ADMIN_ORIGIN);
    }
    const body = await contestBody(db, row.id);
    validateResponseInDev(c.env, () => PairContestResponseSchema.parse(body));
    return json(body);
  };
}

/**
 * `PATCH /api/admin/pair-contests/:id/protest`. Advice only (§11b.12.1, ruling 10): it
 * tells both vendors which side AECi agrees with, and writes nothing to the listing.
 */
export function createAdminDecidePairProtestHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const id = c.req.param('id');
    if (!id) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing id', { field: 'id' });
    const payload = await parseJsonBody(c, AdminDecidePairProtestSchema);
    const { db } = writeDb(c, dbFor);
    const row = await loadRow(db, id);
    if (row.protestStatus !== 'open') {
      throw new ApiError(409, ApiErrorCode.PAIR_PROTEST_NOT_OPEN, 'This review is no longer open.');
    }
    const now = new Date().toISOString();
    const [wire] = await pairContestWireRows(db, [row]);
    const upheld = payload.decision === 'upheld';
    const audits: AuditLogEntry[] = [
      {
        actorId: session.userId,
        actorType: auditActorType(session),
        action: upheld
          ? 'integration.pair_contest.protest_upheld'
          : 'integration.pair_contest.protest_rejected',
        entityType: PAIR_CONTEST_ENTITY_TYPE,
        entityId: row.id,
        vendorId: row.submitterVendorId,
        beforeState: { protest_status: 'open' },
        afterState: { protest_status: payload.decision },
        metadata: {
          source: ADMIN_PAIR_CONTEST_SOURCE,
          reason: payload.note,
          reasonVisibility: 'vendor',
          advisory: true,
        },
      },
      decisionNotice(c, row, wire, 'protest_decided', row.submitterVendorId, payload.note),
      ...(row.ownerVendorId
        ? [decisionNotice(c, row, wire, 'protest_decided', row.ownerVendorId, payload.note)]
        : []),
    ];
    try {
      await db.batch([
        db
          .update(syncServicePairContests)
          .set({
            protestStatus: payload.decision,
            protestDecisionNote: payload.note,
            protestDecidedBy: session.userId,
            protestDecidedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(syncServicePairContests.id, row.id),
              eq(syncServicePairContests.protestStatus, 'open'),
            ),
          ),
        pairContestChangedSentinel(db),
        ...audits.map((entry) => auditInsert(db, entry)),
      ] as BatchTuple);
    } catch (error) {
      if (!isPairContestRaceError(error)) throw error;
      throw new ApiError(409, ApiErrorCode.PAIR_PROTEST_NOT_OPEN, 'This review is no longer open.');
    }
    // Advice: no purge, no catalog write, no search sync.
    afterVendorWrite(c, [], audits, undefined, db, ADMIN_ORIGIN);
    const body = await contestBody(db, row.id);
    validateResponseInDev(c.env, () => PairContestResponseSchema.parse(body));
    return json(body);
  };
}
