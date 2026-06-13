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
 * The handler reads the raw body once (the HMAC is over the exact bytes) and the
 * loose structural Prisma client type follows the `routes/requests.ts` /
 * `routes/promote.ts` rationale.
 */

import { ApiErrorCode, LinearWebhookSchema, type LinearWebhook } from '@aeci/shared';
import { appendAuditLog, type AuditLogForwarder } from '@aeci/shared/audit-log';
import {
  appendWorkflowTransition,
  type WorkflowTransitionForwarder,
} from '@aeci/shared/workflow-transition';
import type { Context } from 'hono';

import { logToDatadog, submitCount } from '../datadog';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { json } from '../http';
import type { PrismaFactory } from '../lib/handler-utils';
import { verifyLinearSignature } from '../lib/linear-webhook-auth';
import { getPrisma } from '../prisma';

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

// ─── Loose structural Prisma surface ─────────────────────────────────────────
// Same approach as `routes/requests.ts`: type only the slice we touch and
// `as unknown as` the real/fake client onto it.
type Row = { id: string } & Record<string, unknown>;

type WebhookTx = {
  vendorRequest: {
    update(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<unknown>;
  };
  workflowInstance: {
    update(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<unknown>;
  };
  workflowTransition: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
  auditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
};

type WebhookClient = {
  workflowInstance: {
    findFirst(args: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
    }): Promise<Row | null>;
  };
  vendorRequest: {
    findUnique(args: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
    }): Promise<Row | null>;
  };
  $transaction<T>(fn: (tx: WebhookTx) => Promise<T>): Promise<T>;
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
  prismaFor: PrismaFactory = getPrisma,
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

    const prisma = prismaFor(c.env) as unknown as WebhookClient;

    // 4. Resolve the vendor request behind this Linear issue. The instance's
    //    linear_issue_id is Linear's issue node id (= data.id). Unknown → no-op.
    const workflow = await prisma.workflowInstance.findFirst({
      where: {
        linearIssueId: payload.data.id,
        workflowType: { in: ['vendor_claim', 'correction_request'] },
      },
      select: { id: true, entityId: true, currentState: true },
    });
    if (!workflow) return ack(false, 'unknown issue');

    const request = await prisma.vendorRequest.findUnique({
      where: { id: workflow.entityId as string },
      select: { id: true, status: true },
    });
    if (!request) return ack(false, 'request not found'); // defensive: orphaned instance

    const currentStatus = request.status as VendorRequestStatus;
    if (currentStatus === targetStatus) return ack(false, 'already in sync');

    // 5. Apply: status + instance mirror + transition + audit, atomically.
    const auditForward = makeAuditForwarder(c);
    const workflowForward = makeWorkflowForwarder(c);
    const isTerminal = targetStatus === 'resolved' || targetStatus === 'rejected';
    const now = new Date();
    const metadata = {
      source: 'linear-webhook',
      actor_type: 'workflow',
      linear_action: payload.action,
      linear_issue_id: payload.data.id,
      linear_state_name: payload.data.state.name,
      linear_state_type: payload.data.state.type,
      linear_url: payload.url,
    };

    await prisma.$transaction(async (tx) => {
      await tx.vendorRequest.update({
        where: { id: request.id },
        // resolvedById stays null — the actor is the workflow, not a profile.
        // resolvedAt is set/cleared unconditionally so a reverse transition (an
        // admin reopening a resolved/rejected issue in Linear → a non-terminal
        // status) doesn't leave a stale resolution time on an active row.
        data: { status: targetStatus, resolvedAt: isTerminal ? now : null },
      });

      await tx.workflowInstance.update({
        where: { id: workflow.id },
        // Mirror the request: clear completedAt/finalOutcome on a reverse
        // transition so the instance never reads as terminal while active — and
        // so a reopened instance reappears in `workflow_instances_state_idx`
        // (the `WHERE completed_at IS NULL` partial index reconciliation scans).
        data: {
          currentState: targetStatus,
          completedAt: isTerminal ? now : null,
          finalOutcome: isTerminal ? TERMINAL_OUTCOME[targetStatus] : null,
        },
      });

      await appendWorkflowTransition(
        tx,
        {
          workflowId: workflow.id,
          fromState: currentStatus,
          toState: targetStatus,
          actorId: null,
          reason: 'linear webhook',
          metadata,
        },
        workflowForward,
      );

      await appendAuditLog(
        tx,
        {
          actorType: 'workflow',
          action: 'vendor_request.status_changed',
          entityType: 'vendor_request',
          entityId: request.id,
          beforeState: { status: currentStatus },
          afterState: { status: targetStatus },
          metadata,
        },
        auditForward,
      );
    });

    return ack(true, `${currentStatus}→${targetStatus}`);
  };
}
