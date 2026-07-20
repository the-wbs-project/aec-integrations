/**
 * Worker bindings + vars for the datatool admin Worker.
 *
 * This Worker is unusual: it binds ALL FOUR remote D1 databases at once (the
 * whole point — copy/seed any env from one place). Everything optional-secret is
 * graceful-skip: a missing Algolia key or unbound cache-purge queue degrades the
 * post-write refresh, never the D1 write itself.
 */
import type { CachePurgeMessage } from '@aeci/shared/cache-purge';

export type Env = {
  // ── D1: the four remote application databases (ADR 0016), one per deploy tier
  //    (preview → staging → demo → production; docs/environments.md). A deployed
  //    Worker reaches the REAL remote DB through each binding; `wrangler dev` (no
  //    `--remote`) would serve local SQLite copies, which is why LOCAL is not a
  //    copy/seed target for the deployed tool. ──────────────────────────────────
  DB_PREVIEW: D1Database;
  DB_STAGING: D1Database;
  DB_DEMO: D1Database;
  DB_PRODUCTION: D1Database;

  // ── Cache-purge queue producers (WC-7 / AECI-321) ───────────────────────────
  //    One producer per CACHEABLE tier, bound to that tier's own
  //    `aeci-cache-purge-{env}` Queue (WC-5 / AECI-319). After a copy/seed/reindex
  //    the datatool enqueues a `{ purgeEverything: true, source: 'datatool' }`
  //    message that the TARGET tier's SSR Worker consumes (`ctx.cache.purge()`),
  //    so a purge evicts only that tier's own Workers Cache — no cross-tier bleed.
  //    There is intentionally NO `preview` producer: preview is `*.workers.dev`
  //    with no edge cache and no `aeci-cache-purge-preview` queue, so a preview
  //    (or unbound) target is a graceful no-op. See `cache-purge.ts` / `targets.ts`.
  CACHE_PURGE_QUEUE_STAGING?: Queue<CachePurgeMessage>;
  CACHE_PURGE_QUEUE_DEMO?: Queue<CachePurgeMessage>;
  CACHE_PURGE_QUEUE_PRODUCTION?: Queue<CachePurgeMessage>;

  // ── Vars (plain, public) ────────────────────────────────────────────────────
  /** `tool` for this Worker (not a deployment tier). */
  ENV?: string;
  /** AECI-74: injected via `wrangler --var COMMIT_SHA:<sha>`; absent → "unknown". */
  COMMIT_SHA?: string;
  /** AECI-74: injected via `wrangler --var DEPLOYED_AT:<iso>`; absent → epoch. */
  DEPLOYED_AT?: string;
  /** Cloudflare Access application AUD (docs/access.md §1). The in-Worker JWT
   *  check requires the Cf-Access-Jwt-Assertion `aud` to equal this. */
  ACCESS_AUD?: string;
  /** `<team>.cloudflareaccess.com` — issues the Access JWKS used to verify the
   *  assertion. Absent/placeholder → the Access-JWT path can't verify (use
   *  TOOL_TOKEN). */
  ACCESS_TEAM_DOMAIN?: string;

  // ── Secrets (all optional / fail-closed-or-skip) ────────────────────────────
  /** Optional shared-secret bearer fallback for curl/CI when the Access JWT isn't
   *  available. Compared constant-time. Absent → only the Access JWT authenticates. */
  TOOL_TOKEN?: string;

  // NOTE: the Algolia credentials below are a SINGLE shared secret, not per-env.
  // One Algolia app backs every tier (its admin key reaches all `{env}_*` indexes)
  // — the same value the apps/api + apps/web Workers receive from the un-suffixed
  // `ALGOLIA_*` GitHub secret. Only the Algolia index PREFIX differs per env, and
  // that's derived from `algoliaEnv` in targets.ts — not from a per-env key.

  /** Algolia application id — one app across all envs (index prefixes differ). */
  ALGOLIA_APP_ID?: string;
  /** Algolia MANAGEMENT key (addObject/deleteObject ACLs) for the post-write
   *  reindex. One app's admin key reaches every `{env}_*` index, so it's shared.
   *  Absent → reindex is a graceful skip. */
  ALGOLIA_ADMIN_KEY?: string;

  // NOTE: CF_PURGE_API_TOKEN / CF_ZONE_ID are NO LONGER USED by the datatool as of
  // WC-7 (AECI-321) — the post-write purge now enqueues onto the per-tier
  // `aeci-cache-purge-{env}` Queue instead of the (now-inert) zone HTTP purge. They
  // remain declared only so a stale secret doesn't error the deploy; the fields and
  // the `wrangler secret`s are retired globally in WC-10 (ADR 0020 §4).
  /** @deprecated Unused since WC-7 — retired in WC-10. */
  CF_PURGE_API_TOKEN?: string;
  /** @deprecated Unused since WC-7 — retired in WC-10. */
  CF_ZONE_ID?: string;
};
