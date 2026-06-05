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
 * Scope (AECI-128): this is the thin, real backend behind the first Signal Forms
 * forms. Duplicate detection and the rest of the Phase 6 moderation pipeline —
 * n8n webhook, Linear issue creation + bidirectional sync, `workflow_transitions`,
 * admin views, Slack alerts, rate limiting, domain-match logic — are **out of
 * scope**. Rows sit `open` for that pipeline to pick up and de-duplicate.
 *
 * Every insert writes an `audit_log` row in the same transaction
 * (`appendAuditLog`, CLAUDE.md / Stage 1 Spec §26.1 — failure rolls back). The
 * write pattern mirrors `routes/promote.ts`; the loose structural client type
 * follows the same decoupling rationale documented there.
 */

import {
  ClaimRequestSchema,
  CorrectionRequestSchema,
  type RequestKind,
  type RequestSubmitResponse,
  type RequestTargetType,
} from '@aeci/shared';
import { appendAuditLog, type AuditLogForwarder } from '@aeci/shared/audit-log';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { logToDatadog } from '../datadog';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
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
 * Resolve a `(target_type, slug)` pair to the entity's UUID. The form addresses
 * its target by slug (it never holds a UUID), and `vendor_requests.target_id`
 * has no FK (the table is loose-polymorphic), so resolving here both yields the
 * id and guards against orphan rows. A missing target → canonical 404, which the
 * form surfaces.
 */
async function resolveTargetId(
  prisma: RequestsClient,
  targetType: RequestTargetType,
  slug: string,
): Promise<string> {
  const delegate = targetType === 'product' ? prisma.product : prisma.vendor;
  const row = await delegate.findUnique({ where: { slug }, select: { id: true } });
  if (!row) throw notFoundError(targetType, { slug });
  return row.id;
}

interface RequestInsert {
  targetType: RequestTargetType;
  /** Resolved by `resolveTargetId`; the row's `target_id`. */
  targetId: string;
  /** Carried into the audit metadata for traceability. */
  slug: string;
  submitterEmail: string;
  submitterName: string | null;
  submitterRole: string | null;
  body: string;
  sourceUrl: string | null;
}

/** Insert the row + its audit entry in one transaction; return the 201 envelope. */
async function createRequest(
  c: Context<{ Bindings: Env }>,
  prisma: RequestsClient,
  kind: RequestKind,
  insert: RequestInsert,
): Promise<Response> {
  const forward = makeForwarder(c);

  const { slug, ...row_data } = insert;
  const created = await prisma.$transaction(async (tx) => {
    // `status` ('open'), `domainMatch` ('pending'), `linearIssueId` (null) take
    // their column defaults — the Phase 6 pipeline owns them. `slug` is metadata
    // only (the row stores `targetId`), so it's excluded from the insert above.
    const row = await tx.vendorRequest.create({
      data: { kind, ...row_data },
      select: { id: true },
    });
    await appendAuditLog(
      tx,
      {
        actorType: 'user',
        action: 'vendor_request.created',
        entityType: 'vendor_request',
        entityId: row.id,
        metadata: {
          source: 'request-form',
          kind,
          target_type: insert.targetType,
          target_id: insert.targetId,
          slug,
        },
      },
      forward,
    );
    return row;
  });

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
    const targetId = await resolveTargetId(prisma, payload.target_type, payload.slug);

    return createRequest(c, prisma, 'correction', {
      targetType: payload.target_type,
      targetId,
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
    const targetId = await resolveTargetId(prisma, payload.target_type, payload.slug);

    return createRequest(c, prisma, 'claim', {
      targetType: payload.target_type,
      targetId,
      slug: payload.slug,
      submitterEmail: payload.submitter_email,
      submitterName: payload.submitter_name,
      submitterRole: payload.submitter_role,
      body: payload.body,
      sourceUrl: null,
    });
  };
}
