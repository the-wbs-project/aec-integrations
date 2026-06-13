/**
 * Admin requests moderation API (AECI-216 / Phase 6.9) — the vendor
 * claim/correction read + action surface behind `requireAdmin()`:
 *
 *   GET   /api/admin/requests     — the requests queue, filtered by kind/status,
 *                                    paginated.
 *   PATCH /api/admin/requests/:id — resolve / reject an open (or in-review) request.
 *
 * Source of truth: `docs/API_CONTRACTS.md` §6.10, `STAGE_1_PHASE_6_SPEC.md` §8.1.
 * The shape mirrors the Phase 5 admin-reviews endpoint (`routes/admin-reviews.ts`)
 * for the list + PATCH structure, and the inbound Linear webhook
 * (`routes/webhooks.ts`) for the exact status-change transaction (status +
 * workflow instance mirror + transition + audit, with before/after state and a
 * terminal-outcome map).
 *
 * On resolve/reject: set `status` + `resolved_by`/`resolved_at`, append an
 * `audit_log` + a `workflow_transitions` row (`open|in_review → resolved|rejected`)
 * and update the workflow instance — all in one transaction (CLAUDE.md / §26.1:
 * every state-changing write logs; failure rolls back). Then fire the
 * **site → Linear sync** (§6.5) post-commit as an injectable, best-effort seam:
 * its GraphQL internals are owned by AECI-213 (out of scope here) — the default
 * is a safe no-op.
 *
 * `is_duplicate` (Phase 6 Spec §7.2) has no column — it's computed at read time:
 * an OPEN sibling request sharing the same `(kind, target_type, target_id)` or
 * `(submitter_email, target_type, target_id)`. Two indexed `groupBy` aggregations
 * over `status='open'` build the lookup, so there's no per-row N+1. Informational
 * only — never auto-rejects.
 *
 * No cache invalidation: `vendor_requests` are admin-only and render on no
 * cacheable SSR page, so there's no `Cache-Tag` to purge.
 *
 * The loose structural Prisma client types follow the `routes/admin-reviews.ts` /
 * `routes/webhooks.ts` rationale: we touch a known slice of the generated client,
 * so we type it structurally and `as unknown as` it rather than dragging in the
 * full edge-client generics. A real accelerated client and the test fakes both
 * satisfy these.
 */

import {
  ApiErrorCode,
  AdminVendorRequestSchema,
  ListVendorRequestsQuerySchema,
  ListVendorRequestsResponseSchema,
  ModerateRequestSchema,
  type ListVendorRequestsResponse,
  type ModerateRequestResponse,
} from '@aeci/shared';
import {
  appendAuditLog,
  type AuditLogClient,
  type AuditLogForwarder,
} from '@aeci/shared/audit-log';
import {
  appendWorkflowTransition,
  type WorkflowTransitionClient,
  type WorkflowTransitionForwarder,
} from '@aeci/shared/workflow-transition';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { logToDatadog, submitCount } from '../datadog';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { validateResponseInDev, type PrismaFactory } from '../lib/handler-utils';
import {
  adminVendorRequestSelect,
  toAdminVendorRequest,
  type RawAdminVendorRequestRow,
} from '../lib/prisma-helpers';
import { getPrisma } from '../prisma';
import type { AcceleratedPrisma } from '../prisma';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** `workflow_instances.final_outcome` for the terminal statuses (§26.2), mirroring
 *  `routes/webhooks.ts`. */
const TERMINAL_OUTCOME: Record<'resolved' | 'rejected', string> = {
  resolved: 'completed',
  rejected: 'rejected',
};

// ─── Loose structural Prisma surfaces ────────────────────────────────────────

/** One `groupBy` bucket. `kind` xor `submitterEmail` is present depending on the
 *  `by` tuple; both share `(targetType, targetId)` + the `_all` count. */
type VendorRequestGroupRow = {
  kind?: string;
  submitterEmail?: string;
  targetType: string;
  targetId: string;
  _count: { _all: number };
};

/** Read surface for `GET /api/admin/requests`: the paginated `findMany` + `count`,
 *  plus the two `groupBy` aggregations the duplicate flag derives from. */
type AdminRequestsClient = {
  vendorRequest: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy: unknown;
      skip: number;
      take: number;
      select: typeof adminVendorRequestSelect;
    }): Promise<RawAdminVendorRequestRow[]>;
    count(args: { where: Record<string, unknown> }): Promise<number>;
    groupBy(args: {
      by: readonly string[];
      where: Record<string, unknown>;
      _count: { _all: true };
    }): Promise<VendorRequestGroupRow[]>;
  };
};

type WorkflowRow = { id: string };

/** Transaction surface for the moderate write: the guarded `updateMany`, plus the
 *  audit (`AuditLogClient`) and workflow (`WorkflowTransitionClient` + the
 *  `workflowInstance` find-or-create/update) surfaces. */
type ModerateRequestTx = {
  vendorRequest: {
    updateMany(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
  workflowInstance: {
    findFirst(args: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
    }): Promise<WorkflowRow | null>;
    create(args: {
      data: Record<string, unknown>;
      select?: Record<string, boolean>;
    }): Promise<WorkflowRow>;
    update(args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }): Promise<unknown>;
  };
} & AuditLogClient &
  WorkflowTransitionClient;

/** Read + transaction surface for `PATCH /api/admin/requests/:id`. The single
 *  `findUnique` selects the full `adminVendorRequestSelect`, so the preloaded row
 *  both gates the transition (status) and builds the response (no post-commit
 *  re-read). */
type ModerateRequestClient = {
  vendorRequest: {
    findUnique(args: {
      where: { id: string };
      select: typeof adminVendorRequestSelect;
    }): Promise<RawAdminVendorRequestRow | null>;
  };
  $transaction<T>(fn: (tx: ModerateRequestTx) => Promise<T>): Promise<T>;
};

/**
 * Site → Linear sync seam (§6.5 / AECI-213). Invoked post-commit after a
 * resolve/reject so Linear and Supabase stay consistent. The GraphQL internals
 * are owned by AECI-213; the default here is a safe no-op so this endpoint ships
 * standalone. Best-effort — tolerant of a null `linearIssueId` (issue never
 * created); failures are the sync's concern, never surfaced to the admin.
 */
export type SyncRequestToLinear = (
  c: AdminContext,
  prisma: AcceleratedPrisma,
  args: {
    requestId: string;
    status: 'resolved' | 'rejected';
    reason: string | null;
    linearIssueId: string | null;
  },
) => Promise<void>;

const noopSyncToLinear: SyncRequestToLinear = async () => {};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Datadog forwarder for the audit write; no-op without `DD_API_KEY`. Mirrors
 *  `routes/admin-reviews.ts`, tagged `source: admin-moderation`. */
function makeForwarder(c: AdminContext): AuditLogForwarder | undefined {
  if (!c.env.DD_API_KEY) return undefined;
  return (entry) => {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source: 'admin-moderation',
    });
  };
}

/** Datadog forwarder for the workflow-transition write; no-op without
 *  `DD_API_KEY`. Mirrors `makeForwarder`, tagged `source: admin-moderation`. */
function makeWorkflowForwarder(c: AdminContext): WorkflowTransitionForwarder | undefined {
  if (!c.env.DD_API_KEY) return undefined;
  return (entry) => {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `workflow ${entry.fromState ?? '∅'}→${entry.toState} ${entry.workflowId}`.trim(),
      from_state: entry.fromState ?? undefined,
      to_state: entry.toState,
      workflow_id: entry.workflowId,
      source: 'admin-moderation',
    });
  };
}

async function parseJsonBody<T>(c: AdminContext, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  // ZodError bubbles to `errorHandler()` → canonical VALIDATION_FAILED envelope.
  return schema.parse(raw);
}

/** Emit the `aeci.request.moderation.action` count — one per moderation attempt:
 *  `outcome:ok` on a committed resolve/reject, `outcome:invalid_state` when the
 *  target isn't open/in-review (the preload guard or the concurrent-race guard,
 *  both 422). Fire-and-forget; no-op without `DD_API_KEY`. */
function emitRequestModeration(
  c: AdminContext,
  action: 'resolve' | 'reject',
  outcome: 'ok' | 'invalid_state',
): void {
  submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.request.moderation.action', 1, [
    `action:${action}`,
    `outcome:${outcome}`,
  ]);
}

/** Composite key for the duplicate-flag lookup maps. ` ` (NUL) can never
 *  appear in an email local-part or a UUID, so the parts can't run together. */
const DUP_SEP = ' ';
function dupKey(head: string, targetType: string, targetId: string): string {
  return `${head}${DUP_SEP}${targetType}${DUP_SEP}${targetId}`;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/** `GET /api/admin/requests` — the requests queue. */
export function createAdminRequestsListHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const query = ListVendorRequestsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const db = prismaFor(c.env) as unknown as AdminRequestsClient;

    const where: { status: string; kind?: string } = { status: query.status };
    if (query.kind) where.kind = query.kind;
    const skip = (query.page - 1) * query.perPage;

    // Two indexed groupBy aggregations over open requests drive `is_duplicate`
    // (Phase 6 Spec §7.2). Run alongside the page query; scoped to `status='open'`
    // (covered by `vendor_requests_status_idx`), so cost is independent of page
    // size — no per-row N+1.
    const [rows, total, kindGroups, emailGroups] = await Promise.all([
      db.vendorRequest.findMany({
        where,
        // Newest-first; `id` tiebreaks a `created_at` collision so pagination is
        // stable across pages (AECI-99). `as const` keeps the literal narrow.
        orderBy: [{ createdAt: 'desc' as const }, { id: 'asc' as const }],
        skip,
        take: query.perPage,
        select: adminVendorRequestSelect,
      }),
      db.vendorRequest.count({ where }),
      db.vendorRequest.groupBy({
        by: ['kind', 'targetType', 'targetId'],
        where: { status: 'open' },
        _count: { _all: true },
      }),
      db.vendorRequest.groupBy({
        by: ['submitterEmail', 'targetType', 'targetId'],
        where: { status: 'open' },
        _count: { _all: true },
      }),
    ]);

    const kindCounts = new Map<string, number>();
    for (const g of kindGroups) {
      if (g.kind === undefined) continue;
      kindCounts.set(dupKey(g.kind, g.targetType, g.targetId), g._count._all);
    }
    const emailCounts = new Map<string, number>();
    for (const g of emailGroups) {
      if (g.submitterEmail === undefined) continue;
      emailCounts.set(dupKey(g.submitterEmail, g.targetType, g.targetId), g._count._all);
    }

    // A row is a likely duplicate if an OPEN sibling shares its `(kind, target)`
    // or `(submitter_email, target)`. Subtract the row itself when it's in the
    // open set (open-view: threshold 2); a terminal row isn't in the set, so it's
    // flagged when ≥1 open sibling exists (threshold 1). The flag therefore always
    // reflects "an open sibling exists".
    const isDuplicate = (row: RawAdminVendorRequestRow): boolean => {
      const self = row.status === 'open' ? 1 : 0;
      const kc = kindCounts.get(dupKey(row.kind, row.targetType, row.targetId)) ?? 0;
      const ec = emailCounts.get(dupKey(row.submitterEmail, row.targetType, row.targetId)) ?? 0;
      return kc - self >= 1 || ec - self >= 1;
    };

    const body: ListVendorRequestsResponse = {
      data: rows.map((row) => toAdminVendorRequest(row, isDuplicate(row))),
      page: query.page,
      perPage: query.perPage,
      total,
    };

    validateResponseInDev(c.env, () => {
      ListVendorRequestsResponseSchema.parse(body);
    });

    return json(body);
  };
}

/** `PATCH /api/admin/requests/:id` — resolve / reject an open (or in-review)
 *  request. */
export function createModerateRequestHandler(
  prismaFor: PrismaFactory = getPrisma,
  syncToLinear: SyncRequestToLinear = noopSyncToLinear,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const { userId } = session;

    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing request id', { field: 'id' });
    }

    const payload = await parseJsonBody(c, ModerateRequestSchema);

    const prisma = prismaFor(c.env);
    const db = prisma as unknown as ModerateRequestClient;

    // Preload the full row: it both gates the transition (status) and builds the
    // response — the values we set ourselves are merged in after the commit, so
    // there's no post-commit re-read.
    const existing = await db.vendorRequest.findUnique({
      where: { id },
      select: adminVendorRequestSelect,
    });
    if (!existing) throw notFoundError('vendor_request', { id });
    if (existing.status === 'resolved' || existing.status === 'rejected') {
      emitRequestModeration(c, payload.action, 'invalid_state');
      throw new ApiError(
        422,
        ApiErrorCode.INVALID_STATE_TRANSITION,
        `Request is ${existing.status}; only open or in-review requests can be moderated.`,
      );
    }

    const newStatus: 'resolved' | 'rejected' =
      payload.action === 'resolve' ? 'resolved' : 'rejected';
    // No DB column for the reason — it's recorded in the transition + audit only.
    const reason = payload.reason?.trim() ? payload.reason.trim() : null;
    const resolvedAt = new Date();
    const fromState = existing.status; // 'open' | 'in_review' — the real prior state.
    const workflowType = existing.kind === 'claim' ? 'vendor_claim' : 'correction_request';
    const forward = makeForwarder(c);
    const workflowForward = makeWorkflowForwarder(c);
    const metadata = {
      source: 'admin-moderation',
      kind: existing.kind,
      target_type: existing.targetType,
      target_id: existing.targetId,
      ...(reason ? { reason } : {}),
    };

    await db.$transaction(async (tx) => {
      // Atomic guard: only transition a still-open/in-review row. If a concurrent
      // action already moved it (or Linear did via the webhook), `count` is 0 →
      // 422 (rolls back) — closes the racing window the preload check can't.
      const updated = await tx.vendorRequest.updateMany({
        where: { id, status: { in: ['open', 'in_review'] } },
        data: { status: newStatus, resolvedById: userId, resolvedAt },
      });
      if (updated.count !== 1) {
        emitRequestModeration(c, payload.action, 'invalid_state');
        throw new ApiError(
          422,
          ApiErrorCode.INVALID_STATE_TRANSITION,
          'Request is no longer open.',
        );
      }

      await appendAuditLog(
        tx,
        {
          actorId: userId,
          actorType: auditActorType(session),
          action:
            payload.action === 'resolve' ? 'vendor_request.resolved' : 'vendor_request.rejected',
          entityType: 'vendor_request',
          entityId: id,
          beforeState: { status: fromState },
          afterState: { status: newStatus },
          metadata,
        },
        forward,
      );

      // Record the moderation in the shared workflow history. Find-or-create the
      // request's `vendor_claim`/`correction_request` instance (defensive — the
      // submit path creates it, but mirror admin-reviews' resilience), append the
      // transition, then mark the instance complete (`current_state` keeps
      // mirroring `vendor_requests.status`). Same tx → rolls back with the write.
      let workflow = await tx.workflowInstance.findFirst({
        where: { workflowType, entityId: id },
        select: { id: true },
      });
      workflow ??= await tx.workflowInstance.create({
        data: { workflowType, entityId: id, currentState: fromState },
        select: { id: true },
      });
      await appendWorkflowTransition(
        tx,
        {
          workflowId: workflow.id,
          fromState,
          toState: newStatus,
          actorId: userId,
          reason,
          metadata,
        },
        workflowForward,
      );
      await tx.workflowInstance.update({
        where: { id: workflow.id },
        data: {
          currentState: newStatus,
          completedAt: resolvedAt,
          finalOutcome: TERMINAL_OUTCOME[newStatus],
        },
      });
    });

    // Committed: one `aeci.request.moderation.action{outcome:ok}` per resolve/reject.
    emitRequestModeration(c, payload.action, 'ok');

    // Post-commit, best-effort site → Linear sync (§6.5 / AECI-213 owns the
    // GraphQL internals). Never blocks/throws here; a failure is logged, not
    // surfaced. Tolerant of a null `linearIssueId` (issue never created).
    c.executionCtx.waitUntil(
      syncToLinear(c, prisma, {
        requestId: id,
        status: newStatus,
        reason,
        linearIssueId: existing.linearIssueId,
      }).catch((error) => {
        try {
          logToDatadog(c.executionCtx, c.env, c.req.raw, {
            level: 'warn',
            message: `request→Linear sync failed for ${id}`,
            error: error instanceof Error ? error.message : String(error),
          });
        } catch {
          console.warn('admin-requests: request→Linear sync failed', error);
        }
      }),
    );

    // Build the response from the preloaded row + the values we just committed.
    // `is_duplicate` is `false` on the single-row confirmation (the dashboard
    // re-fetches the list, which recomputes it).
    const body: ModerateRequestResponse = toAdminVendorRequest(
      { ...existing, status: newStatus, resolvedById: userId, resolvedAt },
      false,
    );

    validateResponseInDev(c.env, () => {
      AdminVendorRequestSchema.parse(body);
    });

    return json(body);
  };
}
