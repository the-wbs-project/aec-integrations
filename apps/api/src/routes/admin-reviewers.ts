/**
 * Reviewer ban-management API (AECI-218 / Phase 6.11) — Drizzle/D1 (ADR 0016 /
 * AECI-253, AECI-254).
 *
 *   GET   /api/admin/reviewers      — the currently-banned reviewers, paginated.
 *   PATCH /api/admin/reviewers/:id  — ban / unban a reviewer (a `profiles` row).
 *
 * Mirrors `admin-reviews`: a preload-gate then one atomic `db.batch` (guarded
 * `UPDATE … WHERE` + audit + the lean workflow history). The `reviewer_ban`
 * workflow is REVERSIBLE, so it only toggles `current_state` (`active ↔ banned`)
 * — never `completed_at`/`final_outcome`. `reviewer_email` comes from the GoTrue
 * Admin API (seam #2). Admins (and the acting admin) can't be banned here.
 */

import {
  ApiErrorCode,
  BanReviewerResponseSchema,
  BanReviewerSchema,
  ListBannedReviewersQuerySchema,
  ListBannedReviewersResponseSchema,
  type BanReviewerResponse,
  type BannedReviewer,
  type ListBannedReviewersResponse,
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
import { and, asc, count, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb } from '../db/client';
import { profiles, workflowInstances } from '../db/schema';
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
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { fetchAuthUserEmails } from '../lib/supabase-admin';
import type { FetchReviewerEmails } from './admin-reviews';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

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
  return schema.parse(raw);
}

function emitBanAction(
  c: AdminContext,
  action: 'ban' | 'unban',
  outcome: 'ok' | 'invalid_state' | 'forbidden',
): void {
  submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.moderation.ban', 1, [
    `action:${action}`,
    `outcome:${outcome}`,
  ]);
}

// ─── GET /api/admin/reviewers ──────────────────────────────────────────────────

export function createBannedReviewersListHandler(
  dbFor: DbFactory = getDb,
  fetchEmails: FetchReviewerEmails = fetchAuthUserEmails,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const query = ListBannedReviewersQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const { db } = dbFor(c.env);
    const where = isNotNull(profiles.bannedAt);

    const [rows, countRows] = await Promise.all([
      db.query.profiles.findMany({
        columns: { id: true, bannedAt: true, banReason: true },
        where,
        orderBy: [desc(profiles.bannedAt), asc(profiles.id)],
        limit: query.perPage,
        offset: (query.page - 1) * query.perPage,
      }),
      db.select({ value: count() }).from(profiles).where(where),
    ]);

    const emailByReviewerId = await fetchEmails(
      c.env,
      rows.map((row) => row.id),
    );

    const body: ListBannedReviewersResponse = {
      data: rows.map(
        (row): BannedReviewer => ({
          reviewer_id: row.id,
          reviewer_email: emailByReviewerId.get(row.id) ?? null,
          banned_at: row.bannedAt ?? '',
          ban_reason: row.banReason,
        }),
      ),
      page: query.page,
      perPage: query.perPage,
      total: countRows[0]?.value ?? 0,
    };

    validateResponseInDev(c.env, () => {
      ListBannedReviewersResponseSchema.parse(body);
    });

    return json(body);
  };
}

// ─── PATCH /api/admin/reviewers/:id ────────────────────────────────────────────

export function createBanReviewerHandler(
  dbFor: DbFactory = getDb,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const { userId } = session;

    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing reviewer id', { field: 'id' });
    }

    const payload = await parseJsonBody(c, BanReviewerSchema);
    const ban = payload.action === 'ban';
    const { db } = writeDb(c, dbFor);

    const existing = await db.query.profiles.findFirst({
      columns: { id: true, role: true, bannedAt: true, banReason: true },
      where: eq(profiles.id, id),
    });
    if (!existing) throw notFoundError('profile', { id });

    // Guardrail: never ban an admin or the acting admin themselves.
    if (ban && (existing.role === 'admin' || id === userId)) {
      emitBanAction(c, payload.action, 'forbidden');
      throw new ApiError(
        403,
        ApiErrorCode.FORBIDDEN,
        id === userId ? 'You cannot ban yourself.' : 'Admin accounts cannot be banned.',
      );
    }

    // Toggle guard (preload): ban needs an un-banned target; unban a banned one.
    const alreadyInTargetState = ban ? existing.bannedAt !== null : existing.bannedAt === null;
    if (alreadyInTargetState) {
      emitBanAction(c, payload.action, 'invalid_state');
      throw new ApiError(
        422,
        ApiErrorCode.INVALID_STATE_TRANSITION,
        ban ? 'Reviewer is already banned.' : 'Reviewer is not banned.',
      );
    }

    const reason = ban ? (payload.reason as string).trim() : null;
    const bannedAt = ban ? new Date().toISOString() : null;
    const fromState = ban ? 'active' : 'banned';
    const toState = ban ? 'banned' : 'active';
    const metadata = { source: 'admin-moderation', ...(reason ? { reason } : {}) };

    const existingWf = await db.query.workflowInstances.findFirst({
      columns: { id: true },
      where: and(
        eq(workflowInstances.workflowType, 'reviewer_ban'),
        eq(workflowInstances.entityId, id),
      ),
    });
    const workflowId = existingWf?.id ?? crypto.randomUUID();

    const auditEntry: AuditLogEntry = {
      actorId: userId,
      actorType: auditActorType(session),
      action: ban ? 'reviewer.banned' : 'reviewer.unbanned',
      entityType: 'profile',
      entityId: id,
      beforeState: { banned_at: existing.bannedAt ?? null, ban_reason: existing.banReason },
      afterState: { banned_at: bannedAt, ban_reason: reason },
      metadata,
    };
    const workflowEntry: WorkflowTransitionEntry = {
      workflowId,
      fromState,
      toState,
      actorId: userId,
      reason,
      metadata,
    };

    // The guarded update (`WHERE banned_at IS [NOT] NULL`) makes the toggle safe
    // under a concurrent action; audit + workflow are atomic with it.
    const stmts: BatchStmt[] = [
      db
        .update(profiles)
        .set({ bannedAt, banReason: reason })
        .where(
          and(eq(profiles.id, id), ban ? isNull(profiles.bannedAt) : isNotNull(profiles.bannedAt)),
        ),
      auditInsert(db, auditEntry),
      existingWf
        ? db
            .update(workflowInstances)
            .set({ currentState: toState })
            .where(eq(workflowInstances.id, workflowId))
        : db.insert(workflowInstances).values({
            id: workflowId,
            workflowType: 'reviewer_ban',
            entityId: id,
            currentState: toState,
          }),
      workflowTransitionInsert(db, workflowEntry),
    ];
    await db.batch(stmts as BatchTuple);

    emitBanAction(c, payload.action, 'ok');
    c.executionCtx.waitUntil(
      Promise.all([
        forwardAuditLog(auditEntry, makeForwarder(c)),
        forwardWorkflowTransition(workflowEntry, makeWorkflowForwarder(c)),
      ]),
    );

    const body: BanReviewerResponse = {
      reviewer_id: id,
      banned_at: bannedAt,
      ban_reason: reason,
    };

    validateResponseInDev(c.env, () => {
      BanReviewerResponseSchema.parse(body);
    });

    return json(body);
  };
}
