/**
 * Worker bindings + vars for the datatool admin Worker.
 *
 * This Worker is unusual: it binds ALL FOUR remote D1 databases at once (the
 * whole point — copy/seed any env from one place). Everything optional-secret is
 * graceful-skip: a missing Algolia/CF-purge key degrades the post-write refresh,
 * never the D1 write itself.
 */
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

  // NOTE: the Algolia + cache-purge credentials below are SINGLE shared secrets,
  // not per-env. One Algolia app backs every tier (its admin key reaches all
  // `{env}_*` indexes), and staging/demo/production all live on the one
  // `aecintegrations.com` Cloudflare zone — the same values the apps/api + apps/web
  // Workers receive from the un-suffixed `ALGOLIA_*` / `CF_*` GitHub secrets. Only
  // the Algolia index PREFIX differs per env, and that's derived from `algoliaEnv`
  // in targets.ts — not from a per-env key.

  /** Algolia application id — one app across all envs (index prefixes differ). */
  ALGOLIA_APP_ID?: string;
  /** Algolia MANAGEMENT key (addObject/deleteObject ACLs) for the post-write
   *  reindex. One app's admin key reaches every `{env}_*` index, so it's shared.
   *  Absent → reindex is a graceful skip. */
  ALGOLIA_ADMIN_KEY?: string;

  /** Cloudflare API token scoped to `Zone.Cache Purge`, for the post-write edge-
   *  cache purge. Shared — all purgeable tiers are on the one zone. Absent →
   *  purge is a graceful skip. */
  CF_PURGE_API_TOKEN?: string;
  /** The single `aecintegrations.com` Cloudflare zone id the purge targets (public). */
  CF_ZONE_ID?: string;
};
