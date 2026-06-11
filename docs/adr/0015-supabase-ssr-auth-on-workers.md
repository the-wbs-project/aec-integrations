# 0015 — Supabase Auth on Cloudflare Workers: `@supabase/ssr` cookies + JWKS verification

- **Status:** Accepted (2026-06-10, AECI-193 / Phase 5.2)
- **Spec anchor:** `docs/STAGE_1_PHASE_5_SPEC.md` §4.1, §2; `docs/AUTH_AND_RLS.md` §3–§4

## Context

Phase 5 turns the read-only directory into a participatory one (sign-in,
reviews, account). AECI-193 is the gating spike every other Phase 5 auth issue
depends on: prove Supabase Auth works on the Cloudflare Workers runtime
(`workerd`) and land the two permanent client factories — a cookie-session
factory on the SSR Worker and a user-JWT verifier on the private API Worker —
before any login UI (5.3), OAuth callback (5.4), or production authz middleware
(5.5) is built.

Two runtime risks made this a spike rather than a straight build:

1. **`@supabase/ssr` on `workerd`.** The library is written for Node/edge
   server runtimes; its realtime/`supabase-js` import graph can pull in
   side-effecting modules that fail to evaluate on `workerd`. If it didn't run,
   the fallback was a hand-rolled PKCE cookie flow.
2. **Token signing algorithm.** `AUTH_AND_RLS.md` §4 mandates user-JWT
   verification with **no DB round-trip** — i.e. verify the JWT signature
   locally against the project's published JWKS. That only works if issued
   access tokens are asymmetrically signed (ES256). A project still on the
   legacy symmetric HS256 secret would force a shared-secret fallback.

## Decision

- **SSR Worker** verifies the *session* via `@supabase/ssr`'s
  `createServerClient`, wired to a Hono `getAll`/`setAll` cookie adapter
  (`apps/web/src/server/auth/supabase-server-client.ts`). Cookie names pass
  through verbatim — chunking (`sb-<ref>-auth-token.0/.1`) and `base64-` value
  encoding stay the library's responsibility, which keeps us byte-compatible
  with its browser client (5.3). Library defaults (PKCE + cookie storage) are
  left untouched — they are exactly what the 5.4 callback needs.
- **API Worker** verifies the *bearer token* the SSR Worker forwards, locally,
  against the project JWKS using `jose` (`createRemoteJWKSet` + `jwtVerify`
  with `issuer`/`audience` pins) in `apps/api/src/lib/user-auth.ts`. No Supabase
  client, **no DB round-trip**, and crucially **no `nodejs_compat` flag** — the
  `jose` path is pure WebCrypto + `fetch`. The remote key set is memoized per
  `SUPABASE_URL` at module scope and fetched lazily inside a request.
- **Secrets posture.** `SUPABASE_URL` is a public wrangler `var` per env (dev
  project for preview/staging, prod project for production).
  `SUPABASE_ANON_KEY` is a CI-pushed secret on the **web Worker only** (secret
  only to keep values out of git; same convention as `ALGOLIA_SEARCH_KEY`). The
  **service-role key is never set on any Worker** (`AUTH_AND_RLS.md` §3). The
  API Worker carries neither key — it verifies with public JWKS material alone.
- **No new public ingress.** The API Worker stays service-binding-only; the
  spike's `GET /api/auth/whoami` is reached only over the binding, like every
  other route.

## Observed outcomes (the spike actually ran)

Validated end-to-end on the bound local stack against the shared dev project
(`dmbygwupskttzsvfzluq`) with a real minted session:

- **`@supabase/ssr` runs clean on `workerd`** — no import-side-effect friction.
  `createServerClient` + `auth.getClaims()` / `getSession()` work in the SSR
  Worker. The hand-rolled-PKCE escape hatch was **not needed**.
- **Issued access tokens are ES256** (header `alg: ES256`, `kid` present),
  matching the JWKS published at `/auth/v1/.well-known/jwks.json` for both the
  dev and prod projects. The HS256 `SUPABASE_JWT_SECRET` fallback that §4.1
  permits was **not needed** and is not wired.
- **JWKS verification works on the API Worker with zero compatibility flags.**
  `jose`'s `createRemoteJWKSet` fetches and caches the keys; `jwtVerify`
  resolves a valid token to its `sub`/`email`. Confirmed by both a live
  integration test (real remote JWKS) and the manual full-chain smoke.
- **Full chain proven:** cookie → `@supabase/ssr` session on `workerd` →
  `Authorization: Bearer <access_token>` over the service binding → `jose`/JWKS
  on the compat-flag-free API Worker → `200 { ssr, api }`. Without a session:
  `401 unauthenticated`, `Cache-Control: private, no-store`.

## Consequences

- The two factories are permanent; 5.3/5.4/5.5 build on them. The
  `/auth/whoami` smoke routes (SSR + API) are **throwaway** — marked
  `THROWAWAY(AECI-193)` and removed when 5.5 lands real authz middleware.
- All user-JWT verification failures (missing/garbage/expired token, wrong
  issuer or audience, missing `sub`, unset `SUPABASE_URL`) collapse to one
  fail-closed `ApiError(401, UNAUTHENTICATED)` — no oracle.
- `errorHandler()` was made generic over the router env so a `Variables`-
  extended sub-router (the one whose middleware sets `c.get('user')`) can reuse
  it without forking.
- **Anon-key posture is graceful now, fail-closed in 5.5.** The CI pushes
  `SUPABASE_ANON_KEY` to the web Worker on every deploy but **warn-and-skips**
  when the GH secret is absent (the prod-Algolia lesson: don't fail-close a
  spike). An unprovisioned Worker returns `503 auth_not_configured` (distinct
  from 401, so the "no session" smoke stays honest). The deploy/promote/preview
  workflows carry a "flip to REQUIRED in 5.5" marker.
- The session cookie is **not** in `VISITOR_STATE_COOKIES`: it is a session
  credential, not render-affecting visitor state, and `/auth/*` is already
  non-cacheable via the fail-closed route classifier — so it never reaches a
  cacheable SSR render and the edge-cache-poisoning rule is satisfied without a
  classifier change.
- A kept dev tool, `apps/web/scripts/mint-dev-session.mjs`, mints a real
  session (prints the JWT header, the bearer token, and a ready-to-paste
  `Cookie:` header) so the 200-path smoke is reproducible until login UI lands.
