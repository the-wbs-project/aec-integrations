/**
 * Shared boilerplate for Phase 2.8 route-handler factories (AECI-111).
 *
 * Both helpers below were previously copy-pasted across the `routes/` files —
 * `PrismaFactory` in 9 of them and `validateResponseInDev` in 7. Hoisting them
 * here makes a policy change (e.g. "also skip response validation in staging")
 * a one-file edit instead of a shotgun edit.
 */

import type { Env } from '../env';
import type { AcceleratedPrisma } from '../prisma';

/**
 * Builds a per-request Accelerated Prisma client from the Worker env. Injected
 * into route-handler factories (defaulting to `getPrisma`) so tests can pass a
 * mock client.
 */
export type PrismaFactory = (env: Env) => AcceleratedPrisma;

/**
 * Inline response-shape validation. Phase 2.8 acceptance criterion requires
 * the response to be Zod-validated in dev/preview/staging so mapper drift
 * fails loudly, but stripped in production to avoid the per-request cost.
 */
export function validateResponseInDev(env: Env, validate: () => void): void {
  if (env.ENV !== 'production') validate();
}
