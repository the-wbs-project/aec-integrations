/**
 * `GET` / `PATCH` / `DELETE /api/account` (AECI-202 / Phase 5.11) — Drizzle/D1
 * (ADR 0016 / AECI-253, AECI-254).
 *
 * Auth-gated by `requireAuth()`; `c.get('auth')` is the verified session. `userId`
 * is the token `sub` — the id of both the `profiles` row (D1) and the `auth.users`
 * row (Supabase).
 *
 * ── `pending_reviews` on the read shapes (AECI-617) ─────────────────────────────
 * `GET`/`PATCH` return the moderation-queue count for `role === 'admin'` (`null`
 * otherwise) so the header's admin probe (`apps/web/.../admin/admin-status.ts`)
 * gets role + badge count in one round trip rather than chaining
 * `GET /api/admin/summary`. That second hop repeated the JWKS verify and the
 * `profiles` read, and its latency was the visible lag before the "More" menu's
 * Admin section appeared. `routes/admin-summary.ts` is unchanged — it stays the
 * `/admin` SSR resolver's gate and the in-shell badge feed.
 *
 * ── Erasure (DELETE), split across the identity seam ────────────────────────────
 * `profiles(id)` has seven inbound FKs; five are NO ACTION, so they must be nulled
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
import { count, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb, type DbContext } from '../db/client';
import {
  auditLog,
  profiles,
  reviews,
  vendorEntitlements,
  vendorRequests,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import { logToPosthog } from '../posthog';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { json } from '../http';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { sendAccountDeletionEmail } from '../lib/email';
import { writeDb, type DbFactory } from '../lib/handler-utils';
import { deleteAuthUser as deleteAuthUserDefault } from '../lib/supabase-admin';

type AuthContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

function makeForwarder(c: AuthContext): AuditLogForwarder | undefined {
  if (!c.env.DD_API_KEY && !c.env.POSTHOG_PROJECT_KEY) return undefined;
  return (entry) => {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
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
      role: session.role,
      pending_reviews: await pendingReviewsForSession(db, session.role),
    };
    return json(body);
  };
}

/**
 * The moderation-queue count for the header badge (AECI-617) — the same
 * aggregate `routes/admin-summary.ts` serves, folded into the account read so
 * `AdminStatus` resolves role + count in ONE round trip. Returns `null` for a
 * non-admin without touching the table, so the extra column costs a reviewer
 * nothing and leaks no moderation state.
 *
 * `session.role` is the DB-refetched role from `requireAuth()` (`lib/authz.ts`
 * re-reads it every request per `AUTH_AND_RLS.md` §4.5), NOT a client claim — so
 * gating on it here is as trustworthy as the `requireAdmin()` gate itself.
 */
async function pendingReviewsForSession(db: DbContext['db'], role: string): Promise<number | null> {
  if (role !== 'admin') return null;
  const rows = await db
    .select({ value: count() })
    .from(reviews)
    .where(eq(reviews.status, 'pending'));
  return rows[0]?.value ?? 0;
}

// ─── PATCH /api/account ────────────────────────────────────────────────────────

export function createUpdateAccountHandler(
  dbFor: DbFactory = getDb,
): (c: AuthContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const { userId } = session;
    const payload = await parseJsonBody(c, UpdateAccountSchema);
    const { db } = writeDb(c, dbFor);

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
      role: session.role,
      pending_reviews: await pendingReviewsForSession(db, session.role),
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
    // Capture the recipient BEFORE erasure — the auth.users row (the email's home)
    // is deleted below, so the §11.1 confirmation must read it up front.
    const recipientEmail = session.email;
    const { db } = writeDb(c, dbFor);

    const auditEntry: AuditLogEntry = {
      // actorId MUST be null — the profile is deleted in this same batch.
      actorId: null,
      actorType: auditActorType(session),
      action: 'account.deleted',
      entityType: 'profile',
      entityId: userId,
      metadata: { source: 'account', initiated_by_self: true },
    };

    // One atomic unit: null every inbound reference (five NO ACTION + the two SET NULL
    // refs — `reviews.reviewer_id` and `vendor_entitlements.granted_by` — made
    // explicit) → PII-free audit → delete the profile.
    //
    // `page_views` is deliberately absent (AECI-585 / §13 D7). It used to be nulled
    // here, but `page_views.user_id` was never written by any code path and has now
    // been dropped along with `session_id` and `profile_role`. That strengthens this
    // handler rather than weakening it: the table can no longer hold user linkage at
    // all, so there is nothing here to erase (`AUTH_AND_RLS.md` §12).
    const stmts: BatchStmt[] = [
      db
        .update(reviews)
        // Stamp `anonymized_at` in the same statement that nulls the reviewer ref
        // so the pair is atomic — a null `reviewer_id` always carries its
        // anonymization timestamp (the §23.1 / AECI-241 data-quality invariant).
        // Also null the free-text `reviewer_firm` (AECI-284): the firm is more
        // identifying than the generic role enum, so erasure clears it (and it
        // drops out of the contributing-firms count).
        .set({ reviewerId: null, reviewerFirm: null, anonymizedAt: new Date().toISOString() })
        .where(eq(reviews.reviewerId, userId)),
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
      // AECI-609 / R6: the SEVENTH inbound FK. It is `ON DELETE SET NULL`, so SQLite
      // would cover it, but it is nulled explicitly like `reviews.reviewer_id` so the
      // erasure test asserts it directly rather than trusting the cascade. The
      // entitlement ROW survives — only the granting admin's link is severed.
      db
        .update(vendorEntitlements)
        .set({ grantedBy: null })
        .where(eq(vendorEntitlements.grantedBy, userId)),
      auditInsert(db, auditEntry),
      db.delete(profiles).where(eq(profiles.id, userId)),
    ];
    await db.batch(stmts as BatchTuple);

    // Seam #3: delete the auth.users row over the GoTrue Admin API. The D1 data is
    // already erased (GDPR-met); a failure here is logged, not fatal.
    const authResult = await deleteAuthUser(c.env, userId);
    if (!authResult.ok) {
      logToPosthog(c.executionCtx, c.env, c.req.raw, {
        level: 'warn',
        message: 'account.deleted: auth.users delete failed (D1 data already erased)',
        source: 'account',
        user_id: userId,
        status: authResult.status,
        reason: authResult.error,
      });
    }

    // §26.5 forward + the §11.1 deletion confirmation, fire-and-forget after the
    // erasure. The email fails open (absent key/email → silent skip) and never
    // affects the response — the data is already gone.
    c.executionCtx.waitUntil(
      Promise.all([
        forwardAuditLog(auditEntry, makeForwarder(c)),
        sendAccountDeletionEmail(c, { to: recipientEmail }),
      ]),
    );

    const body: DeleteAccountResponse = {
      message: 'Your account and personal data have been deleted.',
    };
    return json(body);
  };
}
