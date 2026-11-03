/**
 * Who may see a private row thread (AECI-1535, `STAGE_2_ATTESTATIONS_SPEC.md` §15.3).
 *
 * Ruled 2026-10-29: access is decided by the two companies STAMPED on the thread
 * (`vendor_a_id` / `vendor_b_id`), not by who owns the claim's products today. A
 * caller whose vendor is one of the pair may read. A write needs that AND a current
 * endpoint of the claim (`resolveClaimAuthority`), which the route checks. Anyone
 * else gets the 404 the vendor surface answers instead of a 403.
 *
 * This is the one definition. The SQL form scopes a query to the caller's threads
 * (the `threads` cursor scope, AECI-1538, and any list). The in-memory form checks a
 * row already loaded. Keep the two in lockstep.
 */

import { eq, or, type SQL } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';

import { claimThreads } from '../db/schema';
import type { Env } from '../env';
import { ApiError } from '../errors';
import type { AuthzVariables } from './authz';

/**
 * The release switch (AECI-1553, `STAGE_2_ATTESTATIONS_SPEC.md` §15.16). Threads are on
 * only when the `THREADS_ENABLED` var is exactly `"true"`. Absent, empty or any other
 * value means off, the `STRIPE_CHECKOUT_ENABLED` rule. Production ships `"false"` until
 * the legal drafts are in force.
 */
export function threadsEnabled(env: Pick<Env, 'THREADS_ENABLED'>): boolean {
  return env.THREADS_ENABLED === 'true';
}

/**
 * Mounted on every vendor thread route right after `requireVendor()`, before the write
 * limiter and the handler. Off, the route answers the catch-all's own `404 NOT_FOUND`,
 * so the feature looks absent, and nothing is read, written, audited or rate-limited.
 * The admin thread reads do not take it.
 */
export function requireThreadsEnabled(): MiddlewareHandler<{
  Bindings: Env;
  Variables: AuthzVariables;
}> {
  return async (c, next) => {
    if (!threadsEnabled(c.env)) throw new ApiError(404, 'NOT_FOUND', 'API route not found');
    await next();
  };
}

/** `claim_threads` rows the caller's vendor is one of the two companies on. */
export function threadParticipantWhere(vendorId: string): SQL {
  return or(eq(claimThreads.vendorAId, vendorId), eq(claimThreads.vendorBId, vendorId))!;
}

/** The in-memory twin of {@link threadParticipantWhere}. */
export function isThreadParticipant(
  thread: { readonly vendorAId: string; readonly vendorBId: string },
  vendorId: string,
): boolean {
  return thread.vendorAId === vendorId || thread.vendorBId === vendorId;
}
