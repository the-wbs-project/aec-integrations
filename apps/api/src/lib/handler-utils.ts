/**
 * Shared boilerplate for Phase 2.8 route-handler factories (AECI-111).
 *
 * Both helpers below were previously copy-pasted across the `routes/` files —
 * the DB factory in 9 of them and `validateResponseInDev` in 7. Hoisting them
 * here makes a policy change (e.g. "also skip response validation in staging")
 * a one-file edit instead of a shotgun edit.
 */

import { isPublicSite } from '@aeci/shared/deploy-env';
import type { Context, Env as HonoEnv } from 'hono';

import { getDb, type DbContext, type GetDbOptions } from '../db/client';
import { logToPosthog, submitCount } from '../posthog';
import type { Env } from '../env';

/**
 * Builds a per-request Drizzle/D1 client context from the Worker env (ADR 0016).
 * Injected into route-handler factories (defaulting to `getDb`) so tests pass a
 * client over a local/mock D1. `opts` carries the Sessions-API anchor
 * (`bookmark` / `constraint`); see `getDb`.
 */
export type DbFactory = (env: Env, opts?: GetDbOptions) => DbContext;

/**
 * Hono request-scoped storage for the per-request `DbContext`. Augmenting
 * `ContextVariableMap` makes `c.set/get('dbCtx')` available on every Hono context
 * without threading a Variables type through every router, so `bookmarkMiddleware`
 * can read `getBookmark()` after the handler runs and emit the `x-d1-bookmark`
 * response header. (AECI-250)
 */
declare module 'hono' {
  interface ContextVariableMap {
    dbCtx?: DbContext;
  }
}

/**
 * Write-path DbContext: anchors the D1 session at `'first-primary'` (so a
 * pre-write read sees the latest version — avoids spurious unique-constraint
 * conflicts and wrong create/update branches) and resumes any inbound
 * `x-d1-bookmark` for read-your-writes. Stashes the context so `bookmarkMiddleware`
 * emits the outbound bookmark. Each write handler swaps `dbFor(c.env)` →
 * `writeDb(c, dbFor)`. Reads keep `dbFor(c.env)` (the `'first-unconstrained'`
 * replica-served default). (AECI-250)
 */
export function writeDb<E extends HonoEnv & { Bindings: Env }>(
  c: Context<E>,
  dbFor: DbFactory = getDb,
): DbContext {
  const ctx = dbFor(c.env, {
    bookmark: c.req.header('x-d1-bookmark') ?? null,
    constraint: 'first-primary',
  });
  c.set('dbCtx', ctx);
  return ctx;
}

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
 * without `POSTHOG_PROJECT_KEY` (see `posthog.ts`), so a curated, gap-free DB pays
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
      logToPosthog(c.executionCtx, c.env, c.req.raw, {
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
