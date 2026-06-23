/**
 * Admin requests moderation API (AECI-216 / Phase 6.9) — Drizzle/D1 (ADR 0016 /
 * AECI-253, AECI-254). The vendor claim/correction read + action surface behind
 * `requireAdmin()`:
 *
 *   GET   /api/admin/requests     — the requests queue, filtered by kind/status,
 *                                    paginated.
 *   PATCH /api/admin/requests/:id — resolve / reject an open (or in-review) request.
 *
 * Source of truth: `docs/API_CONTRACTS.md` §6.10, `STAGE_1_PHASE_6_SPEC.md` §8.1.
 * The shape mirrors `routes/admin-reviews.ts` for the list + PATCH structure, and
 * the inbound Linear webhook (`routes/webhooks.ts`) for the exact status-change
 * batch (status + workflow instance mirror + transition + audit, with
 * before/after state and a terminal-outcome map).
 *
 * On resolve/reject: a preload-gate (status), then one atomic `db.batch` — the
 * guarded `UPDATE … WHERE status IN ('open','in_review')` + the `audit_log` + the
 * `workflow_transitions` row (`open|in_review → resolved|rejected`) + the workflow
 * instance update (CLAUDE.md / §26.1: every state-changing write logs; failure
 * rolls back). Like `admin-reviews`, the guarded WHERE makes a two-admin race a
 * no-op update that still writes its audit — accepted under the §26.3 lean
 * relaxation (the preload covers the common case). Then the **site → Linear sync**
 * (§6.5) fires post-commit as an injectable, best-effort seam: its GraphQL
 * internals are owned by AECI-213 (out of scope here) — the default is a no-op.
 *
 * `is_duplicate` (Phase 6 Spec §7.2) has no column — it's computed at read time:
 * an OPEN sibling request sharing the same `(kind, target_type, target_id)` or
 * `(submitter_email, target_type, target_id)`. Two indexed `groupBy` aggregations
 * over `status='open'` build the lookup, so there's no per-row N+1. Informational
 * only — never auto-rejects.
 *
 * No cache invalidation: `vendor_requests` are admin-only and render on no
 * cacheable SSR page, so there's no `Cache-Tag` to purge.
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
  forwardAuditLog,
  type AuditLogEntry,
  type AuditLogForwarder,
} from '@aeci/shared/audit-log';
import {
  forwardWorkflowTransition,
  type WorkflowTransitionEntry,
  type WorkflowTransitionForwarder,
} from '@aeci/shared/workflow-transition';
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb, type Db } from '../db/client';
import { vendorRequests, workflowInstances } from '../db/schema';
import { logToDatadog, submitCount } from '../datadog';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import {
  auditInsert,
  workflowTransitionInsert,
  type BatchStmt,
  type BatchTuple,
} from '../lib/audit';
import {
  adminVendorRequestConfig,
  toAdminVendorRequest,
  type RawAdminVendorRequestRow,
} from '../lib/drizzle-helpers';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** `workflow_instances.final_outcome` for the terminal statuses (§26.2), mirroring
 *  `routes/webhooks.ts`. */
const TERMINAL_OUTCOME: Record<'resolved' | 'rejected', string> = {
  resolved: 'completed',
  rejected: 'rejected',
};

/**
 * Site → Linear sync seam (§6.5 / AECI-213). Invoked post-commit after a
 * resolve/reject so Linear and the app DB stay consistent. The GraphQL internals
 * are owned by AECI-213; the default here is a safe no-op so this endpoint ships
 * standalone. Best-effort — tolerant of a null `linearIssueId` (issue never
 * created); failures are the sync's concern, never surfaced to the admin.
 */
export type SyncRequestToLinear = (
  c: AdminContext,
  db: Db,
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
 *  target isn't open/in-review (the preload guard, 422). Fire-and-forget; no-op
 *  without `DD_API_KEY`. */
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

/** Composite key for the duplicate-flag lookup maps. ` ` (space) can never
 *  appear in an email local-part or a UUID, so the parts can't run together. */
const DUP_SEP = ' ';
function dupKey(head: string, targetType: string, targetId: string): string {
  return `${head}${DUP_SEP}${targetType}${DUP_SEP}${targetId}`;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/** `GET /api/admin/requests` — the requests queue. */
export function createAdminRequestsListHandler(
  dbFor: DbFactory = getDb,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const query = ListVendorRequestsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const { db } = dbFor(c.env);
    const where = query.kind
      ? and(eq(vendorRequests.status, query.status), eq(vendorRequests.kind, query.kind))
      : eq(vendorRequests.status, query.status);
    // Newest-first; `id` tiebreaks a `created_at` collision so pagination is stable
    // across pages (AECI-99).
    const openFilter = eq(vendorRequests.status, 'open');

    // Two indexed groupBy aggregations over open requests drive `is_duplicate`
    // (Phase 6 Spec §7.2). Run alongside the page query; scoped to `status='open'`
    // (covered by `vendor_requests_status_idx`), so cost is independent of page
    // size — no per-row N+1.
    const [rows, countRows, kindGroups, emailGroups] = await Promise.all([
      db.query.vendorRequests.findMany({
        ...adminVendorRequestConfig,
        where,
        orderBy: [desc(vendorRequests.createdAt), asc(vendorRequests.id)],
        limit: query.perPage,
        offset: (query.page - 1) * query.perPage,
      }),
      db.select({ value: count() }).from(vendorRequests).where(where),
      db
        .select({
          kind: vendorRequests.kind,
          targetType: vendorRequests.targetType,
          targetId: vendorRequests.targetId,
          n: count(),
        })
        .from(vendorRequests)
        .where(openFilter)
        .groupBy(vendorRequests.kind, vendorRequests.targetType, vendorRequests.targetId),
      db
        .select({
          submitterEmail: vendorRequests.submitterEmail,
          targetType: vendorRequests.targetType,
          targetId: vendorRequests.targetId,
          n: count(),
        })
        .from(vendorRequests)
        .where(openFilter)
        .groupBy(vendorRequests.submitterEmail, vendorRequests.targetType, vendorRequests.targetId),
    ]);

    const kindCounts = new Map<string, number>();
    for (const g of kindGroups) {
      kindCounts.set(dupKey(g.kind, g.targetType, g.targetId), g.n);
    }
    const emailCounts = new Map<string, number>();
    for (const g of emailGroups) {
      emailCounts.set(dupKey(g.submitterEmail, g.targetType, g.targetId), g.n);
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
      total: countRows[0]?.value ?? 0,
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
  dbFor: DbFactory = getDb,
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
    const { db } = dbFor(c.env);

    // Preload the full row: it both gates the transition (status) and builds the
    // response — the values we set ourselves are merged in after the commit, so
    // there's no post-commit re-read.
    const existing = (await db.query.vendorRequests.findFirst({
      ...adminVendorRequestConfig,
      where: eq(vendorRequests.id, id),
    })) as RawAdminVendorRequestRow | undefined;
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
    const resolvedAt = new Date().toISOString();
    const fromState = existing.status; // 'open' | 'in_review' — the real prior state.
    const workflowType = existing.kind === 'claim' ? 'vendor_claim' : 'correction_request';
    const metadata = {
      source: 'admin-moderation',
      kind: existing.kind,
      target_type: existing.targetType,
      target_id: existing.targetId,
      ...(reason ? { reason } : {}),
    };

    // Read the workflow instance up front (find-or-create can't be conditional
    // inside a batch). The submit path creates it, but mirror admin-reviews'
    // resilience for rows that predate the workflow retrofit.
    const existingWf = await db.query.workflowInstances.findFirst({
      columns: { id: true },
      where: and(
        eq(workflowInstances.workflowType, workflowType),
        eq(workflowInstances.entityId, id),
      ),
    });
    const workflowId = existingWf?.id ?? crypto.randomUUID();

    const auditEntry: AuditLogEntry = {
      actorId: userId,
      actorType: auditActorType(session),
      action: payload.action === 'resolve' ? 'vendor_request.resolved' : 'vendor_request.rejected',
      entityType: 'vendor_request',
      entityId: id,
      beforeState: { status: fromState },
      afterState: { status: newStatus },
      metadata,
    };
    const workflowEntry: WorkflowTransitionEntry = {
      workflowId,
      fromState,
      toState: newStatus,
      actorId: userId,
      reason,
      metadata,
    };

    // The guarded update (`WHERE status IN ('open','in_review')`) makes the state
    // change safe under a concurrent moderation; the preload gate covers the common
    // case (a rare two-admin race leaves a no-op update with its audit — accepted
    // under the §26.3 lean relaxation). Audit + workflow are atomic with it.
    const stmts: BatchStmt[] = [
      db
        .update(vendorRequests)
        .set({ status: newStatus, resolvedById: userId, resolvedAt })
        .where(
          and(eq(vendorRequests.id, id), inArray(vendorRequests.status, ['open', 'in_review'])),
        ),
      auditInsert(db, auditEntry),
      existingWf
        ? db
            .update(workflowInstances)
            .set({
              currentState: newStatus,
              completedAt: resolvedAt,
              finalOutcome: TERMINAL_OUTCOME[newStatus],
            })
            .where(eq(workflowInstances.id, workflowId))
        : db.insert(workflowInstances).values({
            id: workflowId,
            workflowType,
            entityId: id,
            currentState: newStatus,
            completedAt: resolvedAt,
            finalOutcome: TERMINAL_OUTCOME[newStatus],
          }),
      workflowTransitionInsert(db, workflowEntry),
    ];
    await db.batch(stmts as BatchTuple);

    // Committed: one `aeci.request.moderation.action{outcome:ok}` per resolve/reject.
    emitRequestModeration(c, payload.action, 'ok');

    // Post-commit, best-effort site → Linear sync (§6.5 / AECI-213 owns the
    // GraphQL internals). Never blocks/throws here; a failure is logged, not
    // surfaced. Tolerant of a null `linearIssueId` (issue never created).
    c.executionCtx.waitUntil(
      syncToLinear(c, db, {
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
    // Best-effort §26.5 audit + workflow forwards AFTER the atomic commit.
    c.executionCtx.waitUntil(
      Promise.all([
        forwardAuditLog(auditEntry, makeForwarder(c)),
        forwardWorkflowTransition(workflowEntry, makeWorkflowForwarder(c)),
      ]),
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
