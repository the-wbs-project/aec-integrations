/**
 * Reviewer ban-management API (AECI-218 / Phase 6.11) — the admin ban/unban
 * action + the currently-banned list, behind `requireAdmin()`:
 *
 *   GET   /api/admin/reviewers      — the currently-banned reviewers, paginated.
 *   PATCH /api/admin/reviewers/:id  — ban / unban a reviewer (a `profiles` row).
 *
 * Source of truth: `STAGE_1_PHASE_6_SPEC.md` §9, `STAGE_1_SPEC.md` §22.3,
 * `docs/API_CONTRACTS.md` §6.10. Ban *enforcement* (rejecting a banned user's
 * review submit) already shipped in Phase 5 (AECI-197) — this is the *management*
 * half: setting/clearing `profiles.banned_at` + `ban_reason`.
 *
 * The shape mirrors `routes/admin-requests.ts`: a preload-then-guarded-`updateMany`
 * write in one transaction with `appendAuditLog()` + a `workflow_transitions` row
 * (CLAUDE.md / §26.1 — every state-changing write logs; failure rolls back). The
 * ban workflow (`workflow_type: 'reviewer_ban'`) is **reversible**, so unlike the
 * review/request workflows it never sets `completed_at`/`final_outcome` — the
 * instance just toggles `current_state` between `active` and `banned`.
 *
 * `:id` is the profile id (= `auth.users.id` = `reviews.reviewer_id`). Guardrails:
 * an admin profile and the acting admin themselves can't be banned via this
 * surface (a banned admin would lock themselves out of `requireAdmin()`).
 *
 * No cache invalidation: a ban changes no cacheable SSR page — a banned reviewer's
 * already-approved reviews stay visible (flagged internally only, §22.3) — so
 * there's no `Cache-Tag` to purge.
 *
 * The loose structural Prisma client types follow the `routes/admin-requests.ts`
 * rationale: we touch a known slice of the generated client, so we type it
 * structurally and `as unknown as` it rather than dragging in the full edge-client
 * generics. A real accelerated client and the test fakes both satisfy these.
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
import { getPrisma } from '../prisma';
import type { AcceleratedPrisma } from '../prisma';

import { fetchReviewerEmails, type FetchReviewerEmails } from './admin-reviews';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

// ─── Loose structural Prisma surfaces ────────────────────────────────────────

/** Profile fields the ban path preloads: status (`bannedAt`) gates the
 *  transition + builds the before-state; `role` enforces the admin guardrail. */
const banProfileSelect = { id: true, role: true, bannedAt: true, banReason: true } as const;
type BanProfileRow = {
  id: string;
  role: string;
  bannedAt: Date | null;
  banReason: string | null;
};

/** Fields the banned list selects; `bannedAt` is non-null by the `{ not: null }`
 *  filter, so the structural row narrows it. */
const bannedListSelect = { id: true, bannedAt: true, banReason: true } as const;
type BannedListRow = { id: string; bannedAt: Date; banReason: string | null };

type WorkflowRow = { id: string };

/** Transaction surface for the ban/unban write: the guarded `updateMany`, plus
 *  the audit (`AuditLogClient`) and workflow (`WorkflowTransitionClient` + the
 *  `workflowInstance` find-or-create/update) surfaces. */
type BanReviewerTx = {
  profile: {
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

/** Read + transaction surface for `PATCH /api/admin/reviewers/:id`. The single
 *  `findUnique` gates the transition (status + role) and builds the before-state;
 *  the after-state is the values we commit (no post-commit re-read). */
type BanReviewerClient = {
  profile: {
    findUnique(args: {
      where: { id: string };
      select: typeof banProfileSelect;
    }): Promise<BanProfileRow | null>;
  };
  $transaction<T>(fn: (tx: BanReviewerTx) => Promise<T>): Promise<T>;
};

/** Read surface for `GET /api/admin/reviewers`: the paginated `findMany` + `count`
 *  over the currently-banned set. */
type BannedReviewersClient = {
  profile: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy: unknown;
      skip: number;
      take: number;
      select: typeof bannedListSelect;
    }): Promise<BannedListRow[]>;
    count(args: { where: Record<string, unknown> }): Promise<number>;
  };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Datadog forwarder for the audit write; no-op without `DD_API_KEY`. Mirrors
 *  `routes/admin-requests.ts`, tagged `source: admin-moderation`. */
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
  // ZodError bubbles to `errorHandler()` → canonical VALIDATION_FAILED envelope
  // (the ban-reason refine surfaces here, keyed to `reason`).
  return schema.parse(raw);
}

/** Emit the `aeci.moderation.ban` count (Phase 6 Spec §11) — one per ban/unban
 *  attempt: `outcome:ok` on a committed action, `outcome:invalid_state` when the
 *  target isn't in a toggleable state (already banned / not banned),
 *  `outcome:forbidden` for the admin/self guardrail. Fire-and-forget; no-op
 *  without `DD_API_KEY`. */
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

/** Wrap the email lookup so an `auth`-schema failure degrades to an empty map
 *  (→ `reviewer_email: null`) + a warn, never a 500 — mirrors `admin-reviews`. */
async function safeFetchEmails(
  c: AdminContext,
  fetchEmails: FetchReviewerEmails,
  prisma: AcceleratedPrisma,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  try {
    return await fetchEmails(prisma, ids);
  } catch (error) {
    try {
      logToDatadog(c.executionCtx, c.env, c.req.raw, {
        level: 'warn',
        message: 'Admin reviewers: reviewer email lookup failed',
        data_gap: 'reviewer_email_lookup_failed',
      });
    } catch {
      console.warn('admin-reviewers: reviewer email lookup failed', error);
    }
    return new Map();
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/** `GET /api/admin/reviewers` — the currently-banned reviewers, newest ban first. */
export function createBannedReviewersListHandler(
  prismaFor: PrismaFactory = getPrisma,
  fetchEmails: FetchReviewerEmails = fetchReviewerEmails,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const query = ListBannedReviewersQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const prisma = prismaFor(c.env);
    const db = prisma as unknown as BannedReviewersClient;

    const where = { bannedAt: { not: null } };
    const skip = (query.page - 1) * query.perPage;

    const [rows, total] = await Promise.all([
      db.profile.findMany({
        where,
        // Newest ban first; `id` tiebreaks a `banned_at` collision so pagination
        // is stable across pages. `as const` keeps the literal narrow.
        orderBy: [{ bannedAt: 'desc' as const }, { id: 'asc' as const }],
        skip,
        take: query.perPage,
        select: bannedListSelect,
      }),
      db.profile.count({ where }),
    ]);

    const emailByReviewerId = await safeFetchEmails(
      c,
      fetchEmails,
      prisma,
      rows.map((row) => row.id),
    );

    const body: ListBannedReviewersResponse = {
      data: rows.map(
        (row): BannedReviewer => ({
          reviewer_id: row.id,
          reviewer_email: emailByReviewerId.get(row.id) ?? null,
          banned_at: row.bannedAt.toISOString(),
          ban_reason: row.banReason,
        }),
      ),
      page: query.page,
      perPage: query.perPage,
      total,
    };

    validateResponseInDev(c.env, () => {
      ListBannedReviewersResponseSchema.parse(body);
    });

    return json(body);
  };
}

/** `PATCH /api/admin/reviewers/:id` — ban / unban a reviewer. */
export function createBanReviewerHandler(
  prismaFor: PrismaFactory = getPrisma,
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

    const prisma = prismaFor(c.env);
    const db = prisma as unknown as BanReviewerClient;

    // Preload: gate the transition (status + role) and build the before-state.
    const existing = await db.profile.findUnique({ where: { id }, select: banProfileSelect });
    if (!existing) throw notFoundError('profile', { id });

    // Guardrail: never ban an admin or the acting admin themselves via this
    // surface — a banned admin would lock themselves out of `requireAdmin()`.
    if (ban && (existing.role === 'admin' || id === userId)) {
      emitBanAction(c, payload.action, 'forbidden');
      throw new ApiError(
        403,
        ApiErrorCode.FORBIDDEN,
        id === userId ? 'You cannot ban yourself.' : 'Admin accounts cannot be banned.',
      );
    }

    // Toggle guard: ban needs a currently-un-banned target; unban needs a banned
    // one. Idempotent re-bans / no-op unbans are an invalid transition (422).
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
    const bannedAt = ban ? new Date() : null;
    const fromState = ban ? 'active' : 'banned';
    const toState = ban ? 'banned' : 'active';
    const forward = makeForwarder(c);
    const workflowForward = makeWorkflowForwarder(c);
    const metadata = {
      source: 'admin-moderation',
      ...(reason ? { reason } : {}),
    };

    await db.$transaction(async (tx) => {
      // Atomic guard: only flip a row still in the expected ban state. If a
      // concurrent action already moved it, `count` is 0 → 422 (rolls back) —
      // closes the two-admins-racing window the preload check can't.
      const updated = await tx.profile.updateMany({
        where: { id, bannedAt: ban ? null : { not: null } },
        data: { bannedAt, banReason: reason },
      });
      if (updated.count !== 1) {
        emitBanAction(c, payload.action, 'invalid_state');
        throw new ApiError(
          422,
          ApiErrorCode.INVALID_STATE_TRANSITION,
          ban ? 'Reviewer is already banned.' : 'Reviewer is not banned.',
        );
      }

      await appendAuditLog(
        tx,
        {
          actorId: userId,
          actorType: auditActorType(session),
          action: ban ? 'reviewer.banned' : 'reviewer.unbanned',
          entityType: 'profile',
          entityId: id,
          beforeState: {
            banned_at: existing.bannedAt ? existing.bannedAt.toISOString() : null,
            ban_reason: existing.banReason,
          },
          afterState: {
            banned_at: bannedAt ? bannedAt.toISOString() : null,
            ban_reason: reason,
          },
          metadata,
        },
        forward,
      );

      // Record the ban in the shared workflow history. The `reviewer_ban`
      // instance is long-lived (a reviewer can be banned/unbanned repeatedly),
      // so find-or-create it (seeded at the *prior* state), append the
      // `active↔banned` transition, and toggle `current_state`. No
      // `completed_at`/`final_outcome` — the workflow is reversible (unlike
      // review/request moderation, which terminate). Same tx → rolls back with
      // the write.
      let workflow = await tx.workflowInstance.findFirst({
        where: { workflowType: 'reviewer_ban', entityId: id },
        select: { id: true },
      });
      workflow ??= await tx.workflowInstance.create({
        data: { workflowType: 'reviewer_ban', entityId: id, currentState: fromState },
        select: { id: true },
      });
      await appendWorkflowTransition(
        tx,
        {
          workflowId: workflow.id,
          fromState,
          toState,
          actorId: userId,
          reason,
          metadata,
        },
        workflowForward,
      );
      await tx.workflowInstance.update({
        where: { id: workflow.id },
        data: { currentState: toState },
      });
    });

    // Committed: one `aeci.moderation.ban{outcome:ok}` per ban/unban.
    emitBanAction(c, payload.action, 'ok');

    const body: BanReviewerResponse = {
      reviewer_id: id,
      banned_at: bannedAt ? bannedAt.toISOString() : null,
      ban_reason: reason,
    };

    validateResponseInDev(c.env, () => {
      BanReviewerResponseSchema.parse(body);
    });

    return json(body);
  };
}
