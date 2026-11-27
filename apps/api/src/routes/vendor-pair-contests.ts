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
 *
 * Every write: `requireVendor()` → `rateLimit('write')`, then the handler. A seat is the
 * whole gate. A report on another vendor's row, or a decision on a report not routed to
 * the caller, is the same `404` as an unknown id. Every transition is one batch: the
 * guarded row write and its sentinel, the audit row, the `notification.sent` row for
 * the other side. The AECi alert email goes out after commit on an AECi-routed submit,
 * and the owner's seats get `pair-report-submitted-owner` on an owner-routed one
 * (AECI-2229).
 */

import {
  ApiErrorCode,
  DecidePairContestSchema,
  FilePairProtestSchema,
  PairContestResponseSchema,
  SubmitPairContestSchema,
  VendorPairContestsResponseSchema,
  pairProtestWindow,
  type PairContestResponse,
  type VendorPairContestsResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, desc, eq, isNull } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import { claims, syncServicePairContests, taxonomyDataObjects, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { emailPairReportSubmittedToOwner } from '../lib/contest-protest-emails';
import { sendPairContestSubmittedNotification } from '../lib/email';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { integrationRetiredError, integrationVetoedError } from '../lib/live-integration';
import { ownerFlowContextOf, ownerMaintainsFlows, resolveOwnerFlowClaim } from '../lib/owner-flows';
import {
  isPairContestRaceError,
  openDuplicate,
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

export async function contestBody(db: Db, id: string): Promise<PairContestResponse> {
  const row = await db.query.syncServicePairContests.findFirst({
    where: eq(syncServicePairContests.id, id),
  });
  if (!row) throw notFoundError('pair_contest', { id });
  const [contest] = await pairContestWireRows(db, [row]);
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
      db.insert(syncServicePairContests).values(row),
      pairContestDuplicateSentinel(db, row),
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
      submitted: await pairContestWireRows(db, submitted),
      received: await pairContestWireRows(db, received),
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
  onRace: () => ApiError,
): Promise<void> {
  try {
    await db.batch([
      ...stmts,
      ...audits.map((entry) => auditInsert(db, vendorAuditEntry(c, entry))),
    ] as BatchTuple);
  } catch (error) {
    if (!isPairContestRaceError(error)) throw error;
    throw onRace();
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

    if (!accepted) {
      await runTransition(c, db, [update, pairContestChangedSentinel(db)], audits, notOpenError);
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
        prefix: [update, pairContestChangedSentinel(db)],
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
    const body = await contestBody(db, row.id);
    validateResponseInDev(c.env, () => PairContestResponseSchema.parse(body));
    return json(body);
  };
}

/**
 * `POST /api/vendor/pair-contests/:id/protest`. The submitter of an owner-routed data
 * flow report, inside the §11b.12.2 window: 30 days from a decline, or days 30 to 60 of
 * silence. A silence protest records the decline at day 30 in the same batch, as
 * §11b.12.3 does. Advice only: AECi's answer never writes the listing.
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
    const { reason } = await parseJsonBody(c, FilePairProtestSchema);
    const window = pairProtestWindow(row, new Date());
    if (!window) {
      throw new ApiError(
        409,
        ApiErrorCode.PAIR_PROTEST_NOT_ALLOWED,
        'This report cannot be sent to AEC Integrations for review now.',
      );
    }
    const now = new Date().toISOString();
    const silenceDecidedAt = new Date(Date.parse(row.createdAt) + 30 * 86_400_000).toISOString();
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const facts = await rowFacts(db, row);
    const anchor = row.integrationId ? 'integration' : 'evidenced_pair';
    const update = db
      .update(syncServicePairContests)
      .set({
        protestStatus: 'open',
        protestBasis: window.basis,
        protestReason: reason,
        protestedBy: session.userId,
        protestedAt: now,
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
      {
        ...actor,
        action: 'integration.pair_contest.protested',
        entityType: PAIR_CONTEST_ENTITY_TYPE,
        entityId: row.id,
        afterState: { protest_status: 'open', protest_basis: window.basis },
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
            }),
          ]
        : []),
    ];
    await runTransition(
      c,
      db,
      [update, pairContestChangedSentinel(db)],
      audits,
      () =>
        new ApiError(
          409,
          ApiErrorCode.PAIR_PROTEST_NOT_ALLOWED,
          'The owner answered, or a review was already asked for. Reload to see where it stands.',
        ),
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
    const body = await contestBody(db, row.id);
    validateResponseInDev(c.env, () => PairContestResponseSchema.parse(body));
    return json(body);
  };
}

/** `POST /api/vendor/pair-contests/:id/protest/withdraw`. The submitter only. */
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
            ),
          ),
        pairContestChangedSentinel(db),
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
      ],
      notOpen,
    );
    const body = await contestBody(db, row.id);
    validateResponseInDev(c.env, () => PairContestResponseSchema.parse(body));
    return json(body);
  };
}
