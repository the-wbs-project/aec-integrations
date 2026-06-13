/**
 * Vendor-request endpoints (AECI-128) — the claim & correction submission forms.
 *
 *   POST /api/requests/correction     — insert a `kind:'correction'` row.
 *   POST /api/requests/claim          — insert a `kind:'claim'` row.
 *
 * Contracts: `CorrectionRequestSchema` / `ClaimRequestSchema` from `@aeci/shared`.
 * Rows land in the existing `vendor_requests` table (Phase 2 Spec §5.1) with
 * `status:'open'` and `linear_issue_id:null`.
 *
 * Scope: AECI-128 added the thin, real backend behind the first Signal Forms
 * forms. AECI-209 (Phase 6.2) adds **lean workflow tracking** — each submit now
 * also opens a `workflow_instance` (`vendor_claim` | `correction_request`,
 * `current_state:'open'`, `linear_issue_id` left null for Phase 6.4) and records
 * its genesis `workflow_transitions` row (`null → open`). AECI-215 (Phase 6.8)
 * computes two **informational** signals at submit time (never automating
 * approval): `domain_match` — submitter-email vs target-vendor-website registrable
 * domain (`lib/domain-match.ts`) — and a duplicate pointer (`duplicate_of_request_id`,
 * §7.2). Both persist on the row and feed the Linear issue (`domain-check-pending`
 * label on a mismatch; a note on a duplicate). The rest of the Phase 6 moderation
 * pipeline — bidirectional sync (6.3/6.5), admin views, rate limiting — remains
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
import { computeDomainMatch } from '../lib/domain-match';
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
    // `unknown` (not `boolean`) so a product's nested `productVendors` select fits.
    select?: Record<string, unknown>;
  }): Promise<Row | null>;
};

type RequestsClient = {
  product: FindUniqueDelegate;
  vendor: FindUniqueDelegate;
  // Top-level (outside the tx) read for the §7.2 duplicate probe.
  vendorRequest: {
    findFirst(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, unknown>;
      select?: Record<string, unknown>;
    }): Promise<Row | null>;
  };
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
): Promise<{ id: string; name: string; websiteUrl: string | null }> {
  // The domain-match check (§7.1) compares against the *target vendor's* website.
  // For a vendor target that's the vendor's own `website`; for a product target it's
  // the product's PRIMARY vendor (via `product_vendors.is_primary`) — not the
  // product's own `website` field. A product with no primary vendor → null → the
  // caller resolves `manual_review`.
  if (targetType === 'product') {
    const row = await prisma.product.findUnique({
      where: { slug },
      select: {
        id: true,
        name: true,
        productVendors: {
          where: { isPrimary: true },
          take: 1,
          select: { vendor: { select: { website: true } } },
        },
      },
    });
    if (!row) throw notFoundError('product', { slug });
    const primary = (
      row.productVendors as Array<{ vendor: { website: string | null } | null }> | undefined
    )?.[0];
    return { id: row.id, name: row.name as string, websiteUrl: primary?.vendor?.website ?? null };
  }

  const row = await prisma.vendor.findUnique({
    where: { slug },
    select: { id: true, companyName: true, website: true },
  });
  if (!row) throw notFoundError('vendor', { slug });
  return {
    id: row.id,
    name: row.companyName as string,
    websiteUrl: (row.website as string | null) ?? null,
  };
}

/**
 * Duplicate probe (§7.2 / §23.2): an existing `open` request for the same target
 * (`target_type`+`target_id`) that shares this submit's `kind` OR `submitter_email`.
 * Returns the EARLIEST match (the "original") — the row we point `duplicate_of_request_id`
 * at and reference in the Linear note — or `null`. **Informational only**; vendor
 * requests flag duplicates (they're sometimes legitimate), they never block.
 */
async function detectDuplicate(
  prisma: RequestsClient,
  args: {
    kind: RequestKind;
    targetType: RequestTargetType;
    targetId: string;
    submitterEmail: string;
  },
): Promise<{ id: string; linearIssueId: string | null } | null> {
  const row = await prisma.vendorRequest.findFirst({
    where: {
      status: 'open',
      targetType: args.targetType,
      targetId: args.targetId,
      OR: [{ kind: args.kind }, { submitterEmail: args.submitterEmail }],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, linearIssueId: true },
  });
  if (!row) return null;
  return { id: row.id, linearIssueId: (row.linearIssueId as string | null) ?? null };
}

interface RequestInsert {
  targetType: RequestTargetType;
  /** Resolved by `resolveTarget`; the row's `target_id`. */
  targetId: string;
  /** Target display name — Linear issue title only, never stored on the row. */
  targetName: string;
  /** Carried into the audit metadata for traceability. */
  slug: string;
  /** Target vendor's website — input to the domain-match check; never stored. */
  websiteUrl: string | null;
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

  // Phase 6.8 (AECI-215): compute the two informational signals BEFORE the insert —
  // so the row persists the real `domain_match` (not the `'pending'` default) and the
  // duplicate probe never self-matches the row we're about to create. Both are hints
  // for the admin; neither gates the submit.
  const domainMatch = computeDomainMatch(insert.submitterEmail, insert.websiteUrl);
  const duplicate = await detectDuplicate(prisma, {
    kind,
    targetType: insert.targetType,
    targetId: insert.targetId,
    submitterEmail: insert.submitterEmail,
  });

  // `slug`/`targetName` are metadata/title only; `websiteUrl` is a domain-match input.
  // None are columns, so they're stripped before the insert.
  const { slug, targetName, websiteUrl: _websiteUrl, ...row_data } = insert;
  // Shared metadata for the audit row and the genesis workflow transition.
  const metadata = {
    source: 'request-form',
    kind,
    target_type: insert.targetType,
    target_id: insert.targetId,
    slug,
    domain_match: domainMatch,
    duplicate_of_request_id: duplicate?.id ?? null,
  };
  const created = await prisma.$transaction(async (tx) => {
    // `status` ('open') / `linearIssueId` (null) take their column defaults; the
    // Phase 6 pipeline owns the latter. `domainMatch` + `duplicateOfRequestId` carry
    // the just-computed signals.
    const row = await tx.vendorRequest.create({
      data: { kind, ...row_data, domainMatch, duplicateOfRequestId: duplicate?.id ?? null },
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
      // Phase 6.8 signals: `domainMatch:'no_match'` adds the `domain-check-pending`
      // label; a duplicate adds an informational note on the issue (§7.1/§7.2).
      domainMatch,
      duplicateOfRequestId: duplicate?.id ?? null,
      duplicateLinearIssueId: duplicate?.linearIssueId ?? null,
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
      websiteUrl: target.websiteUrl,
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
      websiteUrl: target.websiteUrl,
      submitterEmail: payload.submitter_email,
      submitterName: payload.submitter_name,
      submitterRole: payload.submitter_role,
      body: payload.body,
      sourceUrl: null,
    });
  };
}
