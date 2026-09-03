# 0017 — Single Supabase Auth project for all environments, Cloudflare Access gates per environment

- **Status:** Accepted (2026-06-25)
- **Date:** 2026-06-25
- **Context owner:** chrisw@thewbsproject.com
- **Spec anchor:** `docs/environments.md`, `docs/access.md`, `docs/AUTH_AND_RLS.md`
- **Retains / interacts:** ADR 0015 (Supabase SSR auth on Workers — **unchanged**), ADR 0016 (D1 app DB + the service-role split-identity seams), ADR 0011 (serving-origin canonical), ADR 0012 (Access service-token reuse in CI)
- **New project ref:** `ktuhnlypztujpsseujzx` (`https://ktuhnlypztujpsseujzx.supabase.co`) — the single shared auth project for all environments.

---

## Context

Auth has been split across **two** Supabase projects:

- **dev `dmbygwupskttzsvfzluq`** — PR-preview + staging + local dev,
- **prod `jgxebjufabtwkcgxjqvk`** — production only.

The split was **operational, not architectural**. The prod project pre-existed as the
legacy landing-app database and was kept "as production"; a fresh empty project was
provisioned for development. Two facts have since removed that rationale:

1. The landing-app tables (`feedback`/`mailing_list`) moved to **D1** (AECI-257), so the
   prod Supabase project no longer holds anything load-bearing for the app.
2. The app database is **D1** (ADR 0016), so Supabase is now **auth-only**.

Meanwhile the split actively hurts. Because `auth.users.id` is per-project, the **same
person has a different identity in each environment**. The D1 `profiles.id` is keyed to
that auth id, and `role='admin'` is set per-environment D1 against it — so an admin in
staging is a stranger in production. Concretely: prod D1 `profiles` is empty and admin
could not be established there, because the operator had no auth id in the prod project.

Auth is driven entirely by **`SUPABASE_URL`**: the API Worker verifies JWTs via remote
JWKS at `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` (issuer `${SUPABASE_URL}/auth/v1`,
audience `authenticated` — `apps/api/src/lib/user-auth.ts`); the SSR Worker injects
`{url, anonKey}` into the page (`apps/web/src/supabase-bootstrap-inject.ts`); and the
service-role split-identity seams (ADR 0016) read the same `SUPABASE_URL`
(`apps/api/src/lib/supabase-admin.ts`). Nothing else encodes a project ref except the CSP
`connect-src` and a few CI/doc references. So the project a given environment uses is
purely a config value.

## Decision

**One dedicated Supabase project provides authentication for every environment** (local,
PR-preview, staging, production). Per-environment *visibility* is enforced by **Cloudflare
Access** at the network edge — not by Supabase project separation.

- Provision a **brand-new dedicated auth project** `ktuhnlypztujpsseujzx` (rather than promote one of
  the existing two) so naming is clean and neither legacy project's history leaks in. Every
  environment's `SUPABASE_URL` points at it; existing test accounts are discarded and
  re-seeded into the new project.
- **Cloudflare Access gates each environment by hostname.** Staging and PR-preview stay
  Access-gated (email-OTP allowlist). **Production (`demo.aecintegrations.com`) also goes
  behind Access until launch** (full pre-launch lockdown); the prod Access app is removed
  at launch to make production public. The `aeci-gh-actions` service token is allowed on
  the prod Access policy so CI version/health gates pass (`scripts/verify-version.sh`,
  `scripts/verify-health.sh` already attach the service-token headers when present).
- The retained **Supabase-Postgres "public schema" gate** in CI (`supabase link` /
  `db push` / drift / RLS / taxonomy in `deploy.yml` + `promote-to-prod.yml`) is a
  *separate concern* — it manages the legacy landing/public schema on the **old** projects
  and is untouched by this decision. It is decommissioned with AECI-256/257, not here.

## Consequences

**Positive**
- A person has **one identity across all environments** — admin is set once per env-D1
  against a single auth id, resolving the "prod profiles empty / admin unestablishable"
  blocker.
- Config simplifies: one `SUPABASE_URL`, one anon key, one service-role key, one SMTP/Resend
  config, one redirect-URL allowlist. No per-project drift.
- Environment isolation is explicit and operator-controlled (Cloudflare Access), not an
  accident of which Supabase project a tier happens to use.

**Negative / accepted trade-offs**
- **Shared `auth.users` (test-user pollution).** Staging/PR-preview signups and seeded test
  accounts live in the same `auth.users` as (future) real production users. Accepted
  pre-launch; the **real authorization boundary is the per-environment D1 `profiles.role`**
  — a polluting auth user has no production role unless one is granted in production D1
  (admin is manual SQL). To keep this safe, the `refresh-staging.yml` auth dump/wipe/restore/
  scrub/seed is **removed** (it would otherwise truncate the now-shared `auth.users`); test
  users are seeded directly into the new project instead.
- **One Site-URL fallback and one capacity envelope.** A single project means a single
  magic-link Site-URL fallback (set to `https://demo.aecintegrations.com`) and a single
  MAU/auth-rate budget — so the new project must be on a **paid tier** with Resend custom
  SMTP active before production relies on it.
- **Cookie-name change on cutover.** The `@supabase/ssr` cookie is `sb-<ref>-auth-token`;
  flipping `SUPABASE_URL` changes `<ref>`, so any existing session is silently dropped and
  the user re-signs-in. Pre-launch this affects ~nobody.

## Implementation (summary; full runbook in `docs/environments.md`)

1. Provision `ktuhnlypztujpsseujzx` on a paid tier; configure redirect URLs for **all** origins
   (staging, demo/prod, future apex, `*.aec-integrations.workers.dev`, localhost:8788/8790),
   Site URL → demo, Resend SMTP, Google OAuth.
2. Flip `SUPABASE_URL` in `apps/web/wrangler.jsonc` (3 env blocks) and
   `apps/api/wrangler.jsonc` (4 spots); replace the CSP ref in
   `apps/web/src/server/seo-headers.ts` (+ same-PR spec edit); update `.dev.vars.example`.
3. Set the single un-suffixed `SUPABASE_ANON_KEY` GH secret to the new project's anon key
   — every deploy/promote/preview workflow pushes that one secret (the former per-env
   `SUPABASE_ANON_KEY_{STAGING,PRODUCTION}` secrets are retired; leaving the URL flipped to
   the new project while a workflow still pushed an old per-project key is what produced the
   `Invalid API key` sign-in failure). Set the un-suffixed `SUPABASE_SERVICE_ROLE_KEY` on the
   same footing — one value for every env; CI pushes it to the **API Worker** on
   staging/demo/production for the `AUTH_AND_RLS.md` §3.1 split-identity seams (AECI-530,
   per ADR 0016 §6), never to a web Worker and never to a per-PR preview. Because one project
   backs every environment, rotating it invalidates all three tiers at once — see
   `docs/CICD_PLAN.md` §7.4 and `docs/environments.md` §Secrets.
4. Add `demo.aecintegrations.com` to a Cloudflare Access app; allow the `aeci-gh-actions`
   service token; plumb `CF_ACCESS_CLIENT_*` into the prod smoke in `promote-to-prod.yml`.
5. Seed test users into the new project; establish admin in all three D1s against the single
   new auth id.

At launch, removing the production Access app makes prod public; the prod `CF_ACCESS_*`
vars then become a harmless no-op (the verify scripts only attach headers when present).
