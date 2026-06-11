/**
 * `POST /api/auth/profile/ensure` (AECI-195 / Phase 5.4).
 *
 * Defensive profile-ensure for the `/auth/callback` handler. The
 * `handle_new_user` trigger (migration 20260515052617) already creates the
 * `profiles` row when an `auth.users` row is inserted — this endpoint exists
 * because `STAGE_1_PHASE_5_SPEC.md` §4.2 requires the callback to be
 * defensive/idempotent about it, and the SSR Worker has no DB access of its
 * own. `requireUserAuth()` runs first, so the row id is always the verified
 * token's `sub` — the client never supplies it.
 *
 * Idempotency: `createMany` + `skipDuplicates` is a single
 * `INSERT … ON CONFLICT DO NOTHING`; every column other than `id` takes its
 * schema default (`role='reviewer'` per `STAGE_1_SPEC.md` §8.1). When a row is
 * actually created (the trigger somehow missed it) we audit-log inside the
 * same transaction — re-runs that find the row existing change no state and
 * write no audit row.
 */

import { appendAuditLog, type AuditLogForwarder } from '@aeci/shared/audit-log';
import type { Context } from 'hono';

import { logToDatadog } from '../datadog';
import type { Env } from '../env';
import { json } from '../http';
import type { PrismaFactory } from '../lib/handler-utils';
import type { UserAuthVariables } from '../lib/user-auth';
import { getPrisma } from '../prisma';

// ─── Loose structural Prisma surface ─────────────────────────────────────────
// Same approach as `routes/requests.ts`: we touch a small, known slice of the
// generated client, so we type it structurally and `as unknown as` it rather
// than dragging in the full edge-client generated types. A real accelerated
// client and the test fake both satisfy this.

type ProfileEnsureTx = {
  profile: {
    createMany(args: { data: { id: string }; skipDuplicates: true }): Promise<{ count: number }>;
  };
  auditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
};

type ProfileEnsureClient = {
  $transaction<T>(fn: (tx: ProfileEnsureTx) => Promise<T>): Promise<T>;
};

/** Datadog forwarder for the audit write; no-op without `DD_API_KEY`. Mirrors
 *  the `routes/requests.ts` forwarder, tagged `source: auth-callback`. */
function makeForwarder(
  c: Context<{ Bindings: Env; Variables: UserAuthVariables }>,
): AuditLogForwarder | undefined {
  if (!c.env.DD_API_KEY) return undefined;
  return (entry) => {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source: 'auth-callback',
    });
  };
}

export function createEnsureProfileHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: Context<{ Bindings: Env; Variables: UserAuthVariables }>) => Promise<Response> {
  return async (c) => {
    const { userId } = c.get('user');
    const prisma = prismaFor(c.env) as unknown as ProfileEnsureClient;
    const forward = makeForwarder(c);

    const created = await prisma.$transaction(async (tx) => {
      const { count } = await tx.profile.createMany({
        data: { id: userId },
        skipDuplicates: true,
      });
      if (count === 0) return false;
      await appendAuditLog(
        tx,
        {
          actorId: userId,
          actorType: 'user',
          action: 'profile.created',
          entityType: 'profile',
          entityId: userId,
          metadata: { source: 'auth-callback' },
        },
        forward,
      );
      return true;
    });

    return json({ created });
  };
}
