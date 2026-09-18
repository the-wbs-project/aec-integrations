/**
 * Integration field contests, AECi side (AECI-1008 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b; `API_CONTRACTS.md` §6.10) — Drizzle/D1.
 *
 *   GET   /api/admin/contests      — the queue, by status and route, paginated.
 *   PATCH /api/admin/contests/:id  — accept or decline an AECi-routed contest.
 *
 * ── AN ACCEPT HERE WRITES NO CATALOG DATA ───────────────────────────────────
 * The catalog is curated upstream in the review app and arrives through promote
 * (`docs/REVIEW_APP_PROMOTE_API.md`). A value written here would be overwritten by
 * the next promote of the same edge. So an accept records the decision and, after
 * commit, files a `REVIEW - Apply contested field: …` Linear issue for the review
 * lane (`createLinearIssueForContest`, playbook AECI-1025). The §6.7 sweep retries
 * the issue if that first attempt fails.
 *
 * That is also why this is the eighth named write exception in
 * `ADMIN_PANEL_SPEC.md`: a decision write, not a catalog write.
 *
 * ── OWNER-ROUTED ROWS ARE READ-ONLY HERE ────────────────────────────────────
 * The list can show them (`?routed_to=owner`) so an operator can see a dispute.
 * The PATCH refuses them with `409 CONTEST_ROUTED_TO_OWNER`: the owner decides, and
 * two deciders on one row is how a contest gets accepted twice with two values.
 *
 * One batch per decision: the guarded UPDATE (`WHERE status = 'open'`), its
 * `audit_log` row, the workflow transition and instance update, and the
 * `notification.sent` row that tells the submitting vendor. The guarded UPDATE is
 * followed immediately by `contestStillOpenSentinel`, so a lost race rolls the
 * whole batch back (no audit, transition or notification) and answers 409, like
 * the vendor handlers.
 */

import {
  AdminContestSchema,
  ApiErrorCode,
  DecideContestSchema,
  ListAdminContestsQuerySchema,
  ListAdminContestsResponseSchema,
  type AdminContest,
  type IntegrationContestField,
  type ListAdminContestsResponse,
} from '@aeci/shared';
import { forwardAuditLog, type AuditLogEntry } from '@aeci/shared/audit-log';
import {
  forwardWorkflowTransition,
  type WorkflowTransitionEntry,
} from '@aeci/shared/workflow-transition';
import { and, asc, count, desc, eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import { integrationFieldChallenges, workflowInstances } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { logToPosthog, submitCount } from '../posthog';
import { auditInsert, workflowTransitionInsert, type BatchStmt } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
  CONTEST_ENTITY_TYPE,
  contestValueLabel,
  hydrateContests,
  pairPathFor,
  type ContestHydration,
  type ContestIntegrationContext,
  type ContestRow,
  contestStillOpenSentinel,
} from '../lib/integration-contests';
import {
  createLinearIssueForContest,
  drizzleContestLinearStore,
  type LinearIssueOutcome,
} from '../lib/linear';
import { CONTEST_WORKFLOW_TYPE, notificationFor, runGuardedContestBatch } from './vendor-contests';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** The post-commit Linear seam. Injected so specs can assert it without a
 *  transport; the default is the real never-throwing creator. */
export type FileContestIssue = typeof createLinearIssueForContest;

const FINAL_OUTCOME = { accepted: 'approved', declined: 'rejected' } as const;

// ─── Mapping ─────────────────────────────────────────────────────────────────

function toAdminContest(row: ContestRow, hydration: ContestHydration): AdminContest | null {
  const integration = hydration.integrations.get(row.integrationId);
  if (!integration) return null;
  const link = (p: ContestIntegrationContext['sourceProduct']) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    logo_url: p.logoUrl,
  });
  const vendorRef = (id: string) => ({ id, name: hydration.vendorNames.get(id) ?? '' });
  return {
    id: row.id,
    integration: {
      id: integration.id,
      name: integration.name,
      source_product: link(integration.sourceProduct),
      target_product: link(integration.targetProduct),
      pair_path:
        pairPathFor([integration.sourceProduct.slug, integration.targetProduct.slug]) ?? '',
    },
    field: row.field as IntegrationContestField,
    current_value: row.currentValue,
    proposed_value: row.proposedValue,
    current_label: contestValueLabel(row.field, row.currentValue, hydration.vendorNames),
    proposed_label: contestValueLabel(row.field, row.proposedValue, hydration.vendorNames),
    reason: row.reason,
    routed_to: row.routedTo as AdminContest['routed_to'],
    status: row.status as AdminContest['status'],
    submitter_vendor: vendorRef(row.submitterVendorId),
    owner_vendor: row.ownerVendorId ? vendorRef(row.ownerVendorId) : null,
    decision_note: row.decisionNote,
    decided_at: row.decidedAt,
    upstream_linear_issue_id: row.upstreamLinearIssueId,
    upstream_linear_issue_url: row.upstreamLinearIssueUrl,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/** `aeci.contest.moderation.action` — one count per PATCH attempt, the contest
 *  twin of `aeci.claim.moderation.action` (`docs/OBSERVABILITY.md`). */
function emitModeration(
  c: AdminContext,
  decision: 'accept' | 'decline',
  outcome: 'ok' | 'not_open' | 'routed_to_owner',
): void {
  try {
    submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.contest.moderation.action', 1, [
      `action:${decision}`,
      `outcome:${outcome}`,
    ]);
  } catch {
    // Telemetry must never fail a committed decision.
  }
}

function forwarders(c: AdminContext) {
  const log = (message: string, extra: Record<string, unknown>) => {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message,
      source: 'admin-moderation',
      ...extra,
    });
  };
  if (!c.env.POSTHOG_PROJECT_KEY) return { audit: undefined, workflow: undefined };
  return {
    audit: (entry: AuditLogEntry) =>
      log(`audit ${entry.action} ${entry.entityId ?? ''}`.trim(), {
        action: entry.action,
        entity_type: entry.entityType ?? undefined,
        entity_id: entry.entityId ?? undefined,
      }),
    workflow: (entry: WorkflowTransitionEntry) =>
      log(`workflow ${entry.fromState ?? '∅'}→${entry.toState} ${entry.workflowId}`, {
        from_state: entry.fromState ?? undefined,
        to_state: entry.toState,
        workflow_id: entry.workflowId,
      }),
  };
}

// ─── GET /api/admin/contests ─────────────────────────────────────────────────

export function createAdminContestsListHandler(
  dbFor: DbFactory = getDb,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const query = ListAdminContestsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const { db } = dbFor(c.env);
    const where = and(
      eq(integrationFieldChallenges.status, query.status),
      eq(integrationFieldChallenges.routedTo, query.routed_to),
    );
    // Served by `integration_field_challenges_queue_idx (routed_to, status,
    // created_at)`. `id` breaks a `created_at` tie so pages are stable (AECI-99).
    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(integrationFieldChallenges)
        .where(where)
        .orderBy(desc(integrationFieldChallenges.createdAt), asc(integrationFieldChallenges.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      db.select({ value: count() }).from(integrationFieldChallenges).where(where),
    ]);
    const hydration = await hydrateContests(db, rows);
    const body: ListAdminContestsResponse = {
      data: rows
        .map((row) => toAdminContest(row, hydration))
        .filter((row): row is AdminContest => row !== null),
      page: query.page,
      perPage: query.perPage,
      total: totalRows[0]?.value ?? 0,
    };
    validateResponseInDev(c.env, () => ListAdminContestsResponseSchema.parse(body));
    return json(body);
  };
}

// ─── PATCH /api/admin/contests/:id ───────────────────────────────────────────

export function createModerateContestHandler(
  dbFor: DbFactory = getDb,
  fileIssue: FileContestIssue = createLinearIssueForContest,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const id = c.req.param('id');
    if (!id) throw new ApiError(400, 'VALIDATION_FAILED', 'Missing contest id', { field: 'id' });
    const payload = await DecideContestSchema.parseAsync(await readJson(c));
    const { db } = writeDb(c, dbFor);

    const row = await db.query.integrationFieldChallenges.findFirst({
      where: eq(integrationFieldChallenges.id, id),
    });
    if (!row) throw notFoundError('contest', { id });
    if (row.routedTo !== 'aeci') {
      emitModeration(c, payload.decision, 'routed_to_owner');
      throw new ApiError(
        409,
        ApiErrorCode.CONTEST_ROUTED_TO_OWNER,
        'This contest is decided by the integration’s owner, not by AECi.',
      );
    }
    if (row.status !== 'open') {
      emitModeration(c, payload.decision, 'not_open');
      throw new ApiError(
        409,
        ApiErrorCode.CONTEST_NOT_OPEN,
        `This contest is already ${row.status}.`,
      );
    }

    const status = payload.decision === 'accept' ? 'accepted' : 'declined';
    const note = payload.note ?? null;
    const now = new Date().toISOString();
    const metadata = {
      source: 'admin-moderation',
      contestId: id,
      integrationId: row.integrationId,
      field: row.field,
      submitterVendorId: row.submitterVendorId,
    };
    const audit: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: `integration.contest.${status}`,
      entityType: CONTEST_ENTITY_TYPE,
      entityId: id,
      beforeState: { status: 'open' },
      afterState: { status, decision_note: note },
      metadata,
    };
    const workflowId = row.workflowId ?? crypto.randomUUID();
    const transition: WorkflowTransitionEntry = {
      workflowId,
      fromState: 'open',
      toState: status,
      actorId: session.userId,
      reason: note ?? `contest ${status}`,
      metadata,
    };
    const notify = await notificationFor(db, row, session, status);
    const audits = notify ? [audit, notify] : [audit];

    const stmts: BatchStmt[] = [
      db
        .update(integrationFieldChallenges)
        .set({
          status,
          decisionNote: note,
          decidedBy: session.userId,
          decidedAt: now,
          updatedAt: now,
        })
        .where(
          and(eq(integrationFieldChallenges.id, id), eq(integrationFieldChallenges.status, 'open')),
        ),
      // Immediately after the guarded UPDATE: a lost race aborts the batch here,
      // before the transition, the audit row and the notification.
      contestStillOpenSentinel(db, id),
      row.workflowId
        ? db
            .update(workflowInstances)
            .set({ currentState: status, completedAt: now, finalOutcome: FINAL_OUTCOME[status] })
            .where(eq(workflowInstances.id, workflowId))
        : db.insert(workflowInstances).values({
            id: workflowId,
            workflowType: CONTEST_WORKFLOW_TYPE,
            entityId: id,
            currentState: status,
            completedAt: now,
            finalOutcome: FINAL_OUTCOME[status],
          }),
      workflowTransitionInsert(db, transition),
      ...audits.map((entry) => auditInsert(db, entry)),
    ];
    let after: ContestRow;
    try {
      after = await runGuardedContestBatch(db, id, stmts);
    } catch (error) {
      if (error instanceof ApiError && error.code === ApiErrorCode.CONTEST_NOT_OPEN) {
        emitModeration(c, payload.decision, 'not_open');
      }
      throw error;
    }
    emitModeration(c, payload.decision, 'ok');

    const hydration = await hydrateContests(db, [after]);
    const f = forwarders(c);
    c.executionCtx.waitUntil(
      Promise.all([
        ...audits.map((entry) => forwardAuditLog(entry, f.audit)),
        forwardWorkflowTransition(transition, f.workflow),
      ]),
    );
    if (status === 'accepted') {
      c.executionCtx.waitUntil(fileContestIssue(c, db, fileIssue, after, hydration));
    }

    const body = toAdminContest(after, hydration);
    if (!body) throw notFoundError('contest', { id });
    validateResponseInDev(c.env, () => AdminContestSchema.parse(body));
    return json(body);
  };
}

/** Build the issue input from a committed row and file it. Never rejects: the
 *  creator never throws, and a hydration gap resolves to a logged skip that the
 *  §6.7 sweep will retry. */
async function fileContestIssue(
  c: AdminContext,
  db: Db,
  fileIssue: FileContestIssue,
  row: ContestRow,
  hydration: ContestHydration,
): Promise<LinearIssueOutcome | null> {
  const integration = hydration.integrations.get(row.integrationId);
  if (!integration) return null;
  return fileIssue(c, drizzleContestLinearStore(db), {
    contestId: row.id,
    integrationId: row.integrationId,
    integrationName: integration.name,
    sourceProductName: integration.sourceProduct.name,
    targetProductName: integration.targetProduct.name,
    pairPath: pairPathFor([integration.sourceProduct.slug, integration.targetProduct.slug]),
    field: row.field,
    currentValue: row.currentValue,
    acceptedValue: row.proposedValue,
    currentLabel: contestValueLabel(row.field, row.currentValue, hydration.vendorNames),
    acceptedLabel: contestValueLabel(row.field, row.proposedValue, hydration.vendorNames),
    submitterVendorName: hydration.vendorNames.get(row.submitterVendorId) ?? row.submitterVendorId,
    reason: row.reason,
    adminNote: row.decisionNote,
  }).catch(() => null);
}

async function readJson(c: AdminContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
}
