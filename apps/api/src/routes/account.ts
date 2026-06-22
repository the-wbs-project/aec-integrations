/**
 * `GET` / `PATCH` / `DELETE /api/account` (AECI-202 / Phase 5.11) — Drizzle/D1
 * (ADR 0016 / AECI-253, AECI-254).
 *
 * Auth-gated by `requireAuth()`; `c.get('auth')` is the verified session. `userId`
 * is the token `sub` — the id of both the `profiles` row (D1) and the `auth.users`
 * row (Supabase).
 *
 * ── Erasure (DELETE), split across the identity seam ────────────────────────────
 * `profiles(id)` has seven inbound FKs; six are NO ACTION, so they must be nulled
 * before the profile delete. Under D1 that erasure is ONE atomic `db.batch([...])`
 * (null the 7 refs + the PII-free `account.deleted` audit + delete the profile).
 * The `auth.users` row then goes via the GoTrue Admin API (seam #3,
 * `lib/supabase-admin.ts`) AFTER the batch commits — an HTTP call can't join the
 * D1 transaction. The D1 data erasure is the GDPR-load-bearing step; if the auth
 * delete fails it is logged (the orphaned auth row re-provisions a fresh empty
 * profile on next login) and does not fail the response.
 *
 * The `account.deleted` audit row MUST have `actorId: null` — the profile is
 * deleted in the same batch and `audit_log.actor_id` is NO ACTION.
 */

import { UpdateAccountSchema } from '@aeci/shared';
import type { AccountProfileResponse, DeleteAccountResponse } from '@aeci/shared';
import {
  forwardAuditLog,
  type AuditLogEntry,
  type AuditLogForwarder,
} from '@aeci/shared/audit-log';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb } from '../db/client';
import {
  auditLog,
  pageViews,
  profiles,
  reviews,
  vendorRequests,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import { logToDatadog } from '../datadog';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { json } from '../http';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import type { DbFactory } from '../lib/handler-utils';
import { deleteAuthUser as deleteAuthUserDefault } from '../lib/supabase-admin';

type AuthContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

function makeForwarder(c: AuthContext): AuditLogForwarder | undefined {
  if (!c.env.DD_API_KEY) return undefined;
  return (entry) => {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source: 'account',
    });
  };
}

async function parseJsonBody<T>(c: AuthContext, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  return schema.parse(raw);
}

// ─── GET /api/account ─────────────────────────────────────────────────────────

export function createGetAccountHandler(
  dbFor: DbFactory = getDb,
): (c: AuthContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const { db } = dbFor(c.env);

    const profile = await db.query.profiles.findFirst({
      columns: { displayName: true },
      where: eq(profiles.id, session.userId),
    });

    const body: AccountProfileResponse = {
      user_id: session.userId,
      email: session.email ?? null,
      display_name: profile?.displayName ?? null,
    };
    return json(body);
  };
}

// ─── PATCH /api/account ────────────────────────────────────────────────────────

export function createUpdateAccountHandler(
  dbFor: DbFactory = getDb,
): (c: AuthContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const { userId } = session;
    const payload = await parseJsonBody(c, UpdateAccountSchema);
    const { db } = dbFor(c.env);

    const before = await db.query.profiles.findFirst({
      columns: { displayName: true },
      where: eq(profiles.id, userId),
    });

    const auditEntry: AuditLogEntry = {
      actorId: userId,
      actorType: auditActorType(session),
      action: 'profile.updated',
      entityType: 'profile',
      entityId: userId,
      beforeState: { display_name: before?.displayName ?? null },
      afterState: { display_name: payload.display_name },
      metadata: { source: 'account' },
    };

    await db.batch([
      db.update(profiles).set({ displayName: payload.display_name }).where(eq(profiles.id, userId)),
      auditInsert(db, auditEntry),
    ] as BatchTuple);

    c.executionCtx.waitUntil(forwardAuditLog(auditEntry, makeForwarder(c)));

    const body: AccountProfileResponse = {
      user_id: userId,
      email: session.email ?? null,
      display_name: payload.display_name,
    };
    return json(body);
  };
}

// ─── DELETE /api/account (GDPR erasure) ────────────────────────────────────────

export function createDeleteAccountHandler(
  dbFor: DbFactory = getDb,
  deleteAuthUser: typeof deleteAuthUserDefault = deleteAuthUserDefault,
): (c: AuthContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const { userId } = session;
    const { db } = dbFor(c.env);

    const auditEntry: AuditLogEntry = {
      // actorId MUST be null — the profile is deleted in this same batch.
      actorId: null,
      actorType: auditActorType(session),
      action: 'account.deleted',
      entityType: 'profile',
      entityId: userId,
      metadata: { source: 'account', initiated_by_self: true },
    };

    // One atomic unit: null every inbound reference (six NO ACTION + the SET NULL
    // reviewer ref made explicit) → PII-free audit → delete the profile.
    const stmts: BatchStmt[] = [
      db.update(reviews).set({ reviewerId: null }).where(eq(reviews.reviewerId, userId)),
      db.update(reviews).set({ moderatedBy: null }).where(eq(reviews.moderatedBy, userId)),
      db
        .update(vendorRequests)
        .set({ resolvedById: null })
        .where(eq(vendorRequests.resolvedById, userId)),
      db
        .update(workflowInstances)
        .set({ initiatedBy: null })
        .where(eq(workflowInstances.initiatedBy, userId)),
      db
        .update(workflowTransitions)
        .set({ actorId: null })
        .where(eq(workflowTransitions.actorId, userId)),
      db.update(auditLog).set({ actorId: null }).where(eq(auditLog.actorId, userId)),
      db.update(pageViews).set({ userId: null }).where(eq(pageViews.userId, userId)),
      auditInsert(db, auditEntry),
      db.delete(profiles).where(eq(profiles.id, userId)),
    ];
    await db.batch(stmts as BatchTuple);

    // Seam #3: delete the auth.users row over the GoTrue Admin API. The D1 data is
    // already erased (GDPR-met); a failure here is logged, not fatal.
    const authResult = await deleteAuthUser(c.env, userId);
    if (!authResult.ok) {
      logToDatadog(c.executionCtx, c.env, c.req.raw, {
        level: 'warn',
        message: 'account.deleted: auth.users delete failed (D1 data already erased)',
        source: 'account',
        user_id: userId,
        status: authResult.status,
        reason: authResult.error,
      });
    }

    c.executionCtx.waitUntil(forwardAuditLog(auditEntry, makeForwarder(c)));

    const body: DeleteAccountResponse = {
      message: 'Your account and personal data have been deleted.',
    };
    return json(body);
  };
}
