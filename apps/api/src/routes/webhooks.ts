/**
 * Inbound webhook endpoints (AECI-212 / Phase 6.5).
 *
 *   POST /api/webhooks/linear   — Linear → Site moderation sync.
 *
 * This is the inbound half of the bidirectional Linear↔Supabase sync
 * (`STAGE_1_SPEC.md` §26.4, `STAGE_1_PHASE_6_SPEC.md` §6.3). When an admin moves
 * a vendor-request's issue in Linear, Linear POSTs a data-change webhook here; we
 * HMAC-verify it, map the issue's new workflow-state category to a
 * `vendor_requests.status`, and — when that changes the request — update the row,
 * mirror the `workflow_instance`, and append a `workflow_transitions` row
 * (`actor_type:'workflow'` recorded in metadata, since the table has no such
 * column) plus an `audit_log` row, all in one transaction (CLAUDE.md / §26.1:
 * every state-changing write logs; failure rolls back).
 *
 * **Lean tracking (Stage-1 §26.3 relaxation, Phase 6 Spec §5):** transitions are
 * *recorded*, not *enforced* — no guarded FSM. The status mapping keys on Linear
 * `state.type` (a fixed enum), not the workspace's custom `state.name`.
 *
 * **Lookup contract:** the request's `workflow_instance.linear_issue_id` stores
 * Linear's issue node id (the webhook's `data.id`), populated by the Linear
 * client (Phase 6.4 / AECI-211). Until that lands, every lookup misses and the
 * webhook is a safe no-op — which is also the "unknown issue id → no-op"
 * acceptance criterion. The Linear-app moderation surface only ever holds vendor
 * requests, so we scope the lookup to the `vendor_claim` / `correction_request`
 * workflow types (never `review_moderation`, which has no Linear issue).
 *
 * No cache invalidation: `vendor_requests` are admin-only and render on no
 * cacheable SSR page, so there is no `Cache-Tag` to purge.
 *
 * The handler reads the raw body once (the HMAC is over the exact bytes). The
 * status change is one atomic `db.batch` (ADR 0016 / AECI-253, AECI-249).
 */

import { ApiErrorCode, LinearWebhookSchema, type LinearWebhook } from '@aeci/shared';
import {
  forwardAuditLog,
  type AuditLogEntry,
  type AuditLogForwarder,
} from '@aeci/shared/audit-log';
import {
  forwardWorkflowTransition,
  type WorkflowTransitionEntry,
  type WorkflowTransitionForwarder,
} from '@aeci/shared/workflow-transition';
import { and, eq, inArray } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { vendorRequests, workflowInstances } from '../db/schema';
import { logToDatadog, submitCount } from '../datadog';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { json } from '../http';
import {
  auditInsert,
  workflowTransitionInsert,
  type BatchStmt,
  type BatchTuple,
} from '../lib/audit';
import type { DbFactory } from '../lib/handler-utils';
import { verifyLinearSignature } from '../lib/linear-webhook-auth';

// ─── Status mapping ───────────────────────────────────────────────────────────

/** `vendor_requests.status` vocabulary (schema default `open`). */
type VendorRequestStatus = 'open' | 'in_review' | 'resolved' | 'rejected';

/**
 * Linear `state.type` → `vendor_requests.status`. Keyed on the stable workflow
 * category, not the custom display name, so it survives workspace-specific state
 * renames. `completed`/`canceled` are the terminal moderation outcomes;
 * `started` means an admin is actively working it. An unmapped type → no-op.
 */
const STATE_TYPE_TO_STATUS: Record<string, VendorRequestStatus> = {
  triage: 'open',
  backlog: 'open',
  unstarted: 'open',
  started: 'in_review',
  completed: 'resolved',
  canceled: 'rejected',
};

/** `workflow_instances.final_outcome` for terminal statuses (§26.2). */
const TERMINAL_OUTCOME: Partial<Record<VendorRequestStatus, string>> = {
  resolved: 'completed',
  rejected: 'rejected',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Datadog forwarder for the audit write; no-op without `DD_API_KEY`. Mirrors
 *  `routes/requests.ts`, tagged `source: linear-webhook`. */
function makeAuditForwarder(c: Context<{ Bindings: Env }>): AuditLogForwarder | undefined {
  if (!c.env.DD_API_KEY) return undefined;
  return (entry) => {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source: 'linear-webhook',
    });
  };
}

/** Datadog forwarder for the transition write; no-op without `DD_API_KEY`. */
function makeWorkflowForwarder(
  c: Context<{ Bindings: Env }>,
): WorkflowTransitionForwarder | undefined {
  if (!c.env.DD_API_KEY) return undefined;
  return (entry) => {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `workflow ${entry.fromState ?? '∅'}→${entry.toState} ${entry.workflowId}`.trim(),
      from_state: entry.fromState ?? undefined,
      to_state: entry.toState,
      workflow_id: entry.workflowId,
      source: 'linear-webhook',
    });
  };
}

/** A no-op acknowledgement. Linear only cares about the 2xx; the body aids
 *  debugging and the test assertions. */
function ack(applied: boolean, reason: string): Response {
  return json({ ok: true, applied, reason }, { status: 200 });
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export function createLinearWebhookHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    // Read the exact bytes once — the HMAC is over the raw body, and re-reading
    // a consumed stream would fail.
    const rawBody = await c.req.text();

    // 1. Verify the signature. Fail closed (missing header/secret → 401).
    const ok = await verifyLinearSignature(
      rawBody,
      c.req.header('Linear-Signature'),
      c.env.LINEAR_WEBHOOK_SIGNING_SECRET,
    );
    if (!ok) {
      submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.webhooks.linear.hmac_failure', 1);
      throw new ApiError(401, ApiErrorCode.UNAUTHENTICATED, 'Invalid Linear webhook signature');
    }

    // 2. Parse + validate. Malformed JSON → 400; schema miss → ZodError → 400.
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new ApiError(400, ApiErrorCode.MALFORMED_REQUEST, 'Request body is not valid JSON');
    }
    const payload: LinearWebhook = LinearWebhookSchema.parse(parsed);

    submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.webhooks.linear.receipt', 1, [
      `type:${payload.type}`,
      `action:${payload.action}`,
    ]);

    // 3. Only Issue state changes drive the sync. Comments, removes, creates,
    //    and updates that don't carry a state are acknowledged but ignored.
    if (payload.type !== 'Issue' || payload.action !== 'update' || !payload.data.state) {
      return ack(false, 'not an issue state change');
    }
    const targetStatus = STATE_TYPE_TO_STATUS[payload.data.state.type];
    if (!targetStatus) return ack(false, `unmapped state type: ${payload.data.state.type}`);

    const { db } = dbFor(c.env);

    // 4. Resolve the vendor request behind this Linear issue. The instance's
    //    linear_issue_id is Linear's issue node id (= data.id). Unknown → no-op.
    const workflow = await db.query.workflowInstances.findFirst({
      columns: { id: true, entityId: true },
      where: and(
        eq(workflowInstances.linearIssueId, payload.data.id),
        inArray(workflowInstances.workflowType, ['vendor_claim', 'correction_request']),
      ),
    });
    if (!workflow) return ack(false, 'unknown issue');

    const request = await db.query.vendorRequests.findFirst({
      columns: { id: true, status: true },
      where: eq(vendorRequests.id, workflow.entityId),
    });
    if (!request) return ack(false, 'request not found'); // defensive: orphaned instance

    const currentStatus = request.status as VendorRequestStatus;
    if (currentStatus === targetStatus) return ack(false, 'already in sync');

    // 5. Apply: status + instance mirror + transition + audit, in one atomic batch.
    const isTerminal = targetStatus === 'resolved' || targetStatus === 'rejected';
    const now = new Date().toISOString();
    const metadata = {
      source: 'linear-webhook',
      actor_type: 'workflow',
      linear_action: payload.action,
      linear_issue_id: payload.data.id,
      linear_state_name: payload.data.state.name,
      linear_state_type: payload.data.state.type,
      linear_url: payload.url,
    };
    const workflowEntry: WorkflowTransitionEntry = {
      workflowId: workflow.id,
      fromState: currentStatus,
      toState: targetStatus,
      actorId: null,
      reason: 'linear webhook',
      metadata,
    };
    const auditEntry: AuditLogEntry = {
      actorType: 'workflow',
      action: 'vendor_request.status_changed',
      entityType: 'vendor_request',
      entityId: request.id,
      beforeState: { status: currentStatus },
      afterState: { status: targetStatus },
      metadata,
    };

    const stmts: BatchStmt[] = [
      db
        .update(vendorRequests)
        // resolvedById stays null — the actor is the workflow, not a profile.
        // resolvedAt is set/cleared unconditionally so a reverse transition (an
        // admin reopening a resolved/rejected issue in Linear → a non-terminal
        // status) doesn't leave a stale resolution time on an active row.
        // linearIssueUrl (AECI-261): the webhook carries the issue permalink, so
        // persist it here too — also backfills rows linked before this column existed.
        .set({
          status: targetStatus,
          resolvedAt: isTerminal ? now : null,
          linearIssueUrl: payload.url,
        })
        .where(eq(vendorRequests.id, request.id)),
      db
        .update(workflowInstances)
        // Mirror the request: clear completedAt/finalOutcome on a reverse
        // transition so the instance never reads as terminal while active — and
        // so a reopened instance reappears in `workflow_instances_state_idx`
        // (the `WHERE completed_at IS NULL` partial index reconciliation scans).
        .set({
          currentState: targetStatus,
          completedAt: isTerminal ? now : null,
          finalOutcome: isTerminal ? (TERMINAL_OUTCOME[targetStatus] ?? null) : null,
        })
        .where(eq(workflowInstances.id, workflow.id)),
      workflowTransitionInsert(db, workflowEntry),
      auditInsert(db, auditEntry),
    ];
    await db.batch(stmts as BatchTuple);

    // Best-effort §26.5 forwards AFTER the atomic commit.
    c.executionCtx.waitUntil(
      Promise.all([
        forwardAuditLog(auditEntry, makeAuditForwarder(c)),
        forwardWorkflowTransition(workflowEntry, makeWorkflowForwarder(c)),
      ]),
    );

    return ack(true, `${currentStatus}→${targetStatus}`);
  };
}
