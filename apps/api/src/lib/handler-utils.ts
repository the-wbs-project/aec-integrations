/**
 * Shared boilerplate for Phase 2.8 route-handler factories (AECI-111).
 *
 * Both helpers below were previously copy-pasted across the `routes/` files —
 * the DB factory in 9 of them and `validateResponseInDev` in 7. Hoisting them
 * here makes a policy change (e.g. "also skip response validation in staging")
 * a one-file edit instead of a shotgun edit.
 */

import { isPublicSite } from '@aeci/shared/deploy-env';
import type { Context } from 'hono';

import type { DbContext } from '../db/client';
import { logToDatadog, submitCount } from '../datadog';
import type { Env } from '../env';

/**
 * Builds a per-request Drizzle/D1 client context from the Worker env (ADR 0016).
 * Injected into route-handler factories (defaulting to `getDb`) so tests pass a
 * client over a local/mock D1. The optional `bookmark` is the Sessions-API seam.
 */
export type DbFactory = (env: Env, bookmark?: string | null) => DbContext;

/**
 * Inline response-shape validation. Phase 2.8 acceptance criterion requires
 * the response to be Zod-validated in dev/preview/staging so mapper drift
 * fails loudly, but stripped on the public tiers (production + demo, which run
 * the real build at audience traffic) to avoid the per-request cost.
 */
export function validateResponseInDev(env: Env, validate: () => void): void {
  if (!isPublicSite(env.ENV)) validate();
}

/** Shape needed to detect + report a product with no primary vendor. */
type VendorBearingProduct = { id: string; slug: string; vendor: unknown };

/**
 * Data-gap observability for missing primary vendors (AECI-115). A product with
 * no `ProductVendor` row is rendered as an empty state instead of a fabricated
 * `/vendors/unknown` link — but that gap would otherwise be invisible to
 * operators. For every product whose `vendor` is `null` we emit a `warn` log
 * (naming the slug) and bump the `aeci.api.data_gap` count metric so the gap is
 * visible in Datadog. Best-effort: both helpers are fire-and-forget and no-op
 * without `DD_API_KEY` (see `datadog.ts`), so a curated, gap-free DB pays
 * nothing. The emit is wrapped in try/catch — like `metricsMiddleware` — so a
 * missing `ExecutionContext` (non-Worker test harness) can never turn a
 * legitimately vendorless product into a 500; observability MUST NOT break the
 * request path. Cataloged in `docs/OBSERVABILITY.md` §14.
 */
export function reportMissingVendors(
  c: Context<{ Bindings: Env }>,
  products: ReadonlyArray<VendorBearingProduct>,
): void {
  const missing = products.filter((p) => p.vendor === null);
  if (missing.length === 0) return;

  try {
    for (const p of missing) {
      logToDatadog(c.executionCtx, c.env, c.req.raw, {
        level: 'warn',
        message: `Data gap: product ${p.slug} has no primary vendor`,
        data_gap: 'missing_vendor',
        product_id: p.id,
        product_slug: p.slug,
      });
    }
    submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.api.data_gap', missing.length, [
      'gap_type:missing_vendor',
    ]);
  } catch (error) {
    // Observability MUST NOT break the request path — including a missing
    // ExecutionContext in non-Worker test harnesses (mirrors metricsMiddleware).
    console.warn('reportMissingVendors: emit failed', error);
  }
}
