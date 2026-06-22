/**
 * `GET` / `PATCH` / `DELETE /api/account` (AECI-202 / Phase 5.11) — the
 * signed-in user's own account surface.
 *
 * All three are auth-gated by `requireAuth()` (registered in `index.ts`), so
 * `c.get('auth')` is the verified session (`{ userId, email?, role }`). The
 * `userId` is the token `sub` — server-set, never client-supplied — and is the
 * id of both the `profiles` row and the `auth.users` row.
 *
 *   GET   — read identity: `email` (read-only, from the session JWT) +
 *           `profiles.display_name`.
 *   PATCH — update the editable `display_name` (audited `profile.updated`).
 *   DELETE — GDPR right-to-erasure (`STAGE_1_PHASE_5_SPEC.md` §6.2,
 *           `AUTH_AND_RLS.md` §8). See below.
 *
 * ── The erasure (DELETE) ────────────────────────────────────────────────────
 * `profiles(id)` has SEVEN inbound FKs. Only `reviews.reviewer_id` is
 * `ON DELETE SET NULL`; the other six are `ON DELETE NO ACTION`, so a
 * `DELETE FROM profiles` (whether issued here or by the `on_auth_user_deleted`
 * trigger) FK-FAILS unless those six are nulled first — and a real reviewer
 * always has `audit_log` rows (every `review.submitted` writes one). So, inside
 * ONE interactive transaction, we null every inbound reference, write the
 * `account.deleted` audit row, delete the profile, then delete the `auth.users`
 * row via raw SQL. The trigger's `DELETE FROM public.profiles` then matches zero
 * rows (we already deleted it); gotrue's own child tables cascade off
 * `auth.users`. AUTH_AND_RLS §8's "(or same Worker call)" sweep is performed
 * synchronously here, and it lists only two of the six NO ACTION FKs (doc gap,
 * reconciled in this PR).
 *
 * Why raw `DELETE FROM auth.users` and not the Supabase Auth Admin API: it is
 * the only way to honour the spec's "one transaction" requirement (an HTTP call
 * cannot join a DB transaction), and it avoids shipping the service-role key to
 * the Worker runtime (which `env.ts` deliberately forbids). The privileged
 * Accelerate connection already bypasses RLS for every write; this reuses it.
 *
 * The `account.deleted` audit row MUST have `actorId: null` — the profile is
 * deleted in the same transaction and `audit_log.actor_id` is `NO ACTION`, so a
 * non-null actor would either block the profile delete (written before) or
 * FK-reject (written after). The (now-gone) user id rides in `entityId` + PII-
 * free `metadata` (no email / display name), per AUTH_AND_RLS §8.
 *
 * The write pattern + loose structural client type mirror `routes/reviews.ts` /
 * `routes/auth-profile.ts`.
 */

import { UpdateAccountSchema } from '@aeci/shared';
import type { AccountProfileResponse, DeleteAccountResponse } from '@aeci/shared';
import { appendAuditLog, type AuditLogForwarder } from '@aeci/shared/audit-log';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { logToDatadog } from '../datadog';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { json } from '../http';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import type { PrismaFactory } from '../lib/handler-utils';
import { getPrisma } from '../prisma';

type AuthContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

// ─── Loose structural Prisma surface ─────────────────────────────────────────
// Same approach as `routes/reviews.ts`: we touch a small, known slice of the
// generated client, so we type it structurally and `as unknown as` it rather
// than dragging in the full edge-client generated types. A real accelerated
// client and the test fake both satisfy this.
type ProfileRow = { displayName: string | null };
type UpdateManyArgs = { where: Record<string, unknown>; data: Record<string, unknown> };

type AccountTx = {
  profile: {
    findUnique(args: {
      where: { id: string };
      select: { displayName: true };
    }): Promise<ProfileRow | null>;
    update(args: {
      where: { id: string };
      data: { displayName: string | null };
      select: { displayName: true };
    }): Promise<ProfileRow>;
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
  review: { updateMany(args: UpdateManyArgs): Promise<{ count: number }> };
  vendorRequest: { updateMany(args: UpdateManyArgs): Promise<{ count: number }> };
  workflowInstance: { updateMany(args: UpdateManyArgs): Promise<{ count: number }> };
  workflowTransition: { updateMany(args: UpdateManyArgs): Promise<{ count: number }> };
  auditLog: {
    updateMany(args: UpdateManyArgs): Promise<{ count: number }>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  pageView: { updateMany(args: UpdateManyArgs): Promise<{ count: number }> };
  /** Prisma tagged-template raw exec; used only for the `auth.users` delete. */
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
};

type AccountClient = {
  profile: {
    findUnique(args: {
      where: { id: string };
      select: { displayName: true };
    }): Promise<ProfileRow | null>;
  };
  $transaction<T>(fn: (tx: AccountTx) => Promise<T>): Promise<T>;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Datadog forwarder for the audit write; no-op without `DD_API_KEY`. Mirrors
 *  the `routes/reviews.ts` forwarder, tagged `source: account`. */
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
  // ZodError bubbles to `errorHandler()` → canonical VALIDATION_FAILED envelope.
  return schema.parse(raw);
}

// ─── GET /api/account ─────────────────────────────────────────────────────────

export function createGetAccountHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: AuthContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const prisma = prismaFor(c.env) as unknown as AccountClient;

    // The profile always exists (requireAuth 401s otherwise), but a `null`
    // guard keeps the type honest and survives a sync-trigger race.
    const profile = await prisma.profile.findUnique({
      where: { id: session.userId },
      select: { displayName: true },
    });

    const body: AccountProfileResponse = {
      user_id: session.userId,
      email: session.email ?? null,
      display_name: profile?.displayName ?? null,
      role: session.role,
    };
    return json(body);
  };
}

// ─── PATCH /api/account ────────────────────────────────────────────────────────

export function createUpdateAccountHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: AuthContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const { userId } = session;
    const payload = await parseJsonBody(c, UpdateAccountSchema);
    const prisma = prismaFor(c.env) as unknown as AccountClient;
    const forward = makeForwarder(c);

    const updated = await prisma.$transaction(async (tx) => {
      const before = await tx.profile.findUnique({
        where: { id: userId },
        select: { displayName: true },
      });
      const row = await tx.profile.update({
        where: { id: userId },
        data: { displayName: payload.display_name },
        select: { displayName: true },
      });
      await appendAuditLog(
        tx,
        {
          actorId: userId,
          actorType: auditActorType(session),
          action: 'profile.updated',
          entityType: 'profile',
          entityId: userId,
          beforeState: { display_name: before?.displayName ?? null },
          afterState: { display_name: row.displayName },
          metadata: { source: 'account' },
        },
        forward,
      );
      return row;
    });

    const body: AccountProfileResponse = {
      user_id: userId,
      email: session.email ?? null,
      display_name: updated.displayName,
      role: session.role,
    };
    return json(body);
  };
}

// ─── DELETE /api/account (GDPR erasure) ────────────────────────────────────────

export function createDeleteAccountHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: AuthContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const { userId } = session;
    const prisma = prismaFor(c.env) as unknown as AccountClient;
    const forward = makeForwarder(c);

    await prisma.$transaction(async (tx) => {
      // 1. Anonymize reviews + sever every other inbound reference to this
      //    profile. `reviews.reviewer_id` is `SET NULL` and would auto-null on
      //    the profile delete; we null it explicitly so the behavior is
      //    deterministic and unit-testable against the fake client. The other
      //    six are `NO ACTION` and MUST be nulled or the profile delete (here
      //    AND in the auth-delete trigger) FK-fails.
      await tx.review.updateMany({ where: { reviewerId: userId }, data: { reviewerId: null } });
      await tx.review.updateMany({ where: { moderatedBy: userId }, data: { moderatedBy: null } });
      await tx.vendorRequest.updateMany({
        where: { resolvedById: userId },
        data: { resolvedById: null },
      });
      await tx.workflowInstance.updateMany({
        where: { initiatedBy: userId },
        data: { initiatedBy: null },
      });
      await tx.workflowTransition.updateMany({
        where: { actorId: userId },
        data: { actorId: null },
      });
      await tx.auditLog.updateMany({ where: { actorId: userId }, data: { actorId: null } });
      await tx.pageView.updateMany({ where: { userId }, data: { userId: null } });

      // 2. Audit the erasure. `actorId` MUST be null (the profile is deleted in
      //    this same transaction and `audit_log.actor_id` is NO ACTION). The
      //    user id rides in `entityId` + PII-free metadata — no email / name.
      await appendAuditLog(
        tx,
        {
          actorId: null,
          actorType: auditActorType(session),
          action: 'account.deleted',
          entityType: 'profile',
          entityId: userId,
          metadata: { source: 'account', initiated_by_self: true },
        },
        forward,
      );

      // 3. Delete the profile row (all inbound NO ACTION refs now nulled).
      await tx.profile.delete({ where: { id: userId } });

      // 4. Delete the auth.users row in the SAME transaction (raw SQL — the
      //    gotrue `auth` schema is not in the public Prisma model). The
      //    `on_auth_user_deleted` trigger fires and runs `DELETE FROM
      //    public.profiles` → 0 rows (already gone); gotrue child tables
      //    (sessions/refresh_tokens/identities) cascade off `auth.users`.
      await tx.$executeRaw`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    });

    // Loops confirmation email is DEFERRED to Phase 7 (Loops setup is Phase 7).
    // Deletion must NOT block on email — log a stub and move on.
    // TODO(AECI-Phase7-loops): send the account-deletion confirmation via Loops
    // (best-effort, ctx.waitUntil, never blocks this response).

    const body: DeleteAccountResponse = {
      message: 'Your account and personal data have been deleted.',
    };
    return json(body);
  };
}
