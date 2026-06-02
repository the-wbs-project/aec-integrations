/**
 * `POST /admin/purge` — manual cache-tag invalidation (AECI-56 / Phase 2.10).
 *
 * `docs/CACHE_STRATEGY.md` §5 specifies this endpoint as the Phase 2 manual
 * incident-response surface. Body is `{ tags: string[] }` (≤30); the handler
 * proxies to Cloudflare's purge-by-tag API for the configured zone and emits
 * a Datadog log per request.
 *
 * AUTH (Phase 2): two distinct tokens.
 *
 *   1. `ADMIN_PURGE_TOKEN` — long-lived Wrangler secret presented by the
 *      *caller* in the `Authorization: Bearer ...` header. We compare with
 *      the shared `timingSafeEqual` (constant-time) so timing doesn't leak.
 *
 *   2. `CF_PURGE_API_TOKEN` + `CF_ZONE_ID` — credentials *we* use to call
 *      Cloudflare. The CF token must be scoped to `Zone.Cache Purge` on
 *      `aecintegrations.com` only (`docs/CACHE_STRATEGY.md` §5 line 109).
 *      A broader scope is a review-rejection-worthy diff.
 *
 * MIGRATION (Phase 6): replace `ADMIN_PURGE_TOKEN` with Cloudflare Access
 * (`docs/CACHE_STRATEGY.md` §5 line 98). Until then, the bearer secret is the
 * single auth boundary for this endpoint.
 *
 * RATE LIMITING: Cloudflare Pro applies a token-bucket per account. Worker
 * isolates aren't durable across edge nodes, so an in-memory bucket here
 * would silently disagree across regions. We let CF 429s propagate — the
 * response carries them in `failed[]` with the upstream message. Datadog log
 * captures the outcome.
 *
 * RESPONSE SHAPE:
 *   200 → `{ purged: string[], failed: [] }`
 *   400 → invalid body (Zod issue summary)
 *   401 → missing / wrong bearer
 *   502 → Cloudflare upstream failed (incl. 429), with `failed[]` populated
 */

import { timingSafeEqual } from '@aeci/shared';
import type { Context } from 'hono';
import { z } from 'zod';

import type { WebEnv } from '../../env';
import { logToDatadog, submitCount } from '../../server-datadog';

/** Body schema for `POST /admin/purge`. Cloudflare's purge-by-tag accepts up
 * to 30 tags per request (Pro plan); we mirror that limit so a single call
 * always fits in one CF API call. */
export const PurgeRequestSchema = z.object({
  tags: z.array(z.string().min(1)).min(1).max(30),
});

export type PurgeRequest = z.infer<typeof PurgeRequestSchema>;

export type PurgeFailure = { tag: string; reason: string };

export type PurgeResponse = {
  purged: string[];
  failed: PurgeFailure[];
};

type HonoContext = Context<{ Bindings: WebEnv }>;

/**
 * Factory so tests can inject a mocked `fetch` for the Cloudflare API call
 * without monkey-patching the global. Production callers omit `deps`.
 */
export function createAdminPurgeHandler(
  deps: { fetch?: typeof fetch } = {},
): (c: HonoContext) => Promise<Response> {
  const fetchImpl = deps.fetch ?? fetch;

  return async (c) => {
    const env = c.env;
    const ctx = c.executionCtx;
    const request = c.req.raw;

    // 1. Auth — Bearer token from Wrangler secret.
    if (!isAuthorized(request, env.ADMIN_PURGE_TOKEN)) {
      return jsonResponse(401, { error: 'unauthorized' });
    }

    // 2. Body — Zod-validated JSON `{ tags: string[] }`.
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
    const { tags } = parsed.data;

    const source = new URL(request.url).searchParams.get('source') || 'manual';

    // 3. Call Cloudflare purge-by-tag API.
    const cfOutcome = await callCloudflarePurge(fetchImpl, env, tags);

    // 4. Log to Datadog (fire-and-forget).
    logToDatadog(ctx, env, request, {
      message: 'aeci.cache.purge',
      level: cfOutcome.ok ? 'info' : 'warn',
      source,
      tags_count: tags.length,
      outcome: cfOutcome.ok ? 'ok' : 'cf_failed',
      cf_status: cfOutcome.status,
    });

    // AECI-66 / Phase 2 §14 — also emit the `aeci.cache.purge` count metric
    // (the log above powers debugging; this powers the dashboard's
    // purge-by-source widget). Tagged by `source` (manual / future webhook) and
    // `outcome` so failed purges are distinguishable.
    submitCount(ctx, env, request, 'aeci.cache.purge', 1, [
      `source:${source}`,
      `outcome:${cfOutcome.ok ? 'ok' : 'cf_failed'}`,
    ]);

    // 5. Respond.
    if (cfOutcome.ok) {
      const body: PurgeResponse = { purged: tags, failed: [] };
      return jsonResponse(200, body);
    }
    const failed: PurgeFailure[] = tags.map((t) => ({
      tag: t,
      reason: `cf_${cfOutcome.status}: ${cfOutcome.message}`,
    }));
    const body: PurgeResponse = { purged: [], failed };
    return jsonResponse(502, body);
  };
}

function isAuthorized(request: Request, expectedToken: string | undefined): boolean {
  if (!expectedToken) return false;
  const header = request.headers.get('authorization');
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return false;
  return timingSafeEqual(match[1]!, expectedToken);
}

type CfOutcome = { ok: true; status: number } | { ok: false; status: number; message: string };

async function callCloudflarePurge(
  fetchImpl: typeof fetch,
  env: WebEnv,
  tags: string[],
): Promise<CfOutcome> {
  if (!env.CF_PURGE_API_TOKEN || !env.CF_ZONE_ID) {
    return { ok: false, status: 0, message: 'cf_credentials_missing' };
  }
  const url = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/purge_cache`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.CF_PURGE_API_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tags }),
    });
    if (res.ok) return { ok: true, status: res.status };
    let message = res.statusText || 'cf_failed';
    try {
      const body = (await res.json()) as { errors?: Array<{ message?: string }> };
      if (body?.errors?.length) {
        message =
          body.errors
            .map((e) => e.message)
            .filter(Boolean)
            .join('; ') || message;
      }
    } catch {
      // Body wasn't JSON; the statusText is good enough.
    }
    return { ok: false, status: res.status, message };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      message: error instanceof Error ? error.message : 'cf_network_error',
    };
  }
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
