/**
 * An endpoint vendor's reports on a Sync Service pair, and the owner's decision
 * (AECI-2042, rulings 9 and 10 on AECI-2035, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e,
 * `API_CONTRACTS.md` §6.15b). The rules are in `lib/sync-service-pair-contests.ts`.
 *
 *   POST /api/vendor/integrations/:id/pair-contests   — file an existence or data flow report (201)
 *   GET  /api/vendor/pair-contests                     — submitted, and received by the owner
 *   POST /api/vendor/pair-contests/:id/withdraw        — the submitter withdraws (200)
 *   POST /api/vendor/pair-contests/:id/decision        — the owner accepts or declines a data flow report (200)
 *   POST /api/vendor/pair-contests/:id/protest         — the submitter asks AECi to review a decline (200)
 *   POST /api/vendor/pair-contests/:id/protest/withdraw — the submitter withdraws its protest (200)
 *   POST /api/vendor/pair-contests/:id/protest/reply    — the owner replies once (200, AECI-2110)
 *
 * Every write: `requireVendor()` → `rateLimit('write')`, then the handler. A seat is the
 * whole gate. A report on another vendor's row, or a decision on a report not routed to
 * the caller, is the same `404` as an unknown id. Every transition is one batch: the
 * guarded row write and its sentinel, the audit row, the `notification.sent` row for
 * the other side, and since AECI-2110 the report's `correction_request` workflow
 * instance and transition (§11e.5). The AECi alert email goes out after commit on an
 * AECi-routed submit, and the owner's seats get `pair-report-submitted-owner` on an
 * owner-routed one (AECI-2229).
 */

import {
  ApiErrorCode,
  DecidePairContestSchema,
  FilePairProtestSchema,
  PAIR_PROTEST_REPLY_DAYS,
  PairContestResponseSchema,
  ReplyPairProtestSchema,
  SubmitPairContestSchema,
  VendorPairContestsResponseSchema,
  pairProtestWindow,
  type PairContestResponse,
  type VendorPairContestsResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import {
  claims,
  syncServicePairContests,
  taxonomyDataObjects,
  vendors,
  workflowInstances,
} from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import {
  auditInsert,
  workflowTransitionInsert,
  type BatchStmt,
  type BatchTuple,
} from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { sendPairContestSubmittedNotification } from '../lib/email';
import {
  emailPairProtestFiled,
  emailPairReportSubmittedToOwner,
} from '../lib/contest-protest-emails';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { integrationRetiredError, integrationVetoedError } from '../lib/live-integration';
import { ownerFlowContextOf, ownerMaintainsFlows, resolveOwnerFlowClaim } from '../lib/owner-flows';
import {
  isPairContestRaceError,
  noOtherOpenPairReportSentinel,
  openDuplicate,
  pairProtestSubmitRefusal,
  pairWorkflowStepStmts,
  PAIR_CONTEST_WORKFLOW_TYPE,
  storedPairEvidence,
  pairContestChangedSentinel,
  pairContestDuplicateSentinel,
  PAIR_CONTEST_ENTITY_TYPE,
  pairContestWireRows,
  fromPairFrame,
  toPairFrame,
  type PairContestRow,
} from '../lib/sync-service-pair-contests';
import {
  pairProducts,
  pairRightNotificationAudit,
  pairRightTargetSentinel,
  pairSlugsOf,
  resolvePairRightTarget,
  type PairRightTarget,
} from '../lib/sync-service-pair-rights';
import { commitOwnerFlowWrite, planOwnerFlowChange } from './vendor-owner-flows';
import {
  AUDIT_SOURCE,
  afterVendorWrite,
  parseJsonBody,
  sessionVendorId,
  vendorAuditEntry,
  type VendorContext,
} from './vendor-shared';

const LIST_CAP = 100;

function param(c: VendorContext): string {
  const value = c.req.param('id');
  if (!value) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing id', { field: 'id' });
  return value;
}

export async function contestBody(
  db: Db,
  id: string,
  side: 'submitted' | 'received' = 'submitted',
): Promise<PairContestResponse> {
  const row = await db.query.syncServicePairContests.findFirst({
    where: eq(syncServicePairContests.id, id),
  });
  if (!row) throw notFoundError('pair_contest', { id });
  const [contest] = await pairContestWireRows(db, [row], new Date(), { side });
  return { contest: contest! };
}

function notOpenError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.PAIR_CONTEST_NOT_OPEN,
    'This report was already decided or withdrawn. Reload to see where it stands.',
  );
}

/** The anchor columns of a report on this target. */
function anchorColumns(target: Pick<PairRightTarget, 'anchor' | 'id'>) {
  return {
    integrationId: target.anchor === 'integration' ? target.id : null,
    evidencedPairId: target.anchor === 'evidenced_pair' ? target.id : null,
  };
}

/** Does this row's owner maintain its flows now (claimed, Sync Service, owner on file)? */
async function ownerDecidesFlows(db: Db, target: PairRightTarget): Promise<boolean> {
  const connector = await db.query.products.findFirst({
    columns: { productRole: true, connectorKind: true },
    where: (p, { eq: is }) => is(p.id, target.connectorProductId),
  });
  return ownerMaintainsFlows(ownerFlowContextOf(target, connector));
}

/** The owner email seam (AECI-2229), injectable so a spec can capture the call. */
export type NotifyPairReportOwner = (
  c: VendorContext,
  db: Db,
  row: PairContestRow,
) => Promise<void>;

/** `POST /api/vendor/integrations/:id/pair-contests`. */
export function createSubmitPairContestHandler(
  dbFor: DbFactory = getDb,
  notifyOwner: NotifyPairReportOwner = emailPairReportSubmittedToOwner,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);
    const { target } = await resolvePairRightTarget(db, vendorId, param(c));
    const payload = await parseJsonBody(c, SubmitPairContestSchema);
    // A report asks about a pair on the site. A vetoed or retired pair is not on it.
    if (target.vetoedAt !== null) throw integrationVetoedError();
    if (target.retiredAt !== null) throw integrationRetiredError();

    let claimId: string | null = null;
    let currentDirection: string | null = null;
    let proposedDirection: string | null = null;
    let flowName: string | null = null;
    if (payload.kind === 'data_flow') {
      const [claim] = await db
        .select({
          id: claims.id,
          integrationId: claims.integrationId,
          pairId: claims.connectorEvidencedPairId,
          direction: claims.direction,
          name: taxonomyDataObjects.name,
        })
        .from(claims)
        .innerJoin(taxonomyDataObjects, eq(taxonomyDataObjects.id, claims.dataObjectId))
        .where(eq(claims.id, payload.claim_id))
        .limit(1);
      const onRow =
        claim &&
        (target.anchor === 'integration' ? claim.integrationId : claim.pairId) === target.id;
      if (!onRow) {
        throw new ApiError(400, 'VALIDATION_FAILED', 'That data flow is not on this integration.', {
          field: 'claim_id',
        });
      }
      claimId = claim.id;
      flowName = claim.name;
      currentDirection = toPairFrame(claim.direction, target.sourceIsA);
      proposedDirection = payload.proposed_direction ?? null;
      if (proposedDirection !== null && proposedDirection === currentDirection) {
        throw new ApiError(
          422,
          ApiErrorCode.CONTEST_NO_CHANGE,
          'That is the direction on record. Choose another, or say the flow should not be listed.',
          { field: 'proposed_direction' },
        );
      }
    }

    const routedTo =
      payload.kind === 'data_flow' && (await ownerDecidesFlows(db, target)) ? 'owner' : 'aeci';
    const row: PairContestRow = {
      id: crypto.randomUUID(),
      kind: payload.kind,
      ...anchorColumns(target),
      claimId,
      currentDirection,
      proposedDirection,
      reason: payload.reason,
      submitterVendorId: vendorId,
      submittedBy: session.userId,
      routedTo,
      ownerVendorId: routedTo === 'owner' ? target.builtByVendorId : null,
      status: 'open',
      decisionNote: null,
      decidedBy: null,
      decidedAt: null,
      acceptMode: null,
      protestStatus: null,
      protestBasis: null,
      protestReason: null,
      protestedBy: null,
      protestedAt: null,
      protestDecisionNote: null,
      protestDecidedBy: null,
      protestDecidedAt: null,
      protestEvidence: null,
      protestReplyDueAt: null,
      protestReply: null,
      protestReplyEvidence: null,
      protestRepliedBy: null,
      protestRepliedAt: null,
      workflowId: crypto.randomUUID(),
      protestWorkflowId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    if (await openDuplicate(db, row)) {
      throw new ApiError(
        409,
        ApiErrorCode.PAIR_CONTEST_DUPLICATE,
        'Your company already has this report open on this integration.',
      );
    }
    // §11b.12.8 applied to a data flow report (AECI-2110): one live dispute per flow
    // per vendor, and the 90-day bar after AECi agreed with the owner, unless the flow's
    // direction changed since.
    if (claimId !== null && currentDirection !== null) {
      const refusal = await pairProtestSubmitRefusal(
        db,
        { submitterVendorId: vendorId, claimId, liveDirection: currentDirection },
        new Date(),
      );
      if (refusal?.code === 'CONTEST_PROTEST_OPEN') {
        throw new ApiError(
          409,
          ApiErrorCode.CONTEST_PROTEST_OPEN,
          'You already asked AEC Integrations to review a report on this data flow. Wait for its answer, or withdraw that request first.',
          { details: { contest_id: refusal.contestId } },
        );
      }
      if (refusal?.code === 'CONTEST_COOLDOWN') {
        throw new ApiError(
          409,
          ApiErrorCode.CONTEST_COOLDOWN,
          'AEC Integrations agreed with the owner on this data flow, so it cannot be reported again yet unless its direction changes.',
          { details: { until: refusal.until } },
        );
      }
    }

    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const named = await pairProducts(db, target);
    const pairSlugs = pairSlugsOf(target, named);
    const submitterName =
      (
        await db.query.vendors.findFirst({
          columns: { companyName: true },
          where: eq(vendors.id, vendorId),
        })
      )?.companyName ?? null;
    const audits: AuditLogEntry[] = [
      {
        ...actor,
        action: 'integration.pair_contest.submitted',
        entityType: PAIR_CONTEST_ENTITY_TYPE,
        entityId: row.id,
        afterState: {
          kind: row.kind,
          claim_id: claimId,
          current_direction: currentDirection,
          proposed_direction: proposedDirection,
          routed_to: routedTo,
        },
        metadata: {
          source: AUDIT_SOURCE,
          vendorId,
          integrationId: target.id,
          anchor: target.anchor,
        },
      },
      ...(routedTo === 'owner' && row.ownerVendorId
        ? [
            pairRightNotificationAudit('portal-sync-service-pair-report', actor, target.anchor, {
              event: 'report_submitted',
              vendorId: row.ownerVendorId,
              integrationId: target.id,
              integrationName: target.name,
              reportKind: row.kind as 'existence' | 'data_flow',
              byVendorName: submitterName,
              reason: null,
              pairPublic: null,
              pairSlugs,
            }),
          ]
        : []),
    ];
    const stmts: BatchStmt[] = [
      // The gate again, at commit (AECI-2042 review): the row still has this connector
      // and these endpoints, the connector is still a Sync Service, the caller still
      // holds an endpoint and is not the owner, the owner and claim the routing read
      // are unchanged, and the row is still live. Otherwise nothing is written.
      pairRightTargetSentinel(db, target, vendorId, { ownerUnchanged: true, live: true }),
      // The instance first: the report's `workflow_id` FK points at it (AECI-2110).
      db.insert(workflowInstances).values({
        id: row.workflowId!,
        workflowType: PAIR_CONTEST_WORKFLOW_TYPE,
        entityId: row.id,
        currentState: 'open',
        initiatedBy: session.userId,
        initiatedAt: row.createdAt,
      }),
      db.insert(syncServicePairContests).values(row),
      pairContestDuplicateSentinel(db, row),
      workflowTransitionInsert(db, {
        workflowId: row.workflowId!,
        fromState: null,
        toState: 'open',
        actorId: session.userId,
        reason: 'report submitted',
        metadata: { kind: row.kind, routedTo },
      }),
      ...audits.map((entry) => auditInsert(db, vendorAuditEntry(c, entry))),
    ];
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (!isPairContestRaceError(error)) throw error;
      // Both sentinels raise the same error. Nothing was written, so a duplicate open
      // now is the other submit that won; otherwise the gate tripped.
      if (await openDuplicate(db, row)) {
        throw new ApiError(
          409,
          ApiErrorCode.PAIR_CONTEST_DUPLICATE,
          'Your company already has this report open on this integration.',
        );
      }
      throw new ApiError(
        409,
        ApiErrorCode.PAIR_CONTEST_CHANGED,
        'This integration, or your company’s link to it, changed while you were sending. Nothing was sent. Reload and try again.',
      );
    }
    // Nothing public changes on a submit, so nothing is purged.
    afterVendorWrite(c, [], audits, undefined, db);
    if (routedTo === 'aeci') {
      c.executionCtx.waitUntil(
        sendPairContestSubmittedNotification(c, {
          contestId: row.id,
          kind: row.kind as 'existence' | 'data_flow',
          integrationName: target.name ?? 'this integration',
          flowName,
          reason: row.reason,
          submitterVendorName: submitterName ?? 'A vendor',
          pairSlugs,
        }).then(
          () => undefined,
          () => undefined,
        ),
      );
    }
    // AECI-2229 (§11e.7): an owner-routed report starts the owner's 30-day answer
    // window, so its seats get an email beside the portal row. After the commit, so a
    // lost race sends nothing.
    if (routedTo === 'owner' && row.ownerVendorId) {
      c.executionCtx.waitUntil(notifyOwner(c, db, row));
    }
    const body = await contestBody(db, row.id);
    validateResponseInDev(c.env, () => PairContestResponseSchema.parse(body));
    return json(body, { status: 201 });
  };
}

/** `GET /api/vendor/pair-contests`. Not rate-limited. */
export function createListVendorPairContestsHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const { db } = dbFor(c.env);
    const t = syncServicePairContests;
    // Newest change first, id as tie-breaker: timestamp and id orderings stay BINARY.
    const [submitted, received] = await Promise.all([
      db
        .select()
        .from(t)
        .where(eq(t.submitterVendorId, vendorId))
        .orderBy(desc(t.updatedAt), desc(t.id))
        .limit(LIST_CAP),
      db
        .select()
        .from(t)
        .where(and(eq(t.routedTo, 'owner'), eq(t.ownerVendorId, vendorId)))
        .orderBy(desc(t.updatedAt), desc(t.id))
        .limit(LIST_CAP),
    ]);
    const body: VendorPairContestsResponse = {
      submitted: await pairContestWireRows(db, submitted, new Date(), { side: 'submitted' }),
      received: await pairContestWireRows(db, received, new Date(), { side: 'received' }),
    };
    validateResponseInDev(c.env, () => VendorPairContestsResponseSchema.parse(body));
    return json(body);
  };
}

/** The report row, or the 404 an unknown id gets. */
async function loadRow(db: Db, id: string): Promise<PairContestRow> {
  const row = await db.query.syncServicePairContests.findFirst({
    where: eq(syncServicePairContests.id, id),
  });
  if (!row) throw notFoundError('pair_contest', { id });
  return row;
}

/** Run a one-row transition: the guarded UPDATE, its sentinel, the audit rows. */
async function runTransition(
  c: VendorContext,
  db: Db,
  stmts: BatchStmt[],
  audits: AuditLogEntry[],
  onRace: () => ApiError | Promise<ApiError>,
): Promise<void> {
  try {
    await db.batch([
      ...stmts,
      ...audits.map((entry) => auditInsert(db, vendorAuditEntry(c, entry))),
    ] as BatchTuple);
  } catch (error) {
    if (!isPairContestRaceError(error)) throw error;
    throw await onRace();
  }
  afterVendorWrite(c, [], audits, undefined, db);
}

/** The pair's name and slugs for a notice. */
async function rowFacts(
  db: Db,
  row: PairContestRow,
): Promise<{ name: string | null; pairSlugs: readonly [string, string] | null }> {
  const [wire] = await pairContestWireRows(db, [row]);
  const a = wire?.pair.product_a?.slug;
  const b = wire?.pair.product_b?.slug;
  return { name: wire?.pair.name ?? null, pairSlugs: a && b ? [a, b] : null };
}

/** `POST /api/vendor/pair-contests/:id/withdraw`. The submitter only. */
export function createWithdrawPairContestHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);
    const row = await loadRow(db, param(c));
    if (row.submitterVendorId !== vendorId) throw notFoundError('pair_contest', { id: row.id });
    if (row.status !== 'open') throw notOpenError();
    const now = new Date().toISOString();
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const facts = await rowFacts(db, row);
    const anchor = row.integrationId ? 'integration' : 'evidenced_pair';
    const audits: AuditLogEntry[] = [
      {
        ...actor,
        action: 'integration.pair_contest.withdrawn',
        entityType: PAIR_CONTEST_ENTITY_TYPE,
        entityId: row.id,
        beforeState: { status: 'open' },
        afterState: { status: 'withdrawn' },
        metadata: { source: AUDIT_SOURCE, vendorId },
      },
      ...(row.routedTo === 'owner' && row.ownerVendorId
        ? [
            pairRightNotificationAudit('portal-sync-service-pair-report', actor, anchor, {
              event: 'report_withdrawn',
              vendorId: row.ownerVendorId,
              integrationId: row.integrationId ?? row.evidencedPairId!,
              integrationName: facts.name,
              reportKind: row.kind as 'existence' | 'data_flow',
              byVendorName: null,
              reason: null,
              pairPublic: null,
              pairSlugs: facts.pairSlugs,
            }),
          ]
        : []),
    ];
    await runTransition(
      c,
      db,
      [
        db
          .update(syncServicePairContests)
          .set({ status: 'withdrawn', updatedAt: now })
          .where(
            and(
              eq(syncServicePairContests.id, row.id),
              eq(syncServicePairContests.status, 'open'),
              eq(syncServicePairContests.submitterVendorId, vendorId),
            ),
          ),
        pairContestChangedSentinel(db),
        ...pairWorkflowStepStmts(
          db,
          row,
          { which: 'report', toState: 'withdrawn' },
          { actorId: session.userId, reason: 'withdrawn by the submitter' },
          now,
        ),
      ],
      audits,
      notOpenError,
    );
    const body = await contestBody(db, row.id);
    validateResponseInDev(c.env, () => PairContestResponseSchema.parse(body));
    return json(body);
  };
}

/**
 * `POST /api/vendor/pair-contests/:id/decision`. The owner of a claimed Sync Service
 * pair, on a data flow report routed to it. An accept writes the owner's answer in the
 * same batch, through the owner's own flow logic (`planOwnerFlowChange`): No on the
 * flow, or the flow moved to the proposed direction. A decline writes nothing else.
 */
export function createDecidePairContestHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);
    const row = await loadRow(db, param(c));
    if (row.routedTo !== 'owner' || row.ownerVendorId !== vendorId || row.kind !== 'data_flow') {
      throw notFoundError('pair_contest', { id: row.id });
    }
    const payload = await parseJsonBody(c, DecidePairContestSchema);
    if (row.status !== 'open') throw notOpenError();
    const now = new Date().toISOString();
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const accepted = payload.decision === 'accept';
    const facts = await rowFacts(db, row);
    const anchor = row.integrationId ? 'integration' : 'evidenced_pair';
    const update = db
      .update(syncServicePairContests)
      .set({
        status: accepted ? 'accepted' : 'declined',
        decisionNote: payload.note ?? null,
        decidedBy: session.userId,
        decidedAt: now,
        acceptMode: accepted ? (row.proposedDirection ? 'flow-redirected' : 'flow-removed') : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(syncServicePairContests.id, row.id),
          eq(syncServicePairContests.status, 'open'),
          eq(syncServicePairContests.routedTo, 'owner'),
          eq(syncServicePairContests.ownerVendorId, vendorId),
        ),
      );
    const audits: AuditLogEntry[] = [
      {
        ...actor,
        action: accepted
          ? 'integration.pair_contest.accepted'
          : 'integration.pair_contest.declined',
        entityType: PAIR_CONTEST_ENTITY_TYPE,
        entityId: row.id,
        beforeState: { status: 'open' },
        afterState: { status: accepted ? 'accepted' : 'declined' },
        metadata: {
          source: AUDIT_SOURCE,
          vendorId,
          ...(payload.note ? { reason: payload.note, reasonVisibility: 'vendor' } : {}),
          ...(accepted
            ? { appliedMode: row.proposedDirection ? 'flow-redirected' : 'flow-removed' }
            : {}),
        },
      },
      pairRightNotificationAudit('portal-sync-service-pair-report', actor, anchor, {
        event: accepted ? 'report_accepted' : 'report_declined',
        vendorId: row.submitterVendorId,
        integrationId: row.integrationId ?? row.evidencedPairId!,
        integrationName: facts.name,
        reportKind: 'data_flow',
        byVendorName: null,
        reason: payload.note ?? null,
        pairPublic: null,
        pairSlugs: facts.pairSlugs,
      }),
    ];

    const workflow = pairWorkflowStepStmts(
      db,
      row,
      { which: 'report', toState: accepted ? 'accepted' : 'declined' },
      { actorId: session.userId, reason: `${accepted ? 'accepted' : 'declined'} by the owner` },
      now,
    );
    if (!accepted) {
      await runTransition(
        c,
        db,
        [update, pairContestChangedSentinel(db), ...workflow],
        audits,
        notOpenError,
      );
    } else {
      // The owner gate, again, now: owner, Sync Service, claimed, live. A row returned
      // to AECi or reclassified answers the gate's own error and writes nothing.
      const claim = await resolveOwnerFlowClaim(db, vendorId, row.claimId!);
      const sourceIsA = claim.target.productAId < claim.target.productBId;
      const direction = row.proposedDirection
        ? fromPairFrame(row.proposedDirection as 'a_to_b' | 'b_to_a' | 'both', sourceIsA)
        : null;
      const plan = await planOwnerFlowChange(db, claim, direction);
      await commitOwnerFlowWrite(c, db, claim.target, plan.changes, plan.extras, {
        prefix: [update, pairContestChangedSentinel(db), ...workflow],
        audits,
        onRace: async () => {
          const now2 = await loadRow(db, row.id);
          return now2.status !== 'open'
            ? notOpenError()
            : new ApiError(
                409,
                ApiErrorCode.PAIR_CONTEST_CHANGED,
                'The integration changed while you were deciding. Reload and try again.',
              );
        },
      });
    }
    const body = await contestBody(db, row.id, 'received');
    validateResponseInDev(c.env, () => PairContestResponseSchema.parse(body));
    return json(body);
  };
}

/**
 * `POST /api/vendor/pair-contests/:id/protest`. The submitter of an owner-routed data
 * flow report, inside the §11b.12.2 window: 30 days from a decline, or days 30 to 60 of
 * silence. A silence protest records the decline at day 30 in the same batch, as
 * §11b.12.3 does. Since AECI-2110 the body carries the vendor's own reason and up to
 * three links, the owner may reply once within 14 days (`protest_reply_due_at`, stored),
 * and the protest has its own workflow instance. Advice only: AECi's answer never writes
 * the listing.
 */
export function createFilePairProtestHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);
    const row = await loadRow(db, param(c));
    if (row.submitterVendorId !== vendorId) throw notFoundError('pair_contest', { id: row.id });
    const window = pairProtestWindow(row, new Date());
    if (!window) {
      throw new ApiError(
        409,
        ApiErrorCode.PAIR_PROTEST_NOT_ALLOWED,
        'This report cannot be sent to AEC Integrations for review now.',
      );
    }
    // One live dispute per flow per vendor, from the protest side (§11b.12.15 ruling 8).
    if (await otherOpenReportOnFlow(db, row)) throw otherReportOpenError();
    const payload = await parseJsonBody(c, FilePairProtestSchema);
    const reason = payload.reason;
    const evidence = storedPairEvidence(payload.evidence_urls ?? []);
    const now = new Date().toISOString();
    const replyDueAt = new Date(Date.parse(now) + PAIR_PROTEST_REPLY_DAYS * DAY_MS).toISOString();
    const silenceDecidedAt = new Date(Date.parse(row.createdAt) + 30 * DAY_MS).toISOString();
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const facts = await rowFacts(db, row);
    const anchor = row.integrationId ? 'integration' : 'evidenced_pair';
    const protestWorkflowId = crypto.randomUUID();
    const update = db
      .update(syncServicePairContests)
      .set({
        protestStatus: 'open',
        protestBasis: window.basis,
        protestReason: reason,
        protestEvidence: evidence,
        protestedBy: session.userId,
        protestedAt: now,
        protestReplyDueAt: replyDueAt,
        protestWorkflowId,
        ...(window.basis === 'silence' ? { status: 'declined', decidedAt: silenceDecidedAt } : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(syncServicePairContests.id, row.id),
          eq(syncServicePairContests.status, window.basis === 'silence' ? 'open' : 'declined'),
          // A protest exists at most once per report.
          isNull(syncServicePairContests.protestStatus),
        ),
      );
    const audits: AuditLogEntry[] = [
      // Silence only: the report's own close is recorded as its own action, so the log
      // never shows the submitter's seat as the one that declined (§11b.12.7).
      ...(window.basis === 'silence'
        ? [
            {
              ...actor,
              action: 'integration.pair_contest.lapsed',
              entityType: PAIR_CONTEST_ENTITY_TYPE,
              entityId: row.id,
              beforeState: { status: 'open' },
              afterState: { status: 'declined', decided_at: silenceDecidedAt },
              metadata: { source: AUDIT_SOURCE, vendorId, reason: 'owner silent 30 days' },
            },
          ]
        : []),
      {
        ...actor,
        action: 'integration.pair_contest.protested',
        entityType: PAIR_CONTEST_ENTITY_TYPE,
        entityId: row.id,
        afterState: {
          protest_status: 'open',
          protest_basis: window.basis,
          protest_reply_due_at: replyDueAt,
        },
        metadata: { source: AUDIT_SOURCE, vendorId },
      },
      ...(row.ownerVendorId
        ? [
            pairRightNotificationAudit('portal-sync-service-pair-report', actor, anchor, {
              event: 'protest_filed',
              vendorId: row.ownerVendorId,
              integrationId: row.integrationId ?? row.evidencedPairId!,
              integrationName: facts.name,
              reportKind: 'data_flow',
              byVendorName: null,
              reason: null,
              pairPublic: null,
              pairSlugs: facts.pairSlugs,
              replyDueAt,
            }),
          ]
        : []),
    ];
    await runTransition(
      c,
      db,
      [
        // The instance first: the new `protest_workflow_id` FK points at it.
        db.insert(workflowInstances).values({
          id: protestWorkflowId,
          workflowType: PAIR_CONTEST_WORKFLOW_TYPE,
          entityId: row.id,
          currentState: 'open',
          initiatedBy: session.userId,
          initiatedAt: now,
        }),
        update,
        pairContestChangedSentinel(db),
        noOtherOpenPairReportSentinel(db, row),
        ...(window.basis === 'silence'
          ? pairWorkflowStepStmts(
              db,
              row,
              { which: 'report', toState: 'declined' },
              { actorId: null, reason: 'owner silent 30 days' },
              now,
            )
          : []),
        workflowTransitionInsert(db, {
          workflowId: protestWorkflowId,
          fromState: null,
          toState: 'open',
          actorId: session.userId,
          reason: 'protest filed',
          metadata: { basis: window.basis },
        }),
      ],
      audits,
      () => protestRaceError(db, row),
    );
    const [wire] = await pairContestWireRows(db, [await loadRow(db, row.id)]);
    c.executionCtx.waitUntil(
      sendPairContestSubmittedNotification(c, {
        contestId: row.id,
        kind: 'protest',
        integrationName: facts.name ?? 'this integration',
        flowName: wire?.flow?.data_object_name ?? null,
        reason,
        submitterVendorName: wire?.submitter_name ?? 'A vendor',
        pairSlugs: facts.pairSlugs,
      }).then(
        () => undefined,
        () => undefined,
      ),
    );
    // The owner's seats are emailed its reply window (AECI-1205's rule, AECI-2110).
    c.executionCtx.waitUntil(
      emailPairProtestFiled(c, db, wire, {
        basis: window.basis,
        reason,
        protestedAt: now,
        replyDueAt,
      }),
    );
    const body = await contestBody(db, row.id);
    validateResponseInDev(c.env, () => PairContestResponseSchema.parse(body));
    return json(body);
  };
}

const DAY_MS = 86_400_000;

/** Another open data flow report by the same submitter on the same flow, if any. */
async function otherOpenReportOnFlow(db: Db, row: PairContestRow): Promise<boolean> {
  if (row.claimId === null) return false;
  const t = syncServicePairContests;
  const hit = await db
    .select({ id: t.id })
    .from(t)
    .where(
      and(
        eq(t.submitterVendorId, row.submitterVendorId),
        eq(t.kind, 'data_flow'),
        eq(t.claimId, row.claimId),
        eq(t.status, 'open'),
        sql`${t.id} <> ${row.id}`,
      ),
    )
    .limit(1);
  return hit.length > 0;
}

function otherReportOpenError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.PAIR_PROTEST_NOT_ALLOWED,
    'Your company has another report open on this data flow. Wait for its answer, or withdraw it first.',
    { details: { reason: 'contest_open' } },
  );
}

/** Which sentinel fired on a lost protest file: a protest landed first, the owner
 *  answered first, or another report on the flow was filed meanwhile. */
async function protestRaceError(db: Db, row: PairContestRow): Promise<ApiError> {
  const now = await loadRow(db, row.id);
  if (
    now.protestStatus === null &&
    now.status === row.status &&
    (await otherOpenReportOnFlow(db, row))
  ) {
    return otherReportOpenError();
  }
  return new ApiError(
    409,
    ApiErrorCode.PAIR_PROTEST_NOT_ALLOWED,
    'The owner answered, or a review was already asked for. Reload to see where it stands.',
  );
}

/** `POST /api/vendor/pair-contests/:id/protest/withdraw`. The submitter only. No
 *  cooldown and no refile. The owner is told (AECI-2110). */
export function createWithdrawPairProtestHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);
    const row = await loadRow(db, param(c));
    if (row.submitterVendorId !== vendorId) throw notFoundError('pair_contest', { id: row.id });
    const notOpen = () =>
      new ApiError(409, ApiErrorCode.PAIR_PROTEST_NOT_OPEN, 'This review is no longer open.');
    if (row.protestStatus !== 'open') throw notOpen();
    const now = new Date().toISOString();
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const facts = await rowFacts(db, row);
    const anchor = row.integrationId ? 'integration' : 'evidenced_pair';
    await runTransition(
      c,
      db,
      [
        db
          .update(syncServicePairContests)
          .set({ protestStatus: 'withdrawn', updatedAt: now })
          .where(
            and(
              eq(syncServicePairContests.id, row.id),
              eq(syncServicePairContests.protestStatus, 'open'),
              eq(syncServicePairContests.submitterVendorId, vendorId),
            ),
          ),
        pairContestChangedSentinel(db),
        ...pairWorkflowStepStmts(
          db,
          row,
          { which: 'protest', toState: 'withdrawn' },
          { actorId: session.userId, reason: 'protest withdrawn' },
          now,
        ),
      ],
      [
        {
          ...actor,
          action: 'integration.pair_contest.protest_withdrawn',
          entityType: PAIR_CONTEST_ENTITY_TYPE,
          entityId: row.id,
          beforeState: { protest_status: 'open' },
          afterState: { protest_status: 'withdrawn' },
          metadata: { source: AUDIT_SOURCE, vendorId },
        },
        ...(row.ownerVendorId
          ? [
              pairRightNotificationAudit('portal-sync-service-pair-report', actor, anchor, {
                event: 'protest_withdrawn',
                vendorId: row.ownerVendorId,
                integrationId: row.integrationId ?? row.evidencedPairId!,
                integrationName: facts.name,
                reportKind: 'data_flow',
                byVendorName: null,
                reason: null,
                pairPublic: null,
                pairSlugs: facts.pairSlugs,
              }),
            ]
          : []),
      ],
      notOpen,
    );
    const body = await contestBody(db, row.id);
    validateResponseInDev(c.env, () => PairContestResponseSchema.parse(body));
    return json(body);
  };
}

/**
 * `POST /api/vendor/pair-contests/:id/protest/reply` (AECI-2110, §11b.12.6 applied).
 * The snapshot owner (`owner_vendor_id` on an owner-routed report) replies once, before
 * `protest_reply_due_at`. The reply does not re-check current ownership: it writes
 * nothing to the catalog, and the vendor that decided is the right one to explain.
 */
export function createReplyPairProtestHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);
    const row = await loadRow(db, param(c));
    if (row.routedTo !== 'owner' || row.ownerVendorId !== vendorId || row.protestStatus === null) {
      throw notFoundError('pair_contest', { id: row.id });
    }
    const replyError = (current: PairContestRow, at: string): ApiError => {
      if (current.protestStatus !== 'open') {
        return new ApiError(
          409,
          ApiErrorCode.PROTEST_NOT_OPEN,
          'This review was already decided or withdrawn.',
        );
      }
      if (current.protestReply !== null) {
        return new ApiError(409, ApiErrorCode.PROTEST_REPLY_EXISTS, 'You already replied.');
      }
      if (current.protestReplyDueAt === null || at >= current.protestReplyDueAt) {
        return new ApiError(
          409,
          ApiErrorCode.PROTEST_REPLY_CLOSED,
          'The time to reply has passed.',
          current.protestReplyDueAt ? { details: { reply_due_at: current.protestReplyDueAt } } : {},
        );
      }
      return new ApiError(409, ApiErrorCode.PROTEST_NOT_OPEN, 'This review changed. Reload.');
    };
    const now = new Date().toISOString();
    if (
      row.protestStatus !== 'open' ||
      row.protestReply !== null ||
      row.protestReplyDueAt === null ||
      now >= row.protestReplyDueAt
    ) {
      throw replyError(row, now);
    }
    const payload = await parseJsonBody(c, ReplyPairProtestSchema);
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const facts = await rowFacts(db, row);
    const anchor = row.integrationId ? 'integration' : 'evidenced_pair';
    await runTransition(
      c,
      db,
      [
        db
          .update(syncServicePairContests)
          .set({
            protestReply: payload.reply,
            protestReplyEvidence: storedPairEvidence(payload.evidence_urls ?? []),
            protestRepliedBy: session.userId,
            protestRepliedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(syncServicePairContests.id, row.id),
              eq(syncServicePairContests.protestStatus, 'open'),
              eq(syncServicePairContests.ownerVendorId, vendorId),
              isNull(syncServicePairContests.protestReply),
              sql`${syncServicePairContests.protestReplyDueAt} > ${now}`,
            ),
          ),
        pairContestChangedSentinel(db),
        ...pairWorkflowStepStmts(
          db,
          row,
          { which: 'protest', toState: 'open' },
          { actorId: session.userId, reason: 'owner replied' },
          now,
        ),
      ],
      [
        {
          ...actor,
          action: 'integration.pair_contest.protest_replied',
          entityType: PAIR_CONTEST_ENTITY_TYPE,
          entityId: row.id,
          afterState: { protest_replied_at: now },
          metadata: { source: AUDIT_SOURCE, vendorId },
        },
        pairRightNotificationAudit('portal-sync-service-pair-report', actor, anchor, {
          event: 'protest_replied',
          vendorId: row.submitterVendorId,
          integrationId: row.integrationId ?? row.evidencedPairId!,
          integrationName: facts.name,
          reportKind: 'data_flow',
          byVendorName: null,
          reason: null,
          pairPublic: null,
          pairSlugs: facts.pairSlugs,
        }),
      ],
      async () => replyError(await loadRow(db, row.id), new Date().toISOString()),
    );
    const body = await contestBody(db, row.id, 'received');
    validateResponseInDev(c.env, () => PairContestResponseSchema.parse(body));
    return json(body);
  };
}
