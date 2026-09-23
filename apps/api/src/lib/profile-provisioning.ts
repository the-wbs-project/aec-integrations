/**
 * Split-identity seam #1 — D1 `profiles` provisioning (`docs/AUTH_AND_RLS.md` §3.1).
 *
 * Under ADR 0016 there is no `handle_new_user` trigger, so this module is the ONLY
 * runtime creator of a `profiles` row. Two callers share it:
 *
 *   1. `POST /api/auth/profile/ensure` — the SSR `/auth/callback` handler calls it
 *      right after the PKCE code exchange. The callback retries it and signs the
 *      user out if it keeps failing (AECI-770).
 *   2. {@link healMissingProfile} — the self-heal hook `GET /api/account` passes
 *      to `requireAuth()`. A user whose callback ensure failed anyway (an older
 *      session, or a sign-out that did not stick) recovers on the header's next
 *      account probe instead of being 401'd forever (AECI-770).
 *
 * `requireAuth()` itself stays strict: with no hook it 401s a missing profile, and
 * only `GET /api/account` opts in.
 *
 * NO-CLOBBER CONTRACT (AECI-527 / `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §2). The
 * insert writes ONLY `id` and never updates on conflict, so a vendor-claim grant
 * that landed BEFORE the claimant's first sign-in survives it. Do NOT add columns
 * to `.values()` and do NOT convert this to `onConflictDoUpdate`.
 *
 * `INSERT … ON CONFLICT DO NOTHING … RETURNING` makes the race correct: only the
 * insert that actually created the row gets an id back and writes the
 * `profile.created` audit. The audit follows the committed insert rather than
 * sharing its batch, because whether to audit depends on the insert's result. That
 * relaxation of the §26.1 batch rule is scoped to this idempotent create.
 */

import { ApiErrorCode } from '@aeci/shared';
import {
  forwardAuditLog,
  type AuditLogEntry,
  type AuditLogForwarder,
} from '@aeci/shared/audit-log';
import { and, eq } from 'drizzle-orm';
import type { Context } from 'hono';

import type { Db } from '../db/client';
import { auditLog, profiles } from '../db/schema';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { logToPosthog, submitCount } from '../posthog';
import { auditInsert } from './audit';

/** The slice of a Hono context this module needs. Narrow on purpose, so every
 *  router's context (whatever its `Variables`) satisfies it. */
type ProvisioningContext = Pick<Context<{ Bindings: Env }>, 'env' | 'executionCtx' | 'req'>;

/** Where a provisioning attempt came from. Rides the audit metadata and the metric. */
export type ProfileEnsureSource = 'auth-callback' | 'self-heal';

/** The `aeci.auth.profile_ensure` count (AECI-770). `docs/OBSERVABILITY.md`. */
export const PROFILE_ENSURE_METRIC = 'aeci.auth.profile_ensure';

/**
 * Create the caller's `profiles` row if it is absent. Idempotent. Returns whether
 * this call created it, plus the audit entry to forward post-commit when it did.
 */
export async function ensureProfileRow(
  db: Db,
  userId: string,
  source: ProfileEnsureSource,
): Promise<{ created: boolean; auditEntry: AuditLogEntry | null }> {
  const inserted = await db
    .insert(profiles)
    .values({ id: userId })
    .onConflictDoNothing()
    .returning({ id: profiles.id });
  if (inserted.length === 0) return { created: false, auditEntry: null };

  const auditEntry: AuditLogEntry = {
    actorId: userId,
    actorType: 'user',
    action: 'profile.created',
    entityType: 'profile',
    entityId: userId,
    metadata: { source },
  };
  await auditInsert(db, auditEntry);
  return { created: true, auditEntry };
}

/**
 * Whether this user erased their account (`DELETE /api/account` writes an
 * `account.deleted` audit keyed on the profile id). The self-heal must never
 * re-create a profile for an erased account: the JWT outlives the erasure by up to
 * its expiry, and a stale tab's header probe would otherwise resurrect the row.
 * Reads through `audit_log_entity_idx`, and only on the rare missing-profile path.
 */
async function wasErased(db: Db, userId: string): Promise<boolean> {
  const row = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, 'profile'),
        eq(auditLog.entityId, userId),
        eq(auditLog.action, 'account.deleted'),
      ),
    )
    .limit(1);
  return row.length > 0;
}

/** PostHog forwarder for the `profile.created` audit; no-ops without a project key. */
export function profileAuditForwarder(
  c: ProvisioningContext,
  source: ProfileEnsureSource,
): AuditLogForwarder | undefined {
  if (!c.env.POSTHOG_PROJECT_KEY) return undefined;
  return (entry) => {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source,
    });
  };
}

/** The hook `requireAuth()` calls when a verified token has no `profiles` row. */
export type MissingProfileHook = (c: ProvisioningContext, db: Db, userId: string) => Promise<void>;

/**
 * The `GET /api/account` self-heal (AECI-770). Runs the idempotent ensure for a
 * verified identity that has no row, then returns so `requireAuth()` re-reads.
 *
 * - An erased account is left alone. `requireAuth()` then 401s, which is correct.
 * - An ensure that throws is logged at `error`, counted as
 *   `aeci.auth.profile_ensure{outcome:failed}`, and surfaces as 503
 *   `PROFILE_UNAVAILABLE`. That tells the user to retry, where a 401 told them to
 *   sign in again, which never helped.
 */
export function healMissingProfile(): MissingProfileHook {
  const source: ProfileEnsureSource = 'self-heal';
  return async (c, db, userId) => {
    const count = (outcome: string) =>
      submitCount(c.executionCtx, c.env, c.req.raw, PROFILE_ENSURE_METRIC, 1, [
        `source:${source}`,
        `outcome:${outcome}`,
      ]);

    let result: Awaited<ReturnType<typeof ensureProfileRow>>;
    try {
      if (await wasErased(db, userId)) {
        count('erased');
        return;
      }
      result = await ensureProfileRow(db, userId, source);
    } catch (err) {
      count('failed');
      logToPosthog(c.executionCtx, c.env, c.req.raw, {
        level: 'error',
        message: 'profile-ensure self-heal failed',
        source,
        error: err instanceof Error ? err.message : String(err),
      });
      console.error('profile-ensure self-heal failed', err);
      throw new ApiError(
        503,
        ApiErrorCode.PROFILE_UNAVAILABLE,
        'Your account is signed in but its profile could not be created. Try again in a minute.',
      );
    }

    count(result.created ? 'created' : 'existing');
    if (result.auditEntry) {
      c.executionCtx.waitUntil(
        forwardAuditLog(result.auditEntry, profileAuditForwarder(c, source)),
      );
    }
  };
}
