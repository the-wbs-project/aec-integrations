/**
 * Worker bindings + vars for the datatool admin Worker.
 *
 * This Worker is unusual: it binds ALL THREE remote D1 databases at once (the
 * whole point — copy/seed any env from one place). Everything optional-secret is
 * graceful-skip: a missing Algolia/CF-purge key degrades the post-write refresh,
 * never the D1 write itself.
 */
export type Env = {
  // ── D1: the three remote application databases (ADR 0016). A deployed Worker
  //    reaches the REAL remote DB through each binding; `wrangler dev` (no
  //    `--remote`) would serve local SQLite copies, which is why LOCAL is not a
  //    copy/seed target for the deployed tool. ──────────────────────────────────
  DB_PREVIEW: D1Database;
  DB_STAGING: D1Database;
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

  /** Algolia application id — shared across envs (one app; indexes/keys differ). */
  ALGOLIA_APP_ID?: string;
  /** Per-env Algolia MANAGEMENT keys (addObject/deleteObject ACLs), used by the
   *  post-write reindex. Absent for an env → that env's reindex is a graceful skip. */
  ALGOLIA_ADMIN_KEY_PREVIEW?: string;
  ALGOLIA_ADMIN_KEY_STAGING?: string;
  ALGOLIA_ADMIN_KEY_PRODUCTION?: string;

  /** Per-env Cloudflare API token scoped to `Zone.Cache Purge`, for the post-write
   *  edge-cache purge. Absent → that env's purge is a graceful skip. */
  CF_PURGE_API_TOKEN_PREVIEW?: string;
  CF_PURGE_API_TOKEN_STAGING?: string;
  CF_PURGE_API_TOKEN_PRODUCTION?: string;
  /** Per-env Cloudflare zone id the purge targets (public value). */
  CF_ZONE_ID_PREVIEW?: string;
  CF_ZONE_ID_STAGING?: string;
  CF_ZONE_ID_PRODUCTION?: string;
};
