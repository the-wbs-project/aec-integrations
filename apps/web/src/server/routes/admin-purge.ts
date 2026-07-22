/**
 * `POST /admin/purge` — manual cache invalidation (AECI-56 / Phase 2.10;
 * migrated to native Workers Cache in WC-6 / AECI-320).
 *
 * `docs/CACHE_STRATEGY.md` §5(a) specifies this endpoint as the manual /
 * incident-response + CI purge surface on the SSR Worker. Because the SSR
 * Worker owns its native Cloudflare Workers Cache (WC-3 / AECI-317), the
 * handler invalidates **in-process** via `ctx.cache.purge(...)` — no outbound
 * Cloudflare REST call and no queue hop. The body accepts the three native
 * purge modes — `{ tags }`, `{ pathPrefixes }`, and/or `{ purgeEverything }`
 * (the last is exclusive) — and the handler emits a Datadog log +
 * `aeci.cache.purge` count metric per request.
 *
 * AUTH (unchanged by the migration): `ADMIN_PURGE_TOKEN` — a long-lived
 * Wrangler secret the *caller* presents in the `Authorization: Bearer ...`
 * header. We compare with the shared `timingSafeEqual` (constant-time) so
 * timing doesn't leak. MIGRATION (Phase 6): replace `ADMIN_PURGE_TOKEN` with
 * Cloudflare Access (`docs/CACHE_STRATEGY.md` §5). Until then, the bearer
 * secret is the single auth boundary for this endpoint. `CF_PURGE_API_TOKEN` /
 * `CF_ZONE_ID` are no longer read here (native purge needs neither); those purge
 * secrets were retired in WC-10 (AECI-324).
 *
 * ENTRYPOINT SCOPING (load-bearing): `ctx.cache.purge()` only evicts the
 * *calling entrypoint's* cache, and WC-4 (AECI-318) moved SSR caching onto the
 * named `Renderer` entrypoint (the default export is a cache-OFF gateway). This
 * purge stays correctly scoped for free: the gateway forwards every request to
 * `Renderer.fetch`, which runs this whole Hono `app`, so `c.executionCtx` here
 * IS `Renderer`'s context and `c.executionCtx.cache` is `Renderer`'s namespace —
 * no relocation needed (unlike the WC-5 queue consumer, which delegates into
 * `Renderer.purgeCache()` because the queue routes to the default export). See
 * `docs/CACHE_STRATEGY.md` §5 and ADR 0020 §2.
 *
 * CACHE DISABLED: `ExecutionContext.cache` is optional — it is absent when
 * Workers Cache is not enabled on the entrypoint (bare `wrangler dev` / local
 * miniflare, and the demo/production tiers gated until WC-8 lands). In
 * that case the handler reports a graceful no-op (`200 { success: true,
 * skipped: 'cache_disabled' }`) so CI's post-promote purge and manual callers
 * stay green until native cache is enabled on the tier.
 *
 * RATE LIMITING: `ctx.cache.purge()` shares Cloudflare's zone-purge rate
 * limiter. A rejection resolves to `{ success: false, errors: [...] }` (we
 * return 502 with those errors); the Datadog log captures the outcome.
 *
 * RESPONSE SHAPE:
 *   200 → `{ success: true, errors: [] }` (+ an echo of the requested mode),
 *         or `{ success: true, skipped: 'cache_disabled', errors: [] }`
 *   400 → invalid body (Zod issue summary)
 *   401 → missing / wrong bearer
 *   502 → purge rejected by the platform, with `errors[]` populated
 */

import { timingSafeEqual } from '@aeci/shared';
import type { Context } from 'hono';
import { z } from 'zod';

import type { WebEnv } from '../../env';
import { logToDatadog, submitCount } from '../../server-datadog';

/**
 * Body schema for `POST /admin/purge`. Mirrors the native `ctx.cache.purge()`
 * option shape: one or both of `tags` / `pathPrefixes`, OR `purgeEverything`
 * on its own (the platform treats `purgeEverything` as exclusive). Native
 * Workers Cache allows up to 1000 `Cache-Tag` values per response — far above
 * the retired HTTP purge-by-tag cap (30 tags/call) — so the schema caps
 * generously; the real guard is the platform's purge rate limit.
 */
export const MAX_PURGE_TAGS = 1000;
export const MAX_PURGE_PATH_PREFIXES = 100;

export const PurgeRequestSchema = z
  .object({
    tags: z.array(z.string().min(1)).max(MAX_PURGE_TAGS).optional(),
    pathPrefixes: z.array(z.string().min(1)).max(MAX_PURGE_PATH_PREFIXES).optional(),
    purgeEverything: z.literal(true).optional(),
  })
  .refine((b) => !(b.purgeEverything && (b.tags?.length || b.pathPrefixes?.length)), {
    message: 'purgeEverything is exclusive; do not combine it with tags or pathPrefixes',
  })
  .refine((b) => Boolean(b.purgeEverything || b.tags?.length || b.pathPrefixes?.length), {
    message: 'provide at least one of tags, pathPrefixes, or purgeEverything',
  });

export type PurgeRequest = z.infer<typeof PurgeRequestSchema>;

/** Which native purge mode a request resolved to (Datadog + response echo). */
export type PurgeMode = 'tags' | 'path_prefixes' | 'combined' | 'everything';

export type PurgeResponse = {
  success: boolean;
  errors: CachePurgeError[];
  /** Present (and `success: true`) when native cache is not enabled on the tier. */
  skipped?: 'cache_disabled';
  /** Echo of the requested mode, for operator/observability clarity. */
  tags?: string[];
  pathPrefixes?: string[];
  purgeEverything?: true;
};

type HonoContext = Context<{ Bindings: WebEnv }>;

export function createAdminPurgeHandler(): (c: HonoContext) => Promise<Response> {
  return async (c) => {
    const env = c.env;
    const ctx = c.executionCtx;
    const request = c.req.raw;

    // 1. Auth — Bearer token from Wrangler secret.
    if (!isAuthorized(request, env.ADMIN_PURGE_TOKEN)) {
      return jsonResponse(401, { error: 'unauthorized' });
    }

    // 2. Body — Zod-validated JSON `{ tags?, pathPrefixes?, purgeEverything? }`.
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return jsonResponse(400, { error: 'invalid_json' });
    }
    const parsed = PurgeRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return jsonResponse(400, {
        error: 'invalid_body',
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    const { tags, pathPrefixes, purgeEverything } = parsed.data;
    const mode = resolveMode(parsed.data);
    const source = new URL(request.url).searchParams.get('source') || 'manual';

    // Echo of the requested mode, reused across every response/log branch.
    const echo: Pick<PurgeResponse, 'tags' | 'pathPrefixes' | 'purgeEverything'> = {
      ...(tags ? { tags } : {}),
      ...(pathPrefixes ? { pathPrefixes } : {}),
      ...(purgeEverything ? { purgeEverything } : {}),
    };

    // 3. Native Workers Cache purge. `cache` exists at runtime and in the generated
    //    `worker-configuration.d.ts` `ExecutionContext`, but Hono's own bundled
    //    `ExecutionContext` type (what `c.executionCtx` resolves to) omits it — so cast
    //    to the real runtime type to read `cache?: CacheContext`. Absent ⇒ caching
    //    disabled on this entrypoint (local/miniflare, or a tier gated until WC-8):
    //    report a no-op.
    const cache = (ctx as unknown as ExecutionContext).cache;
    if (!cache) {
      emitPurgeTelemetry(ctx, env, request, {
        source,
        mode,
        tags,
        pathPrefixes,
        outcome: 'skipped',
      });
      return jsonResponse(200, { success: true, skipped: 'cache_disabled', errors: [], ...echo });
    }

    const options: CachePurgeOptions = purgeEverything
      ? { purgeEverything: true }
      : { ...(tags ? { tags } : {}), ...(pathPrefixes ? { pathPrefixes } : {}) };
    const result = await cache.purge(options);

    // 4. Telemetry — Datadog log + `aeci.cache.purge` count metric.
    emitPurgeTelemetry(ctx, env, request, {
      source,
      mode,
      tags,
      pathPrefixes,
      outcome: result.success ? 'ok' : 'failed',
    });

    // 5. Respond.
    if (result.success) {
      return jsonResponse(200, { success: true, errors: [], ...echo });
    }
    return jsonResponse(502, { success: false, errors: result.errors, ...echo });
  };
}

function resolveMode(body: PurgeRequest): PurgeMode {
  if (body.purgeEverything) return 'everything';
  if (body.tags?.length && body.pathPrefixes?.length) return 'combined';
  if (body.pathPrefixes?.length) return 'path_prefixes';
  return 'tags';
}

/**
 * Fire-and-forget Datadog log + count metric for one purge request.
 * `aeci.cache.purge{source,outcome,mode}` powers the dashboard's
 * purge-by-source widget (AECI-66 / Phase 2 §14); the log powers debugging.
 */
function emitPurgeTelemetry(
  ctx: { waitUntil(promise: Promise<unknown>): void },
  env: WebEnv,
  request: Request,
  fields: {
    source: string;
    mode: PurgeMode;
    tags: string[] | undefined;
    pathPrefixes: string[] | undefined;
    outcome: 'ok' | 'failed' | 'skipped';
  },
): void {
  logToDatadog(ctx, env, request, {
    message: 'aeci.cache.purge',
    level: fields.outcome === 'failed' ? 'warn' : 'info',
    source: fields.source,
    mode: fields.mode,
    tags_count: fields.tags?.length ?? 0,
    path_prefix_count: fields.pathPrefixes?.length ?? 0,
    outcome: fields.outcome,
  });
  submitCount(ctx, env, request, 'aeci.cache.purge', 1, [
    `source:${fields.source}`,
    `outcome:${fields.outcome}`,
    `mode:${fields.mode}`,
  ]);
}

function isAuthorized(request: Request, expectedToken: string | undefined): boolean {
  if (!expectedToken) return false;
  const header = request.headers.get('authorization');
  if (!header) return false;
  const match = header.match(/^Bearer\s+(.+)$/);
  if (!match) return false;
  return timingSafeEqual(match[1]!, expectedToken);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    },
  });
}
