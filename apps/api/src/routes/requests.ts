/**
 * Vendor-request endpoints (AECI-128) — the claim & correction submission forms.
 *
 *   POST /api/requests/correction     — insert a `kind:'correction'` row.
 *   POST /api/requests/claim          — insert a `kind:'claim'` row.
 *
 * Contracts: `CorrectionRequestSchema` / `ClaimRequestSchema` from `@aeci/shared`.
 * Rows land in the existing `vendor_requests` table (Phase 2 Spec §5.1) with
 * `status:'open'`, `domain_match:'pending'`, `linear_issue_id:null`.
 *
 * Scope: AECI-128 added the thin, real backend behind the first Signal Forms
 * forms. AECI-209 (Phase 6.2) adds **lean workflow tracking** — each submit now
 * also opens a `workflow_instance` (`vendor_claim` | `correction_request`,
 * `current_state:'open'`, `linear_issue_id` left null for Phase 6.4) and records
 * its genesis `workflow_transitions` row (`null → open`). The rest of the Phase 6
 * moderation pipeline — Linear issue creation + bidirectional sync (6.3/6.4/6.5),
 * duplicate detection, admin views, rate limiting, domain-match logic — remains
 * **out of scope**. Rows sit `open` for that pipeline to pick up.
 *
 * Every insert writes an `audit_log` row AND opens its workflow instance +
 * genesis transition in the same transaction (`appendAuditLog` /
 * `appendWorkflowTransition`, CLAUDE.md / Stage 1 Spec §26.1, §26.2 — failure
 * rolls back). The write pattern mirrors `routes/promote.ts`; the loose
 * structural client type follows the same decoupling rationale documented there.
 */

import {
  ClaimRequestSchema,
  CorrectionRequestSchema,
  type RequestKind,
  type RequestSubmitResponse,
  type RequestTargetType,
} from '@aeci/shared';
import { appendAuditLog, type AuditLogForwarder } from '@aeci/shared/audit-log';
import {
  appendWorkflowTransition,
  type WorkflowTransitionForwarder,
} from '@aeci/shared/workflow-transition';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { logToDatadog } from '../datadog';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { createLinearIssueForRequest, type LinearPersistClient } from '../lib/linear';
import type { PrismaFactory } from '../lib/handler-utils';
import { getPrisma } from '../prisma';

// ─── Loose structural Prisma surface ─────────────────────────────────────────
// Same approach as `routes/promote.ts`: we touch a small, known slice of the
// generated client, so we type it structurally and `as unknown as` it rather
// than dragging in the full edge-client generated types. A real accelerated
// client and the test fake both satisfy this.
type Row = { id: string } & Record<string, unknown>;

type RequestsTx = {
  vendorRequest: {
    create(args: { data: Record<string, unknown>; select?: Record<string, boolean> }): Promise<Row>;
  };
  workflowInstance: {
    create(args: { data: Record<string, unknown>; select?: Record<string, boolean> }): Promise<Row>;
  };
  workflowTransition: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
  auditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
};

type FindUniqueDelegate = {
  findUnique(args: {
    where: Record<string, unknown>;
    select?: Record<string, boolean>;
  }): Promise<Row | null>;
};

type RequestsClient = {
  product: FindUniqueDelegate;
  vendor: FindUniqueDelegate;
  $transaction<T>(fn: (tx: RequestsTx) => Promise<T>): Promise<T>;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Datadog forwarder for the audit write; no-op without `DD_API_KEY`. Mirrors
 *  the `routes/promote.ts` forwarder, tagged `source: request-form`. */
function makeForwarder(c: Context<{ Bindings: Env }>): AuditLogForwarder | undefined {
  if (!c.env.DD_API_KEY) return undefined;
  return (entry) => {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source: 'request-form',
    });
  };
}

/** Datadog forwarder for the workflow-transition write; no-op without
 *  `DD_API_KEY`. Mirrors `makeForwarder`, tagged `source: request-form`. */
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
      source: 'request-form',
    });
  };
}

async function parseJsonBody<T>(c: Context<{ Bindings: Env }>, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  // ZodError bubbles to `errorHandler()` → canonical VALIDATION_FAILED envelope.
  return schema.parse(raw);
}

/**
 * Resolve a `(target_type, slug)` pair to the entity's UUID **and** display name.
 * The form addresses its target by slug (it never holds a UUID), and
 * `vendor_requests.target_id` has no FK (the table is loose-polymorphic), so
 * resolving here both yields the id and guards against orphan rows. A missing
 * target → canonical 404, which the form surfaces. The name is for the Linear
 * issue title only (not stored on the row); products carry `name`, vendors
 * `company_name`, so we normalise per type.
 */
async function resolveTarget(
  prisma: RequestsClient,
  targetType: RequestTargetType,
  slug: string,
): Promise<{ id: string; name: string }> {
  const delegate = targetType === 'product' ? prisma.product : prisma.vendor;
  const select: Record<string, boolean> =
    targetType === 'product' ? { id: true, name: true } : { id: true, companyName: true };
  const row = await delegate.findUnique({ where: { slug }, select });
  if (!row) throw notFoundError(targetType, { slug });
  const name = (targetType === 'product' ? row.name : row.companyName) as string;
  return { id: row.id, name };
}

interface RequestInsert {
  targetType: RequestTargetType;
  /** Resolved by `resolveTarget`; the row's `target_id`. */
  targetId: string;
  /** Target display name — Linear issue title only, never stored on the row. */
  targetName: string;
  /** Carried into the audit metadata for traceability. */
  slug: string;
  submitterEmail: string;
  submitterName: string | null;
  submitterRole: string | null;
  body: string;
  sourceUrl: string | null;
}

/** Insert the row + open its workflow instance/genesis transition + write the
 *  audit entry, all in one transaction; return the 201 envelope. */
async function createRequest(
  c: Context<{ Bindings: Env }>,
  prisma: RequestsClient,
  kind: RequestKind,
  insert: RequestInsert,
): Promise<Response> {
  const forward = makeForwarder(c);
  const workflowForward = makeWorkflowForwarder(c);

  const { slug, targetName, ...row_data } = insert;
  // Shared metadata for the audit row and the genesis workflow transition.
  const metadata = {
    source: 'request-form',
    kind,
    target_type: insert.targetType,
    target_id: insert.targetId,
    slug,
  };
  const created = await prisma.$transaction(async (tx) => {
    // `status` ('open'), `domainMatch` ('pending'), `linearIssueId` (null) take
    // their column defaults — the Phase 6 pipeline owns them. `slug`/`targetName`
    // are metadata/title only (the row stores `targetId`), so they're excluded
    // from the insert above.
    const row = await tx.vendorRequest.create({
      data: { kind, ...row_data },
      select: { id: true },
    });

    // Phase 6.2 (AECI-209): open the workflow instance whose `current_state`
    // mirrors the request `status`, then record the genesis transition. Lean —
    // no guarded FSM (Stage-1 §26.3 relaxation). `linearIssueId` stays null (the
    // slot Phase 6.4 fills below); `initiatedBy` null because submit is anonymous.
    const workflow = await tx.workflowInstance.create({
      data: {
        workflowType: kind === 'claim' ? 'vendor_claim' : 'correction_request',
        entityId: row.id,
        currentState: 'open',
      },
      select: { id: true },
    });
    await appendWorkflowTransition(
      tx,
      {
        workflowId: workflow.id,
        fromState: null,
        toState: 'open',
        reason: 'request submitted',
        metadata,
      },
      workflowForward,
    );

    await appendAuditLog(
      tx,
      {
        actorType: 'user',
        action: 'vendor_request.created',
        entityType: 'vendor_request',
        entityId: row.id,
        metadata,
      },
      forward,
    );
    // Thread the workflow id out so the Phase 6.4 background task can link the
    // Linear issue back onto the instance by PK.
    return { id: row.id, workflowId: workflow.id };
  });

  // Phase 6.4 (AECI-211): create the Linear issue out-of-band so it never blocks
  // the 201. `createLinearIssueForRequest` never throws (it logs + meters every
  // failure and leaves the row `open`/`linear_issue_id=null` for the §6.7
  // reconciliation sweep), so `waitUntil` never sees a rejection.
  c.executionCtx.waitUntil(
    createLinearIssueForRequest(c, prisma as unknown as LinearPersistClient, {
      requestId: created.id,
      workflowId: created.workflowId,
      kind,
      targetType: insert.targetType,
      targetName,
      slug,
      submitterEmail: insert.submitterEmail,
      submitterName: insert.submitterName,
      submitterRole: insert.submitterRole,
      body: insert.body,
      sourceUrl: insert.sourceUrl,
      // domainMatch omitted — 6.8 computes it; until then the row default
      // ('pending') means no `domain-check-pending` label fires.
    }),
  );

  const body: RequestSubmitResponse = {
    request_id: created.id,
    message:
      kind === 'claim'
        ? 'Your claim has been received. We will review it and follow up by email.'
        : 'Your correction has been received. We will review it and follow up by email.',
  };
  return json(body, { status: 201 });
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export function createCorrectionSubmitHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const payload = await parseJsonBody(c, CorrectionRequestSchema);
    const prisma = prismaFor(c.env) as unknown as RequestsClient;
    const target = await resolveTarget(prisma, payload.target_type, payload.slug);

    return createRequest(c, prisma, 'correction', {
      targetType: payload.target_type,
      targetId: target.id,
      targetName: target.name,
      slug: payload.slug,
      submitterEmail: payload.submitter_email,
      submitterName: null,
      submitterRole: null,
      body: payload.body,
      sourceUrl: payload.source_url ? payload.source_url : null,
    });
  };
}

export function createClaimSubmitHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const payload = await parseJsonBody(c, ClaimRequestSchema);
    const prisma = prismaFor(c.env) as unknown as RequestsClient;
    const target = await resolveTarget(prisma, payload.target_type, payload.slug);

    return createRequest(c, prisma, 'claim', {
      targetType: payload.target_type,
      targetId: target.id,
      targetName: target.name,
      slug: payload.slug,
      submitterEmail: payload.submitter_email,
      submitterName: payload.submitter_name,
      submitterRole: payload.submitter_role,
      body: payload.body,
      sourceUrl: null,
    });
  };
}
