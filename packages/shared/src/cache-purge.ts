/**
 * Cloudflare purge-by-tag transport (AECI-105 / Option B).
 *
 * Single source of truth for the one outbound call that actually invalidates the
 * edge cache: `POST https://api.cloudflare.com/.../zones/{zone}/purge_cache` with
 * a `{ tags }` body. Both call sites use it without re-implementing the contract:
 *
 *   - the SSR Worker's manual `POST /admin/purge` endpoint
 *     (`apps/web/src/server/routes/admin-purge.ts`), and
 *   - the API Worker's post-promote purge (`apps/api/src/routes/promote.ts`).
 *
 * This is *pure transport*: it performs no auth of its own caller, it only
 * presents the Cloudflare API token. Callers decide **whether** to purge (do they
 * hold credentials?) and **what** tags to send. Originally this lived only on the
 * web Worker, and the API reached it over a web↔api service binding; Option B
 * removed that cycle by letting any credentialed Worker call Cloudflare directly.
 * See `docs/adr/0010-promote-purges-cloudflare-directly.md`.
 *
 * Cloudflare accepts up to `CF_PURGE_MAX_TAGS` (30) tags per call on the Pro
 * plan; callers that may exceed that must batch.
 */

/** Max `Cache-Tag`s Cloudflare purge-by-tag accepts per request (Pro plan). */
export const CF_PURGE_MAX_TAGS = 30;

export type CfPurgeOutcome =
  | { ok: true; status: number }
  | { ok: false; status: number; message: string };

export type CfPurgeCredentials = {
  /**
   * Cloudflare API token scoped to `Zone.Cache Purge` on the target zone only
   * (`docs/CACHE_STRATEGY.md` §5). Optional so callers can pass an env value
   * straight through; absent → `cf_credentials_missing`.
   */
  apiToken: string | undefined;
  /** Cloudflare zone ID the purge targets. Absent → `cf_credentials_missing`. */
  zoneId: string | undefined;
};

/**
 * Purge `tags` from the Cloudflare edge cache for the given zone. Never throws —
 * a network error or non-2xx upstream is returned as a structured
 * `{ ok: false }` outcome so callers can log / surface it without a try/catch.
 *
 * `fetchImpl` is injected (defaults to the global `fetch`) so tests can supply a
 * mock without monkey-patching the global.
 */
export async function callCloudflarePurge(
  fetchImpl: typeof fetch,
  creds: CfPurgeCredentials,
  tags: string[],
): Promise<CfPurgeOutcome> {
  if (!creds.apiToken || !creds.zoneId) {
    return { ok: false, status: 0, message: 'cf_credentials_missing' };
  }
  const url = `https://api.cloudflare.com/client/v4/zones/${creds.zoneId}/purge_cache`;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${creds.apiToken}`,
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

// ─── Cross-Worker queue purge (WC-5 / ADR 0020 §3) ───────────────────────────
//
// The transport above (`callCloudflarePurge`) is a zone-level HTTP purge and is
// **inert against native Workers Cache** — `ctx.cache.purge()` is entrypoint-scoped
// and "no zone configuration for caching applies to Workers Caching". So a writer in
// the API Worker can no longer invalidate SSR HTML cached in front of the SSR Worker
// by calling Cloudflare directly. Instead, API-Worker producers (`POST /api/promote`,
// review moderation) enqueue a typed message onto `aeci-cache-purge-{env}`, and a
// `queue()` consumer on the SSR Worker issues `ctx.cache.purge()` from its own cache.
// See `docs/adr/0020-workers-cache-and-queue-purge.md` §3 and `docs/CACHE_STRATEGY.md` §5.

/** Which producer enqueued a purge — carried on the message so the SSR consumer can
 *  tag its `aeci.cache.purge{source:…}` metric (the metric moved off the producers to
 *  the consumer in WC-5). `manual` = SSR `/admin/purge` (WC-6), `datatool` = WC-7. */
export type CachePurgeSource = 'promote' | 'moderation' | 'manual' | 'datatool';

/**
 * The typed payload on the `aeci-cache-purge-{env}` Cloudflare Queue. Its purge
 * fields mirror Cloudflare's `CachePurgeOptions` (`ctx.cache.purge(options)`), so the
 * SSR consumer can forward them straight through. WC-5 producers only ever send
 * `{ tags, source }`; `pathPrefixes` / `purgeEverything` are ADR-0020 room for the
 * datatool broad purge (WC-7) and future callers.
 */
export type CachePurgeMessage = {
  tags?: string[];
  pathPrefixes?: string[];
  purgeEverything?: boolean;
  source: CachePurgeSource;
};

/**
 * Max `Cache-Tag`s a single Cloudflare Queue message can carry. The queue's own
 * limit is 1000 tags per `ctx.cache.purge()` call (vs. the Pro-plan HTTP purge's
 * `CF_PURGE_MAX_TAGS = 30`), so queue producers do **not** batch — a promote's tag
 * set fits in one message.
 */
export const CACHE_PURGE_QUEUE_MAX_TAGS = 1000;
