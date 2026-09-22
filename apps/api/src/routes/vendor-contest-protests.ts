/**
 * Protests to AECi, vendor side (AECI-1009 / `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §11b.12) — Drizzle/D1.
 *
 *   POST /api/vendor/contests/:id/protest           — the submitter files.
 *   POST /api/vendor/contests/:id/protest/reply     — the snapshot owner replies, once.
 *   POST /api/vendor/contests/:id/protest/withdraw  — the submitter withdraws.
 *
 * The rules of `vendor-contests.ts` hold here unchanged: a seat is the whole gate
 * (no `requireCapability`, the §11b.2 exception), a caller who is not a party gets
 * the unknown-id 404, and every step is ONE batch whose guarded `UPDATE` is
 * followed immediately by the `changes() = 0` sentinel, so a lost race writes no
 * audit row, no transition and no notification.
 *
 * Two things are new:
 *
 *   - **AECi's ruling is advice.** Nothing here writes `integrations`, purges a
 *     page, re-crawls, touches Algolia or files a Linear issue. A protest is not
 *     public.
 *   - **Silence counts as a decline (ruled).** An owner-routed contest the owner has
 *     not answered for 30 days can be protested. That state is never stored or
 *     swept: the file batch itself moves the contest `open → declined`, guarded on
 *     `status = 'open'`, so the owner's late answer and the protest race exactly as
 *     two deciders do (§11b.12.3).
 */

import {
  addContestDays,
  ApiErrorCode,
  CONTEST_PROTEST_REPLY_DAYS,
  FileContestProtestSchema,
  ReplyContestProtestSchema,
  type ContestNotificationEvent,
  type ContestProtestBasis,
  type IntegrationContestField,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import type { WorkflowTransitionEntry } from '@aeci/shared/workflow-transition';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { ZodType } from 'zod';

import { getDb, type Db } from '../db/client';
import { integrationFieldChallenges, integrations, workflowInstances } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { resolveAttestationSlots } from '../lib/attestation-authority';
import { auditInsert, workflowTransitionInsert, type BatchStmt } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import {
  assertProtestable,
  dedupeEvidence,
  ownerStillHolds,
  PROTEST_ACTIONS,
  protestNotAvailable,
  protestNotOpen,
  runGuardedProtestBatch,
  valueUnchanged,
} from '../lib/contest-protests';
import { writeDb, type DbFactory } from '../lib/handler-utils';
import {
  CONTEST_ENTITY_TYPE,
  contestIntegrationStateSentinel,
  contestNotificationAudit,
  contestStillOpenSentinel,
  contestValueUnchangedSentinel,
  receivedContestsWhere,
  type ContentContestField,
  type ContestNotificationMetadata,
  type ContestRow,
} from '../lib/integration-contests';
import { closeWorkflow, CONTEST_WORKFLOW_TYPE, echo, endpointSlugs } from './vendor-contests';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  parseJsonBody,
  sessionVendorId,
  type VendorContext,
} from './vendor-shared';

/** The clock, injectable so specs can stand on each window boundary. */
export type Clock = () => Date;
const systemClock: Clock = () => new Date();

function idParam(c: VendorContext): string {
  const value = c.req.param('id');
  if (!value) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing id', { field: 'id' });
  return value;
}

export function integrationChangedForProtest(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.CONTEST_INTEGRATION_CHANGED,
    'This integration has a new owner, or is no longer claimed, since the decision. Contest it again to reach its owner.',
  );
}

export function valueStaleForProtest(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.CONTEST_VALUE_STALE,
    'The owner changed this field since the decision. Contest the new value instead.',
  );
}

function replyExists(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.PROTEST_REPLY_EXISTS,
    'The owner has already replied to this protest.',
  );
}

function replyClosed(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.PROTEST_REPLY_CLOSED,
    'The time to reply to this protest has passed.',
  );
}

/**
 * The `notification.sent` rows for one protest event, one per recipient. Built
 * from a single integration read so both sides of a decision get the same snapshot.
 */
export async function protestNotifications(
  db: Db,
  row: ContestRow,
  actor: { actorId: string | null; actorType: AuditLogEntry['actorType'] },
  event: ContestNotificationEvent,
  recipients: ReadonlyArray<{
    vendorId: string | null;
    extra?: Partial<
      Pick<ContestNotificationMetadata, 'recipientRole' | 'basis' | 'replyDueAt' | 'cooldownUntil'>
    >;
  }>,
): Promise<AuditLogEntry[]> {
  const targets = recipients.filter(
    (r): r is typeof r & { vendorId: string } => typeof r.vendorId === 'string',
  );
  if (targets.length === 0) return [];
  const integration = await db.query.integrations.findFirst({
    columns: { name: true, sourceProductId: true, targetProductId: true },
    where: eq(integrations.id, row.integrationId),
  });
  const pairSlugs = integration
    ? await endpointSlugs(db, integration.sourceProductId, integration.targetProductId)
    : null;
  return targets.map((target) =>
    contestNotificationAudit(actor, {
      vendorId: target.vendorId,
      contestId: row.id,
      integrationId: row.integrationId,
      integrationName: integration?.name ?? null,
      field: row.field as IntegrationContestField,
      event,
      pairSlugs,
      ...(target.extra ?? {}),
    }),
  );
}

/** A 404 from the authority resolver becomes the contest's own unknown-id 404. */
async function assertStillEndpointVendor(db: Db, vendorId: string, row: ContestRow) {
  try {
    await resolveAttestationSlots(db, vendorId, row.integrationId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw notFoundError('contest', { id: row.id });
    }
    throw error;
  }
}

// ─── POST /api/vendor/contests/:id/protest ───────────────────────────────────

export function createFileContestProtestHandler(
  dbFor: DbFactory = getDb,
  clock: Clock = systemClock,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const id = idParam(c);
    const { db } = writeDb(c, dbFor);

    // 1. The submitter only. 2. Still an endpoint vendor. Both miss as a 404.
    const row = await db.query.integrationFieldChallenges.findFirst({
      where: and(
        eq(integrationFieldChallenges.id, id),
        eq(integrationFieldChallenges.submitterVendorId, vendorId),
      ),
    });
    if (!row) throw notFoundError('contest', { id });
    await assertStillEndpointVendor(db, vendorId, row);

    // 3. Eligibility: routing, owner, one protest, and the window.
    const now = clock().toISOString();
    const window = assertProtestable(row, now);

    // 4. The body.
    const payload = await parseJsonBody(
      c,
      FileContestProtestSchema as unknown as ZodType<{ reason: string; evidence_urls: string[] }>,
    );

    // 5. The same owner still holds the claimed row. 6. The value is unchanged.
    const integration = await db.query.integrations.findFirst({
      where: eq(integrations.id, row.integrationId),
    });
    if (!integration) throw notFoundError('contest', { id });
    if (!ownerStillHolds(row, integration)) throw integrationChangedForProtest();
    if (!valueUnchanged(row, integration)) throw valueStaleForProtest();

    const basis: ContestProtestBasis = window.basis;
    const silence = basis === 'silence';
    const evidence = dedupeEvidence(payload.evidence_urls);
    const replyDueAt = addContestDays(now, CONTEST_PROTEST_REPLY_DAYS);
    const protestWorkflowId = crypto.randomUUID();
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const metadata = {
      source: AUDIT_SOURCE,
      vendorId,
      contestId: id,
      integrationId: row.integrationId,
      field: row.field,
      basis,
    };

    const audits: AuditLogEntry[] = [];
    const stmts: BatchStmt[] = [
      // The FK target first, as the contest submit orders its instance insert.
      db.insert(workflowInstances).values({
        id: protestWorkflowId,
        workflowType: CONTEST_WORKFLOW_TYPE,
        entityId: id,
        currentState: 'open',
        initiatedBy: session.userId,
        initiatedAt: now,
      }),
      db
        .update(integrationFieldChallenges)
        .set({
          // Silence: the file batch is where the contest becomes a decline, dated to
          // the silence-decline instant (day 30), with no deciding seat or note.
          ...(silence ? { status: 'declined', decidedAt: window.opensAt } : {}),
          protestStatus: 'open',
          protestBasis: basis,
          protestReason: payload.reason,
          protestEvidence: JSON.stringify(evidence),
          protestedBy: session.userId,
          protestedAt: now,
          protestReplyDueAt: replyDueAt,
          protestWorkflowId,
          updatedAt: now,
        })
        .where(
          and(
            eq(integrationFieldChallenges.id, id),
            isNull(integrationFieldChallenges.protestStatus),
            eq(integrationFieldChallenges.status, silence ? 'open' : 'declined'),
          ),
        ),
      // Immediately after the guarded UPDATE.
      contestStillOpenSentinel(db, id),
      contestIntegrationStateSentinel(db, row.integrationId, {
        claimed: true,
        ownerVendorId: row.ownerVendorId,
      }),
      contestValueUnchangedSentinel(
        db,
        row.integrationId,
        row.field as ContentContestField,
        row.currentValue,
      ),
    ];

    if (silence) {
      audits.push({
        ...actor,
        action: PROTEST_ACTIONS.lapsed,
        entityType: CONTEST_ENTITY_TYPE,
        entityId: id,
        beforeState: { status: 'open' },
        afterState: { status: 'declined', decided_at: window.opensAt },
        metadata,
      });
      stmts.push(
        ...closeWorkflow(
          db,
          row,
          'declined',
          { actorId: session.userId, reason: 'owner silent 30 days', metadata },
          now,
        ).stmts,
      );
    }
    const transition: WorkflowTransitionEntry = {
      workflowId: protestWorkflowId,
      fromState: null,
      toState: 'open',
      actorId: session.userId,
      reason: 'protest filed',
      metadata,
    };
    stmts.push(workflowTransitionInsert(db, transition));
    audits.push({
      ...actor,
      action: PROTEST_ACTIONS.protested,
      entityType: CONTEST_ENTITY_TYPE,
      entityId: id,
      beforeState: { protest_status: null },
      afterState: {
        protest_status: 'open',
        protest_basis: basis,
        protest_reason: payload.reason,
        protest_evidence: evidence,
        protest_reply_due_at: replyDueAt,
      },
      metadata,
    });
    audits.push(
      ...(await protestNotifications(db, row, actor, 'protested', [
        { vendorId: row.ownerVendorId, extra: { basis, replyDueAt } },
      ])),
    );
    stmts.push(...audits.map((entry) => auditInsert(db, entry)));

    const after = await runGuardedProtestBatch(db, id, stmts, async () => {
      const fresh = await db.query.integrationFieldChallenges.findFirst({
        where: eq(integrationFieldChallenges.id, id),
      });
      if (!fresh) return notFoundError('contest', { id });
      if (fresh.protestStatus !== null) return protestNotAvailable('already_protested');
      if (fresh.status !== row.status) return protestNotAvailable('contest_changed');
      const live = await db.query.integrations.findFirst({
        where: eq(integrations.id, row.integrationId),
      });
      if (!live || !ownerStillHolds(row, live)) return integrationChangedForProtest();
      if (!valueUnchanged(row, live)) return valueStaleForProtest();
      return protestNotAvailable('contest_changed');
    });

    // Nothing public changed: no purge, no re-crawl. The forward still runs.
    afterVendorWrite(c, [], audits);
    return echo(c, db, vendorId, after);
  };
}

// ─── POST /api/vendor/contests/:id/protest/reply ─────────────────────────────

export function createReplyContestProtestHandler(
  dbFor: DbFactory = getDb,
  clock: Clock = systemClock,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const id = idParam(c);
    const { db } = writeDb(c, dbFor);

    // The snapshot owner only, and only on a row that carries a protest.
    const row = await db.query.integrationFieldChallenges.findFirst({
      where: and(eq(integrationFieldChallenges.id, id), receivedContestsWhere(vendorId)),
    });
    if (!row || row.protestStatus === null) throw notFoundError('contest', { id });
    if (row.protestStatus !== 'open') throw protestNotOpen();
    if (row.protestReply !== null) throw replyExists();
    const now = clock().toISOString();
    if (!row.protestReplyDueAt || Date.parse(now) >= Date.parse(row.protestReplyDueAt)) {
      throw replyClosed();
    }

    const payload = await parseJsonBody(
      c,
      ReplyContestProtestSchema as unknown as ZodType<{ reply: string; evidence_urls: string[] }>,
    );
    const evidence = dedupeEvidence(payload.evidence_urls);
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const metadata = {
      source: AUDIT_SOURCE,
      vendorId,
      contestId: id,
      integrationId: row.integrationId,
      field: row.field,
    };
    const audits: AuditLogEntry[] = [
      {
        ...actor,
        action: PROTEST_ACTIONS.replied,
        entityType: CONTEST_ENTITY_TYPE,
        entityId: id,
        beforeState: { protest_reply: null },
        afterState: { protest_reply: payload.reply, protest_reply_evidence: evidence },
        metadata,
      },
      ...(await protestNotifications(db, row, actor, 'protest_replied', [
        { vendorId: row.submitterVendorId },
      ])),
    ];
    const stmts: BatchStmt[] = [
      db
        .update(integrationFieldChallenges)
        .set({
          protestReply: payload.reply,
          protestReplyEvidence: JSON.stringify(evidence),
          protestRepliedBy: session.userId,
          protestRepliedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(integrationFieldChallenges.id, id),
            eq(integrationFieldChallenges.protestStatus, 'open'),
            isNull(integrationFieldChallenges.protestReply),
            // The deadline is enforced in the write too, not only on the read.
            gt(integrationFieldChallenges.protestReplyDueAt, now),
          ),
        ),
      contestStillOpenSentinel(db, id),
    ];
    if (row.protestWorkflowId) {
      stmts.push(
        workflowTransitionInsert(db, {
          workflowId: row.protestWorkflowId,
          fromState: 'open',
          toState: 'open',
          actorId: session.userId,
          reason: 'owner replied',
          metadata,
        }),
      );
    }
    stmts.push(...audits.map((entry) => auditInsert(db, entry)));

    const after = await runGuardedProtestBatch(db, id, stmts, async () => {
      const fresh = await db.query.integrationFieldChallenges.findFirst({
        where: eq(integrationFieldChallenges.id, id),
      });
      if (!fresh || fresh.protestStatus !== 'open') return protestNotOpen();
      if (fresh.protestReply !== null) return replyExists();
      return replyClosed();
    });
    afterVendorWrite(c, [], audits);
    return echo(c, db, vendorId, after);
  };
}

// ─── POST /api/vendor/contests/:id/protest/withdraw ──────────────────────────

export function createWithdrawContestProtestHandler(
  dbFor: DbFactory = getDb,
  clock: Clock = systemClock,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const id = idParam(c);
    const { db } = writeDb(c, dbFor);

    const row = await db.query.integrationFieldChallenges.findFirst({
      where: and(
        eq(integrationFieldChallenges.id, id),
        eq(integrationFieldChallenges.submitterVendorId, vendorId),
      ),
    });
    if (!row) throw notFoundError('contest', { id });
    if (row.protestStatus !== 'open') throw protestNotOpen();

    const now = clock().toISOString();
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const metadata = {
      source: AUDIT_SOURCE,
      vendorId,
      contestId: id,
      integrationId: row.integrationId,
      field: row.field,
    };
    const audits: AuditLogEntry[] = [
      {
        ...actor,
        action: PROTEST_ACTIONS.withdrawn,
        entityType: CONTEST_ENTITY_TYPE,
        entityId: id,
        beforeState: { protest_status: 'open' },
        afterState: { protest_status: 'withdrawn' },
        metadata,
      },
      ...(await protestNotifications(db, row, actor, 'protest_withdrawn', [
        { vendorId: row.ownerVendorId },
      ])),
    ];
    const stmts: BatchStmt[] = [
      db
        .update(integrationFieldChallenges)
        .set({ protestStatus: 'withdrawn', updatedAt: now })
        .where(
          and(
            eq(integrationFieldChallenges.id, id),
            eq(integrationFieldChallenges.protestStatus, 'open'),
          ),
        ),
      contestStillOpenSentinel(db, id),
      ...closeProtestWorkflow(
        db,
        row,
        'withdrawn',
        session.userId,
        'protest withdrawn',
        metadata,
        now,
      ),
      ...audits.map((entry) => auditInsert(db, entry)),
    ];
    const after = await runGuardedProtestBatch(db, id, stmts, async () => protestNotOpen());
    afterVendorWrite(c, [], audits);
    return echo(c, db, vendorId, after);
  };
}

/** `final_outcome` per terminal protest state. */
const PROTEST_FINAL_OUTCOME = {
  upheld: 'approved',
  rejected: 'rejected',
  withdrawn: 'cancelled',
} as const;

/**
 * Close the protest's own workflow instance and write its transition. A protest
 * always has an instance (the file batch creates it); a `NULL`
 * `protest_workflow_id` would be a corrupt row, so the transition is skipped
 * rather than pointed at nothing.
 */
export function closeProtestWorkflow(
  db: Db,
  row: ContestRow,
  toState: keyof typeof PROTEST_FINAL_OUTCOME,
  actorId: string,
  reason: string,
  metadata: Record<string, unknown>,
  now: string,
): BatchStmt[] {
  if (!row.protestWorkflowId) return [];
  return [
    db
      .update(workflowInstances)
      .set({
        currentState: toState,
        completedAt: now,
        finalOutcome: PROTEST_FINAL_OUTCOME[toState],
      })
      .where(eq(workflowInstances.id, row.protestWorkflowId)),
    workflowTransitionInsert(db, {
      workflowId: row.protestWorkflowId,
      fromState: 'open',
      toState,
      actorId,
      reason,
      metadata,
    }),
  ];
}
