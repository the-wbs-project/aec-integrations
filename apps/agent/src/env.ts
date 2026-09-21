/**
 * Worker bindings + vars for the AECi agent Worker (spike).
 *
 * Hand-written in the `apps/datatool` style rather than generated: `wrangler
 * types` would also emit Flue's generated `FLUE_*` Durable Object namespaces,
 * which are build outputs and must not be hand-authored or checked in.
 *
 * Everything below is APPLICATION-owned — the bindings this Worker declares in
 * its own `wrangler.jsonc`. Flue's per-agent Durable Object bindings are added
 * to the resolved config by the Vite plugin and are deliberately absent here.
 */

export type Env = {
  // ── D1: the application database (ADR 0016), read-only for this Worker ─────
  //    Default wrangler env → `aeci-app-preview`; `env.production` →
  //    `aeci-app-production`. This Worker never migrates the schema; apps/api
  //    owns it, which is why there is no `migrations_dir` in wrangler.jsonc.
  DB: D1Database;

  // ── Workers AI ─────────────────────────────────────────────────────────────
  //    Flue reaches Workers AI models (`cloudflare/...` specifiers) through
  //    this binding, so no provider API key is needed for those models.
  AI: Ai;

  // ── AI Search (formerly AutoRAG) ───────────────────────────────────────────
  //    A NAMESPACE binding (`ai_search_namespaces`), not an instance binding:
  //    the namespace `default` always exists, so this can be declared before
  //    any instance is created. AI Search does not run locally, so the binding
  //    carries `remote: true` and `wrangler dev` proxies to the deployed
  //    service. Typed loosely because @cloudflare/workers-types does not yet
  //    ship a type for it.
  AI_SEARCH: unknown;

  // ── R2: the agent's corpus bucket ──────────────────────────────────────────
  //    Holds the documents indexed by AI Search. Populated in a later step.
  CORPUS: R2Bucket;

  // ── Service binding to the private API Worker ──────────────────────────────
  //    Default → `aeci-api-preview`; `env.production` → `aeci-api-production`.
  //    Same seam apps/web uses (`env.API`).
  API: Fetcher;

  // ── Vars (plain, public) ───────────────────────────────────────────────────
  /** `preview` or `production` — the deploy tier, not a Flue concept. */
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

  // ── Secrets ────────────────────────────────────────────────────────────────
  //    Two, and BOTH are optional. There is NO model-provider secret: both legs
  //    run over the `AI` binding (`cloudflare/@cf/...` and
  //    `cloudflare/anthropic/...`), which AI Gateway authenticates against
  //    Cloudflare's own Unified Billing credits. The Worker holds no Anthropic
  //    key and there is no Anthropic account behind it.

  /** Optional shared-secret bearer fallback for curl/CI/local dev when the
   *  Cloudflare Access assertion isn't present. Compared constant-time in
   *  `src/access.ts`. Absent → only the Access JWT authenticates; a request
   *  carrying neither is 403. */
  TOOL_TOKEN?: string;

  /**
   * OPTIONAL. TypeSafe AI key for the Jev relevance filter (`src/lib/jev.ts`),
   * which screens retrieved passages for relevance and for prompt injection
   * before the answering model sees them.
   *
   * **Absent is the default and the supported state.** With no key the filter
   * returns its input unchanged and opens no connection — it is not degraded,
   * it simply does not run. A per-conversation toggle must ALSO be set before
   * anything is sent, so this key alone turns nothing on.
   *
   * It is the only secret on this Worker that causes outbound traffic to a
   * third party. What crosses that boundary is the passage text (public catalog
   * data) and the user's question, and nothing else — the egress note at the
   * top of `src/lib/jev.ts` is the full statement.
   */
  TYPESAFE_API_KEY?: string;

  // ── Local development only ─────────────────────────────────────────────────
  /** Absolute origin of the API Worker, used ONLY when the `API` service
   *  binding does not resolve locally. It does resolve under `vite dev` in
   *  principle, but Miniflare reads `MINIFLARE_REGISTRY_PATH` while this repo's
   *  `dev:bound` isolates the registry with `WRANGLER_REGISTRY_PATH`, so the two
   *  processes look at different directories. See `src/lib/api-client.ts`.
   *  Never set in a deployed environment — `wrangler.jsonc` declares none. */
  API_BASE_URL?: string;
};
