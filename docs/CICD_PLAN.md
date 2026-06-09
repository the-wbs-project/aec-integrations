# AEC Integrations — CI/CD Plan

**Referenced by:** `STAGE_1_SPEC.md` §16 (Build Order), §24 (Development Workflow)
**Version:** 1.0
**Date:** May 2026

---

## 1. Platform: GitHub Actions

GitHub Actions is the CI/CD platform. Cloudflare Workers Builds is rejected for reasons below.

**Why GitHub Actions:**
- Already using GitHub for source control
- Native integration with Wrangler for Cloudflare deploys via `cloudflare/wrangler-action`
- Linear's GitHub integration triggers off PR/commit events
- Massive ecosystem of pre-built actions (axe-core, Lighthouse CI, Playwright)
- Generous free tier (unlimited for public repos; 2,000 minutes/month for private)
- Mature secret management with environment scoping

**Why not Cloudflare Workers Builds:**
- Designed for simple build-and-deploy workflows
- Less flexible for the multi-step pipeline we need (lint, type check, test, build, deploy, smoke test)
- Smaller ecosystem of reusable steps
- Workers Builds is fine for "deploy on push" projects — we need more

---

## 2. Environments

> **Current state (deviation from spec) — set 2026-05-18, updated 2026-05-26.**
> - **Staging** is auto-deployed on merge to `main` via `.github/workflows/deploy.yml` `deploy-staging` job, gated by `vars.STAGING_ENABLED`.
> - **Production** is promoted manually via `.github/workflows/promote-to-prod.yml` (AECI-78) — `workflow_dispatch` with explicit `commit_sha` + `confirm=PROMOTE` inputs and a GH Environment approval gate. There is intentionally **no auto-deploy to production**.
> - **Per-PR previews** are wired via `.github/workflows/pr-preview.yml` (AECI-79). Only the SSR Worker is per-PR (`aeci-web-pr-<N>` on `*.aec-integrations.workers.dev`); the API Worker is shared (`aeci-api-preview`) and connects to the dev project's `main` branch via Prisma Accelerate. See `docs/environments.md` §"PR previews" for the DB-strategy decision (Option 1 — shared dev DB).
> The 3-env target below is now wired end-to-end.

Three environments, all on Cloudflare:

| Environment | URL pattern | Triggered by | Auto/Manual | Data |
|---|---|---|---|---|
| **Preview** | `aeci-web-pr-<N>.aec-integrations.workers.dev` | Every PR push | Auto | Shared dev DB via `aeci-api-preview` (Option 1, see environments.md) |
| **Staging** | `staging.aecintegrations.com` | Merge to `main` | Auto | Staging Supabase project |
| **Production** | `demo.aecintegrations.com` | Manual approval after staging | Manual | Production Supabase |

### 2.1 Preview environment

Spun up per PR by [`pr-preview.yml`](../.github/workflows/pr-preview.yml) (AECI-79). Provides a working deployment for human review; the preview-URL E2E / integration-runner jobs remain parked in `deploy.yml` pending separate work to bridge them across workflows. (E2E, axe, and Lighthouse already run **on every PR** against a local `dev:bound` server in `deploy.yml` — the `lighthouse` job was un-parked and repointed at `dev:bound` in AECI-65, so it no longer needs a deployed preview.)

- Each PR gets a unique SSR Worker `aeci-web-pr-<N>` at `https://aeci-web-pr-<N>.aec-integrations.workers.dev`.
- Auto-deletes when the PR is closed or merged (cleanup job in the same workflow).
- **DB:** shared dev project `main` branch via the shared `aeci-api-preview` Worker and Prisma Accelerate. No per-PR Supabase branches (Option 1; see `docs/environments.md` §"PR previews" for the trade-off and revisit conditions for Options 2/3).
- Fronted by the "AECi Non-Prod" Cloudflare Access app — service token for CI, OTP-to-email for humans (see `docs/access.md`).
- Datadog, Loops, and Linear behaviour for previews is shared with staging (preview Workers don't have their own integrations — they ride on whatever the shared `aeci-api-preview` is wired to). **Algolia is the exception:** previews use their own dedicated `preview_*` index set (and `preview` scoped keys), per §7.5 — so preview/local search can't poison staging data. Local `pnpm dev:bound` (`ENV=preview`) rides the same `preview_*` set.

### 2.2 Staging environment

Mirror of production, but with test data and isolated from real users.

- Always reflects the latest `main` branch
- Connects to a dedicated staging Supabase project
- Algolia connects to dedicated staging indexes (`staging_*`; physical naming per §7.5)
- Datadog under `env:staging` tag
- Loops sends real emails but only to allowlisted internal addresses
- Linear creates real issues in a "Staging Test" project
- Used for smoke tests, manual QA, and demos
- **Network-level access control:** staging and `*.aec-integrations.workers.dev` previews sit behind Cloudflare Access (email-allowlist OTP for humans, service token for CI). Production is intentionally public. See [`access.md`](./access.md) for the runbook (allowlist management, service-token rotation, lockout recovery).

### 2.3 Production environment

The real site. Promoted from staging via manual approval — see `docs/environments.md` → "Promote runbook" for the operator flow.

- Deployed only after staging deployment is verified
- Manual approval gate in GitHub Environments (Chris clicks "Approve" button on the `apply-prod-migrations` job in `.github/workflows/promote-to-prod.yml`)
- Connects to production Supabase
- Production Algolia indexes
- Datadog under `env:production` tag, with deployment markers
- Loops sends to real users
- Linear is the live vendor request destination

---

## 3. Pipeline

### 3.1 On every PR push

Runs in parallel where possible to minimize wall time. Goal: under 10 minutes total.

**Job: `lint-and-types`** (~2 min)
1. Checkout
2. Setup Node 24 with cache
3. `pnpm install --frozen-lockfile`
4. `pnpm run lint` (ESLint + Prettier)
5. `pnpm run typecheck` (`tsc --noEmit` across the monorepo)

**Job: `unit-tests`** (~3 min)
1. Checkout, install
2. `pnpm run test:unit` (Vitest)
3. `pnpm -r run test:coverage` as an **advisory, non-blocking** step
   (`continue-on-error`); uploads the lcov/HTML `coverage` artifact
4. Coverage is **reported, not gated** — a drop does not fail the job
   (`TESTING_STRATEGY.md` §3.3). There is no Codecov integration today.

**Job: `integration-db-tests`** (~5 min, AECI-90) — *non-blocking*
1. Checkout, install, `prisma generate`
2. Boot a full local Supabase stack on the runner (`supabase start`)
3. Map `supabase status -o env` → the spec env vars; mint a non-admin
   `SUPABASE_TEST_USER_JWT`
4. Run the `apps/api` `src/integration/**` suites (PostgREST RLS deny matrix,
   auth-user-delete GDPR trigger, idempotent Airtable→Supabase bulk migrate,
   landing-form RLS, product-count drift, slug backfill) via
   `test:integration:ci`
5. Fail on a **0-collected or silently-skipped** result (the suites
   `describe.skipIf` on env, so a misconfigured job would skip-and-pass). Not in
   `deploy-staging`'s `needs` yet — promote to a required check once stable. See
   `TESTING_STRATEGY.md` §6.5.

**Job: `build`** (~3 min)
1. Checkout, install
2. `pnpm run build` (Angular SSR build for Cloudflare Workers)
3. Bundle size check against budget (defined in `TESTING_STRATEGY.md`)
4. Upload build artifact for downstream jobs

**Per-PR preview deploy** — lives in the separate [`pr-preview.yml`](../.github/workflows/pr-preview.yml) workflow (AECI-79), not as a job in `deploy.yml`. Triggered by `pull_request` (`opened` / `synchronize` / `reopened`); the deploy job builds the SSR Worker, runs `wrangler deploy --env preview --name aeci-web-pr-<N>` with `COMMIT_SHA` + `DEPLOYED_AT` vars, verifies both `/api/version` (API Worker) and `/_version` (SSR Worker, AECI-92) report the PR head SHA, and posts a sticky PR comment with the preview URL. The matching `closed` event teardown runs `wrangler delete`. No Supabase migrations are applied per-PR under the current Option 1 strategy.

**Job: `e2e-tests`** (depends on `deploy-preview`, ~5 min)
1. Wait for preview deployment health check
2. Run Playwright E2E suite against preview URL
3. Capture screenshots and traces on failure
4. Upload Playwright report as artifact

**Job: `accessibility`** (depends on `deploy-preview`, ~2 min)
1. Run axe-core via Playwright against key pages on preview
2. Fail if any violations above "moderate" severity
3. Comment on PR with summary if violations found

**Job: `lighthouse`** (depends on `deploy-preview`, ~3 min)
1. Run Lighthouse CI against preview URL for home, product, vendor pages
2. Compare against performance budget (Core Web Vitals targets)
3. Fail if LCP > 2.5s, INP > 200ms, CLS > 0.1, or Accessibility < 95
4. Comment on PR with scores

**Aggregate PR result:**
- All checks green: PR is mergeable
- Any check failed: merge blocked, PR comment shows failure details

### 3.2 On merge to `main`

> **Not currently wired — see §2 callout.** Merges to `main` re-run CI (lint, typecheck, unit tests, build) only; no environment is deployed.

Re-runs all PR checks against the merged code (in case of merge conflicts), then deploys to staging.

**Job: `deploy-staging`**
1. All PR checks repeat (lint, types, tests, build)
2. Run pending Supabase migrations against staging
3. `wrangler deploy --env staging`
4. Run smoke test suite against staging (Playwright subset, ~2 min)
5. Update Algolia staging indexes if schema changed
6. Send deployment marker to Datadog
7. Notify Slack: "Staging updated, awaiting production approval"
8. Open GitHub Environment approval request

### 3.3 On manual production approval

Production deploys run via `.github/workflows/promote-to-prod.yml` (AECI-78). See `docs/environments.md` → "Promote runbook" for the operator flow.

Triggered by Chris (workflow_dispatch with `commit_sha` + `confirm=PROMOTE` inputs) and gated by the `production` GH Environment approval on the `apply-prod-migrations` job. Three jobs in order:

**Job: `pre-promotion-checks`**
1. Validate `confirm == PROMOTE`
2. Checkout at `inputs.commit_sha`
3. Assert staging reports the same SHA on **both** `staging.aecintegrations.com/api/version` (API Worker) and `/_version` (SSR Worker, AECI-92) via `scripts/verify-version.sh`, else fail with `staging is not at <input> on both Workers (API + SSR), refusing to promote` (the script logs the actual per-Worker SHAs). `/api/version` alone is proxied raw to the API Worker, so it can't catch a stale SSR deploy.
4. Print `supabase migration list --linked` against prod into the step summary

**Job: `apply-prod-migrations`** (gated by GH Environment `production`)
1. `pg_dump` prod → R2 (`aeci-prod-snapshots/prod-pre-<short-sha>.dump`)
2. `supabase db push --linked`
3. `scripts/prisma-drift-check.sh` against `DIRECT_URL_PRODUCTION` — HARD STOP on drift

**Job: `deploy-prod-workers`**
1. Deploy `apps/api` with `--env production --var COMMIT_SHA --var DEPLOYED_AT`
2. Deploy `apps/web` with `--env production --var COMMIT_SHA --var DEPLOYED_AT`
3. Post Datadog deployment marker (§9.1)
4. Poll both `demo.aecintegrations.com/api/version` (API Worker) and `/_version` (SSR Worker, AECI-92) until **both** return the promoted SHA (60s budget) via `scripts/verify-version.sh`
5. Write summary (commit, R2 snapshot path, snapshot size, DEPLOYED_AT, actor)

Algolia index updates, release-tag automation, and Slack notifications are out of scope until later epics.

### 3.4 On release tag (e.g. `v1.0.0`)

Triggered when a release tag is pushed.

- Same as production approval, but also:
  - Generates changelog from commit messages since previous tag
  - Creates a GitHub Release with the changelog
  - Posts release notes to Slack and any internal communication channels

---

## 4. Deployment mechanics

### 4.1 Wrangler

Wrangler is the only deployment tool. Single source of truth for Worker configuration.

**Configuration files:**
- `wrangler.jsonc` per Worker package (e.g., `apps/web/wrangler.jsonc`, `apps/api/wrangler.jsonc`), with environment overrides under `env.preview`, `env.staging`, `env.production`. JSONC is preferred over TOML because it allows comments and matches the validated pattern in `apps/web/wrangler.jsonc` and `apps/api/wrangler.jsonc`.
- Compatibility date locked per environment to prevent surprise Worker runtime changes
- SSR Worker requires `"compatibility_flags": ["nodejs_compat"]` — needed for `@angular/ssr` runtime Node polyfills. This is unrelated to database access; Prisma still uses Accelerate (HTTPS), see `DATABASE_SCHEMA.md` §1a.
- API Worker does not need `nodejs_compat` (it talks to Supabase via Accelerate HTTPS).
- Custom domain routing uses `routes` with `"custom_domain": true` per the `apps/web/wrangler.jsonc:78-85` pattern, not zone-level `route` strings.

**Pattern (SSR Worker — `apps/web/wrangler.jsonc`):**
```jsonc
{
  "name": "aeci-ssr",
  "main": "dist/server/server.mjs",
  "compatibility_date": "2026-05-13",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "binding": "ASSETS", "directory": "./dist/browser" },
  "observability": { "enabled": true },
  "env": {
    "preview": { "vars": { "ENV": "preview" } },
    "staging": {
      "vars": { "ENV": "staging" },
      "routes": [{ "pattern": "staging.aecintegrations.com", "custom_domain": true }]
    },
    "production": {
      "vars": { "ENV": "production" },
      // demo.aecintegrations.com ONLY (pre-launch); apex + www stay on the landing Worker
      "routes": [{ "pattern": "demo.aecintegrations.com", "custom_domain": true }]
    }
  }
}
```

The multi-locale Angular build emits a single `server.mjs` that dispatches by URL prefix (`/`, `/es`, etc.) — no per-locale deploys, no per-locale Workers. The deploy command is just `wrangler deploy --env <env>`. See `STAGE_1_SPEC.md` §7a.3a.

### 4.2 Service bindings

The SSR Worker calls the API Worker via service binding, configured per environment:

```toml
[[env.production.services]]
binding = "API"
service = "aeci-api-production"
```

The API Worker is private — has no route, only callable via the service binding. This pattern is identical across environments.

### 4.3 Atomic deploys

Both Workers (SSR and API) deploy together as a single pipeline step. If either fails to deploy, the other is rolled back. This prevents an inconsistent state where the SSR Worker is calling a stale API Worker (or vice versa).

Implementation: deploy API Worker first, run health check, deploy SSR Worker, run smoke tests. If smoke tests fail, rollback both.

---

## 5. Database migrations

> **Pending AECI-71.** This section describes the *target* CI flow once the env-strategy issue wires migration application into the pipeline. As of AECI-72, the migration tool changed from Prisma to Supabase CLI but the CI invocations below are not yet automated — `supabase db push --linked` is run manually against the dev project by developers. AECI-71 owns turning these manual steps into pipeline jobs.

Supabase migrations run as part of the deploy pipeline.

### 5.1 Migration source

Migrations live in `supabase/migrations/` and are committed alongside code changes that depend on them. Generated via `pnpm db:new <name>` locally (see `docs/migrations.md`); applied via `pnpm db:push` (which runs `supabase db push --linked`) in CI.

`supabase db push` reads `DIRECT_URL` (the Supabase pooler `postgresql://` URL), not `DATABASE_URL` (the runtime Prisma Accelerate `prisma://` URL). Workers never see `DIRECT_URL`. See `DATABASE_SCHEMA.md` §1a for the two-URL split.

### 5.2 Forward-only

Migrations are forward-only. No automated rollback. If a migration is bad:

- The migration was reviewed in the PR and shouldn't have merged
- If it lands in staging and breaks something, write a new migration to fix it
- Never edit a committed migration after the fact

### 5.3 Migration ordering

- Migrations apply to staging at merge-to-main
- Migrations apply to production at production approval
- Migrations are typically applied **before** the new Worker code is deployed, to ensure the database is ready for the new code
- Migrations that can't be safely run with old code still deployed require feature flags or a two-phase migration:
  1. Phase 1: Migration adds new column (nullable), code reads old + new
  2. Phase 2: Code writes only to new column; backfill old data
  3. Phase 3: Migration drops old column

### 5.4 RLS and GRANT policies

Layer 2 (PostgREST GRANTs) and Layer 3 (RLS row filters) — plus the
`public.is_admin()` / `public.is_active_user()` helpers — ship as a numbered
migration (`supabase/migrations/20260602051513_rls_grants_and_policies.sql`) as
of AECI-87. They define what PostgREST exposes to the `anon`/`authenticated`
roles; the Worker's privileged Postgres role bypasses both. See
`docs/AUTH_AND_RLS.md` §1 for the three-layer model.

**Apply order (per environment):** there is no separate apply step — the GRANT/RLS
surface is part of the migration set, so `supabase db push --linked` (or
`supabase db reset` locally) installs it alongside the schema, in timestamp
order. Helpers must live in `public`, not `auth`: the migration role (`postgres`)
cannot CREATE in the `auth` schema — see `docs/AUTH_AND_RLS.md` §6.1.

**Re-runnability.** The migration is idempotent: every `create policy` is
preceded by `drop policy if exists`, and the `REVOKE`/`GRANT`/`alter table ...
enable row level security`/`create or replace function` statements are inherently
idempotent. (Once recorded in `supabase_migrations`, `supabase db push` skips it;
a correction is a new forward migration — never edit a merged migration.)

**Verification.** Each of `drift-check.yml` (fresh local DB), `refresh-staging.yml`
(after the migrate step), and `promote-to-prod.yml` (after the prod migrate) runs
`psql "$URL" -v ON_ERROR_STOP=1 -f scripts/verify-rls.sql` as a hard-stop gate.
The probe impersonates the PostgREST roles at the SQL layer (`SET ROLE anon`) and
asserts:

- the `public.is_admin()` / `public.is_active_user()` helpers exist and are anon-executable;
- anon CAN `INSERT` into `feedback` / `mailing_list` (the landing carve-out survived the blanket REVOKE);
- anon `SELECT` on `audit_log`, `profiles`, `vendor_requests`, `workflow_instances`, `workflow_transitions`, `page_views`, `feedback`, `mailing_list` returns `42501 insufficient_privilege`.

Row-filter RLS that depends on a JWT (promoted-only, own-row) is covered by the
PostgREST integration specs (`apps/api/src/integration/*.rls.spec.ts`).

---

## 6. Rollback strategy

### 6.1 Worker rollback

Wrangler stores deployment history. To roll back:

```bash
wrangler deployments list --env production
wrangler rollback --env production --message "Reverting due to bug X"
```

Takes effect within seconds globally. Use case: a deploy introduced a critical bug, you want the previous version live immediately.

### 6.2 Database rollback

Not supported. Migrations are forward-only.

If a migration broke something, you write a new migration that fixes it (could be a revert if the original was additive). Workers may need to be rolled back to a version compatible with the database state.

### 6.3 Cache invalidation on rollback

After any rollback, purge the affected cache **tags** via `POST /admin/purge` with a tag list (see `CACHE_STRATEGY.md` §5 for the endpoint shape, tag vocabulary, and auth). Purge the tags for any pages the rolled-back code rendered; for a drastic rollback, use the coarse route-class tags (`route:detail` / `route:index` / `route:browse`) to repaint whole page classes at once.

Use `wrangler tail` to monitor cache miss rates climbing back to normal after the purge. (The `invalidateForEntity()` / URL-invalidation-map approach in `STAGE_1_SPEC.md` §9.3 is superseded — see `CACHE_STRATEGY.md`.)

---

## 7. Secrets management

### 7.1 GitHub Actions secrets

Stored in GitHub Settings → Secrets and Variables → Actions. Scoped per environment via GitHub Environments.

**Required secrets per environment:**

| Secret | Purpose | Environments |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Wrangler auth + cache purge. Scope: **`Zone.Cache Purge` on `aecintegrations.com` only** (narrowest possible). Do not promote to a broader scope under deadline pressure — issue a new token with the same minimal scope and rotate. | All |
| `CLOUDFLARE_ACCOUNT_ID` | Account identifier | All |
| `CLOUDFLARE_ZONE_ID` | Zone ID for `aecintegrations.com`; used by wrangler and the zone-scoped cache-purge token backing `POST /admin/purge` (see `CACHE_STRATEGY.md` §5) | staging, production |
| `SUPABASE_ACCESS_TOKEN` | Migrations via Supabase CLI | All |
| `SUPABASE_DB_URL` | Supabase pooler URL; doubles as `DIRECT_URL` for `supabase db push --linked` | All |
| `DATABASE_URL` | Prisma Accelerate runtime URL (`prisma://...`); one per environment. Pushed to Worker via `wrangler secret put DATABASE_URL` | All |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase admin | All |
| `SUPABASE_ANON_KEY` | Public Supabase key | All |
| `ALGOLIA_ADMIN_KEY_STAGING` / `_PRODUCTION` | Per-env **management** key — search + index-mutation ACLs, scoped to that env's three indexes (NOT the app-wide root admin key). Sync pipeline (3.5/3.6) + CI. Pushed to the API Worker as `ALGOLIA_ADMIN_KEY`. Rotated independently per env (§7.4). | staging, production |
| `ALGOLIA_SEARCH_KEY_STAGING` / `_PRODUCTION` | Per-env **search-only** key (`['search']`), scoped to that env's three indexes. Pushed to the web Worker as `ALGOLIA_SEARCH_KEY`; client-exposed (InstantSearch, 3.9). | staging, production |
| `ALGOLIA_APP_ID` | Algolia application id. **Single value shared across all envs** (one app; only indexes/keys differ). Pushed to both Workers. | All |
| `DATADOG_API_KEY` | RUM and APM | All |
| `DATADOG_APP_KEY` | Deployment markers | staging, production |
| `LOOPS_API_KEY` | Transactional email | staging, production |
| `LINEAR_API_TOKEN` | Issue creation | All |
| `LINEAR_WEBHOOK_SECRET` | Webhook signature verification | All |
| `PERSPECTIVE_API_KEY` | Profanity flagging | All |
| `BRANDFETCH_CLIENT_ID` | Logo CDN | All |

### 7.2 Worker secrets

For runtime use, secrets are pushed to Worker secrets via Wrangler:

```bash
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env production
```

GitHub Actions does this via the `cloudflare/wrangler-action` step, pulling from GitHub Actions secrets.

### 7.3 Local development

Local secrets live in `.dev.vars` at the root of each Worker package. **Never committed.** A `.dev.vars.example` template is committed showing required keys with placeholder values.

`pnpm dev` or `wrangler dev` reads `.dev.vars` automatically.

**For any Worker that talks to Prisma**, `.dev.vars` must contain at minimum:

- `DATABASE_URL` — Prisma Accelerate URL (`prisma://...`). Used at runtime.
- `DIRECT_URL` — Supabase pooler URL (`postgresql://...`). Used by the Prisma CLI (`migrate dev`, `generate`).

See the canonical comment block at `apps/api/wrangler.jsonc:12-13` for the deploy-side counterpart.

### 7.4 Rotation

Documented procedure, executed annually or on suspected compromise:

1. Generate new credential at the source (Supabase, Algolia, etc.)
2. Update GitHub Actions secret
3. Trigger a deploy to push the new secret to Worker secrets
4. Verify the new secret is active
5. Revoke the old credential at the source

For the API keys with dev/prod separation (Algolia, Datadog), rotate independently per environment.

**Algolia (per-env, independent).** The app-wide root admin key stays operator-held and is used _only_ to run the provision script — it is never a GitHub or Worker secret, so it does not rotate through this pipeline. The per-env scoped keys rotate one env at a time:

1. `node scripts/algolia/provision.mjs --env <env> --rotate` — mints fresh search + management keys for that env and deletes the old ones (the index scope is unchanged).
2. Re-set the affected secrets with the printed values: `gh secret set ALGOLIA_SEARCH_KEY_<ENV>` / `ALGOLIA_ADMIN_KEY_<ENV>`, and `wrangler secret put ALGOLIA_SEARCH_KEY --env <env>` (web) / `ALGOLIA_ADMIN_KEY --env <env>` (API).
3. Redeploy that env so the Workers pick up the new secrets.

`ALGOLIA_APP_ID` is not a credential and does not rotate. Rotating the root admin key itself is a dashboard operation (Algolia → API Keys) followed by re-exporting it locally before the next provision run.

### 7.5 Algolia topology (AECI-134)

**One application, per-env indexes.** A single AECi Algolia app (one `ALGOLIA_APP_ID`, shared) holds three index sets, one per environment. Physical names are `<prefix>_<entity>`:

| Prefix | Indexes | Used by |
|---|---|---|
| `preview` | `preview_products`, `preview_vendors`, `preview_integrations` | PR previews + local `pnpm dev:bound` (`ENV=preview`) + `development` (bare `wrangler dev`/tests fold here) |
| `staging` | `staging_products`, `staging_vendors`, `staging_integrations` | staging |
| `production` | `production_products`, `production_vendors`, `production_integrations` | production |

The prefix is derived from the Worker `ENV` label (matching the Datadog tags + `/api/version` convention); `development` folds onto `preview` so there is no fourth set. The names and the key shapes are defined once in `packages/shared/src/algolia.ts` and consumed by the Workers and the provision script alike.

**Three keys per app, two of them per-env-scoped:**

- **Root admin key** — app-wide, all ACLs. **Operator-held**; used _only_ to run `scripts/algolia/provision.mjs`. Never a GitHub or Worker secret.
- **Search-only key** (per env) — ACL `['search']`, scoped to that env's three indexes. → web Worker `ALGOLIA_SEARCH_KEY`. Client-exposed (rendered into the SSR HTML as `window.__AECI_ALGOLIA__` for InstantSearch, 3.9).
- **Management key** (per env) — ACL `search + addObject + deleteObject + editSettings + listIndexes`, scoped to that env's three indexes; excludes the destructive/global ACLs (`deleteIndex`, `usage`, `logs`, …). → API Worker `ALGOLIA_ADMIN_KEY`. Server-only; used by sync from 3.5.

Both per-env keys are standalone (`addApiKey`, not derived/secured keys), so each rotates independently per env (§7.4). The search and management keys are minted by the provision script; the operator pushes them to the Workers via `wrangler secret put`. **The management/admin key must never reach the browser** — it is deliberately absent from the web Worker's `WebEnv`, and a unit test (`apps/web/src/algolia-bootstrap-inject.spec.ts`) enforces that the bootstrap injection never serializes it.

Scope is provisioning + keys only. Index _settings_ (searchable attributes, facets, ranking) land in 3.2; sync in 3.5/3.6; the `/search` UI in 3.9.

---

## 8. Quality gates

Every PR must pass these gates before merge:

- ✓ Lint and type check
- ✓ Unit tests pass
- ✓ Build succeeds
- ✓ Bundle size under budget
- ✓ Preview deploys successfully
- ✓ E2E tests pass against preview
- ✓ No new accessibility violations (axe-core) — blocking
- ✓ Lighthouse scores meet budget (Performance / Accessibility / Best-Practices / SEO ≥ 90 mobile) — **advisory / warn-only today** (see the AECI-65 note below)
- ✓ At least one human reviewer approval

Two checks run **advisory / non-blocking** rather than as merge gates: coverage is generated and reported but never fails a build (target: 70% line coverage — see §3.1 and `TESTING_STRATEGY.md` §3.3), and the `integration-db-tests` suites report red/green without gating the staging deploy until they're promoted to a required check (`TESTING_STRATEGY.md` §6.5).

**axe + Lighthouse wiring (AECI-65 / Phase 2.19).** Both harnesses (scaffolded in AECI-33) now run against **every Phase 2 page type** on a local `dev:bound` server in `deploy.yml`, using committed seed fixtures (`supabase/fixtures/phase2-fixtures.sql`, seeded by `db-migrate-dev`):

- **axe** runs in the `e2e-and-integration` job (`apps/web/e2e/phase2-a11y.spec.ts`) across all 13 page types in **light and dark** themes — **zero AA violations, blocking** (the site footer's pre-existing dark-mode contrast debt is carved out and tracked separately).
- **Lighthouse** runs in the un-parked `lighthouse` job (mobile, simulated throttle, median-of-3). Budgets (§12 of `STAGE_1_PHASE_2_SPEC.md`: scores ≥ 90, LCP ≤ 2.5s, CLS ≤ 0.1, detail-page JS ≤ 200 KB) are asserted **warn-only** for now — `.lighthouserc.cjs` exits 0 even on a miss, so the job surfaces the report without blocking. This supersedes the older "warn-only until Phase 7" wording: the **warn→merge-blocking flip is a dedicated follow-up**, gated on confirming every page passes (perf optimization itself is out of AECI-65's scope). To flip, change the `'warn'` levels in `.lighthouserc.cjs` to `'error'`.

The "human reviewer" requirement is enforced by GitHub branch protection on `main`.

---

## 9. Monitoring deployments

### 9.1 Datadog deployment markers

Every deployment to staging or production sends a marker to Datadog. Markers appear on dashboards as vertical lines, making it easy to correlate any new errors or performance regressions with a specific deploy.

```yaml
- name: Mark deployment in Datadog
  run: |
    curl -X POST "https://api.datadoghq.com/api/v1/events" \
      -H "DD-API-KEY: ${{ secrets.DATADOG_API_KEY }}" \
      -H "Content-Type: application/json" \
      -d '{
        "title": "Production deployment",
        "text": "Deployed commit ${{ github.sha }}",
        "tags": ["env:production", "service:aeci-ssr", "commit:${{ github.sha }}"]
      }'
```

### 9.2 Smoke tests

After every staging and production deploy, the workflow polls the deployed site until **both** Workers report the SHA being shipped, via `scripts/verify-version.sh`:

- `GET /api/version` — proxied raw to the API Worker; reports the **API** Worker's `COMMIT_SHA`.
- `GET /_version` — served by the SSR Worker itself; reports the **SSR** Worker's `COMMIT_SHA`.

Checking both (AECI-92) proves the whole site — not just the API behind the proxy — is at the deployed commit. The workflow owns the timing budget: it retries up to 10 times at 6s intervals (~60s) and marks the deploy failed if either Worker has not reported the expected SHA by then.

If the smoke check fails, the deployment is marked failed and:

- **Staging:** the red CI run is the signal. No Slack notification and no auto-rollback — a developer investigates and re-runs.
- **Production:** the `deploy-prod-workers` job auto-rolls-back **both** Workers to the previous deployment (`wrangler rollback --env production` for `apps/web` then `apps/api`, the reverse of deploy order, so API stays ahead of SSR on the way down), emits an alert-grade **Datadog event** (`alert_type: error`, `event:auto_rollback`), and writes an operator runbook to the run summary. The runbook carries the manual `wrangler rollback` commands, both R2 pre-promote snapshot keys (public + `supabase_migrations`, and auth), and the exact `pg_restore` block. The **database is not auto-restored** — migrations are forward-only (§6.2), and the snapshot predates any post-migration writes, so restoring is an operator decision made with the surfaced commands in hand.

> Slack alerting was intentionally dropped from Phase 1; Datadog events are the prod alert channel. A Playwright smoke suite (home / product / vendor / search / auth-login page renders) is **deferred to a later phase** — until then the dual-Worker version verification above is the smoke gate.

---

## 10. Branch strategy

Single long-lived branch: `main`.

- Feature branches off `main`, merged via squash merge
- No `develop` branch — `main` is always deployable to staging
- Release tags (`v1.0.0`, `v1.1.0`) cut from `main` after a production deploy is validated

This keeps the model simple. If parallel feature work creates conflicts, work it out in PRs, not via long-lived branches.

---

## 11. Build performance

### 11.1 Caching

Aggressive caching to minimize CI time:
- `pnpm` lockfile cache (per `pnpm-lock.yaml` hash)
- Angular build cache (per source hash)
- Playwright browser cache (rare invalidation)
- Vitest cache where Vitest supports it

### 11.2 Parallel jobs

Independent jobs run in parallel. The dependency graph is:

```
lint-and-types ─┐
unit-tests ──────├── (gate)
build ──────────┘
   │
   └── deploy-preview
            │
            ├── e2e-tests
            ├── accessibility
            └── lighthouse
```

### 11.3 Selective testing

For very small PRs (e.g. doc-only changes), skip downstream jobs via `paths-ignore` in workflow triggers.

---

## 12. Observability for CI itself

- GitHub Actions usage tracked monthly to stay under free-tier minutes
- Failed builds notify Slack
- Long-running jobs (>15 min) flagged for investigation
- Cache hit rates monitored — low hit rate signals cache misconfiguration

---

## 13. Future considerations

### 13.1 When team grows

- Add CODEOWNERS file to require specific reviewers for specific paths
- Add merge queue to serialize merges and re-run CI against the rebased state
- Add manual QA approval gate before production for risky changes

### 13.2 When traffic scales

- Add canary deployment pattern: deploy to 5% of traffic first, monitor, promote if healthy
- Add blue/green pattern with Cloudflare load balancers
- Add automated performance regression detection (Datadog SLO breaches)

### 13.3 Stage 4 paid tier work

- Stripe integration adds new secrets and a payment webhook endpoint
- Test mode vs live mode pricing requires environment-specific Stripe keys
- Payment failure handling adds new alert categories

Not pursued in Stage 1.

---

## 14. Setup checklist

Before the first deploy:

- [ ] GitHub repo created with branch protection on `main`
- [ ] GitHub Environments created: `preview`, `staging`, `production`
- [ ] Production environment requires manual approval from Chris or Bill
- [ ] All secrets configured per Section 7.1
- [ ] Cloudflare account has Workers, Pages (for static assets), and zone access
- [ ] Supabase projects created for dev/staging/production
- [ ] Algolia app created; per-env indexes + scoped keys provisioned via `scripts/algolia/provision.mjs` (`preview_*` / `staging_*` / `production_*`, per §7.5)
- [ ] Datadog account configured with appropriate API keys
- [ ] Loops account configured with environment-specific senders
- [ ] Linear workspace configured per `STAGE_1_SPEC.md` §24
- [ ] DNS configured for `demo.aecintegrations.com` (web prod), `staging.aecintegrations.com`, and the landing apex + `www.aecintegrations.com`
- [ ] `.dev.vars.example` committed showing all required local secrets
- [ ] First end-to-end deploy validated against a test PR
