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

Three environments, all on Cloudflare:

| Environment | URL pattern | Triggered by | Auto/Manual | Data |
|---|---|---|---|---|
| **Preview** | `pr-{N}-aeci.{workers-dev-subdomain}.workers.dev` | Every PR push | Auto | Supabase preview branch or shared dev DB |
| **Staging** | `staging.aecintegrations.com` | Merge to `main` | Auto | Staging Supabase project |
| **Production** | `aecintegrations.com` | Manual approval after staging | Manual | Production Supabase |

### 2.1 Preview environment

Spun up per PR. Provides a working deployment for human review and automated tests (E2E, accessibility, performance).

- Each PR gets a unique URL using the PR number
- Auto-deletes when PR is closed or merged
- Connects to a Supabase preview branch (Supabase Branching feature) if available, else shared dev DB
- Algolia connects to a dev-only index (`products_dev`, `vendors_dev`, `integrations_dev`)
- Datadog reports under `env:preview` tag
- Loops is mocked (no real emails sent from preview)
- Linear is mocked (no real issues created)

### 2.2 Staging environment

Mirror of production, but with test data and isolated from real users.

- Always reflects the latest `main` branch
- Connects to a dedicated staging Supabase project
- Algolia connects to dedicated staging indexes
- Datadog under `env:staging` tag
- Loops sends real emails but only to allowlisted internal addresses
- Linear creates real issues in a "Staging Test" project
- Used for smoke tests, manual QA, and demos

### 2.3 Production environment

The real site. Promoted from staging via manual approval.

- Deployed only after staging deployment is verified
- Manual approval gate in GitHub Environments (Chris or Bill clicks "Approve" button)
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
3. Upload coverage to Codecov (or similar)
4. Fail if coverage drops below threshold

**Job: `build`** (~3 min)
1. Checkout, install
2. `pnpm run build` (Angular SSR build for Cloudflare Workers)
3. Bundle size check against budget (defined in `TESTING_STRATEGY.md`)
4. Upload build artifact for downstream jobs

**Job: `deploy-preview`** (depends on `build`, ~2 min)
1. Download build artifact
2. `wrangler deploy --env preview` with PR-scoped name
3. Run Supabase migrations against preview DB (if any new ones in the PR)
4. Comment on PR with preview URL

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

Triggered when Chris or Bill clicks "Approve" in GitHub Environments → Production.

**Job: `deploy-production`**
1. Verify the staging deployment is the one being promoted (commit hash match)
2. Run pending Supabase migrations against production
3. `wrangler deploy --env production`
4. Run smoke test suite against production
5. Update Algolia production indexes if schema changed
6. Send deployment marker to Datadog with version tag
7. Notify Slack: "Production deployed, commit {sha}"
8. Auto-create GitHub Release if commit is tagged

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
- `wrangler.jsonc` per Worker package (e.g., `apps/web/wrangler.jsonc`, `apps/api/wrangler.jsonc`), with environment overrides under `env.preview`, `env.staging`, `env.production`. JSONC is preferred over TOML because it allows comments and matches the validated pattern in `apps/stack-test/wrangler.jsonc` and `apps/prisma-test/wrangler.jsonc`.
- Compatibility date locked per environment to prevent surprise Worker runtime changes
- SSR Worker requires `"compatibility_flags": ["nodejs_compat"]` — needed for `@angular/ssr` runtime Node polyfills. This is unrelated to database access; Prisma still uses Accelerate (HTTPS), see `DATABASE_SCHEMA.md` §1a.
- API Worker does not need `nodejs_compat` (it talks to Supabase via Accelerate HTTPS).
- Custom domain routing uses `routes` with `"custom_domain": true` per the `apps/stack-test/wrangler.jsonc:44-49` pattern, not zone-level `route` strings.

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
      "routes": [{ "pattern": "aecintegrations.com", "custom_domain": true }]
    }
  }
}
```

The multi-locale Angular build emits a single `server.mjs` that dispatches by URL prefix (`/`, `/es`, etc.) — no per-locale deploys, no per-locale Workers. The deploy command is just `wrangler deploy --env <env>`. See `STAGE_1_SPEC.md` §7a.3a.

### 4.2 Service bindings

The SSR Worker calls the API Worker via service binding, configured per environment:

```toml
[[env.production.services]]
binding = "API_WORKER"
service = "aeci-api-production"
```

The API Worker is private — has no route, only callable via the service binding. This pattern is identical across environments.

### 4.3 Atomic deploys

Both Workers (SSR and API) deploy together as a single pipeline step. If either fails to deploy, the other is rolled back. This prevents an inconsistent state where the SSR Worker is calling a stale API Worker (or vice versa).

Implementation: deploy API Worker first, run health check, deploy SSR Worker, run smoke tests. If smoke tests fail, rollback both.

---

## 5. Database migrations

Supabase migrations run as part of the deploy pipeline.

### 5.1 Migration source

Migrations live in `apps/api/prisma/migrations/` and are committed alongside code changes that depend on them. Generated via `pnpm prisma migrate dev` locally; applied via `pnpm prisma migrate deploy` in CI.

Both commands read `DIRECT_URL` (the Supabase pooler `postgresql://` URL), not `DATABASE_URL` (the runtime Prisma Accelerate `prisma://` URL). Workers never see `DIRECT_URL`. See `DATABASE_SCHEMA.md` §1a for the two-URL split.

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

Layer 2 (PostgREST GRANTs) and Layer 3 (RLS row filters) live in `docs/rls_policies.sql`, outside `apps/api/prisma/migrations/`. They define what PostgREST exposes to the `anon`/`authenticated` roles; the Worker's privileged Postgres role bypasses both. See `docs/AUTH_AND_RLS.md` §1 for the three-layer model.

**Apply order (per environment):**

1. `pnpm --filter @aeci/api prisma:migrate:deploy` — apply all pending schema migrations first, so every in-scope table exists.
2. `psql "$DIRECT_URL" -f docs/rls_policies.sql` — (re)apply the RLS + GRANT policies on top.

Locally, `pnpm --filter @aeci/api db:apply-rls` runs step 2 with `DIRECT_URL` already loaded from `.dev.vars` via `dotenv-cli`. `psql` must be on `$PATH`.

**Re-runnability.** The script is safe to re-run: every `create policy` is preceded by `drop policy if exists`, and the `REVOKE`/`GRANT`/`alter table ... enable row level security`/`create or replace function` statements are inherently idempotent. Re-run after every migration that adds a new public-schema table — `ALTER DEFAULT PRIVILEGES` already locks new tables to anon/auth, but the explicit `enable row level security` and policy definitions in this script only cover the tables it names.

**Verification queries** (run after each apply):

- `SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public';` — every in-scope table shows `rowsecurity = true`.
- The two `role_table_grants` queries documented at the foot of `docs/rls_policies.sql` (see "VERIFICATION QUERIES" comment block) — confirm the expected anon / authenticated grant matrix.
- PostgREST probes: anon `SELECT` on `audit_log`, `profiles`, `vendor_requests`, `workflow_instances`, `workflow_transitions`, `page_views` must return `42501 insufficient_privilege`. Anon `SELECT` on `taxonomy_categories`, `stats_cache` must return rows.

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

After any rollback, purge the cache for affected URLs. Use the `invalidateForEntity()` helper from `STAGE_1_SPEC.md` §9.3, but at a global level — purge `/`, all listing pages, and any pages that the rolled-back code rendered.

In practice, after a rollback, purge by URL pattern (`*` if drastic) using `wrangler tail` to monitor cache miss rates climbing back to normal.

---

## 7. Secrets management

### 7.1 GitHub Actions secrets

Stored in GitHub Settings → Secrets and Variables → Actions. Scoped per environment via GitHub Environments.

**Required secrets per environment:**

| Secret | Purpose | Environments |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Wrangler auth + cache purge. Scope: **`Zone.Cache Purge` on `aecintegrations.com` only** (narrowest possible). Do not promote to a broader scope under deadline pressure — issue a new token with the same minimal scope and rotate. | All |
| `CLOUDFLARE_ACCOUNT_ID` | Account identifier | All |
| `CLOUDFLARE_ZONE_ID` | Zone ID for `aecintegrations.com`; passed to `invalidateForEntity()` purge calls | staging, production |
| `SUPABASE_ACCESS_TOKEN` | Migrations via Supabase CLI | All |
| `SUPABASE_DB_URL` | Supabase pooler URL; doubles as `DIRECT_URL` for `prisma migrate deploy` | All |
| `DATABASE_URL` | Prisma Accelerate runtime URL (`prisma://...`); one per environment. Pushed to Worker via `wrangler secret put DATABASE_URL` | All |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase admin | All |
| `SUPABASE_ANON_KEY` | Public Supabase key | All |
| `ALGOLIA_ADMIN_KEY` | Index management | All |
| `ALGOLIA_APP_ID` | Algolia app | All |
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

See the canonical comment block at `apps/prisma-test/wrangler.jsonc:7-11` for the deploy-side counterpart.

### 7.4 Rotation

Documented procedure, executed annually or on suspected compromise:

1. Generate new credential at the source (Supabase, Algolia, etc.)
2. Update GitHub Actions secret
3. Trigger a deploy to push the new secret to Worker secrets
4. Verify the new secret is active
5. Revoke the old credential at the source

For the API keys with dev/prod separation (Algolia, Datadog), rotate independently per environment.

---

## 8. Quality gates

Every PR must pass these gates before merge:

- ✓ Lint and type check
- ✓ Unit test coverage above threshold (target: 70% line coverage)
- ✓ Build succeeds
- ✓ Bundle size under budget
- ✓ Preview deploys successfully
- ✓ E2E tests pass against preview
- ✓ No new accessibility violations (axe-core)
- ✓ Lighthouse scores meet budget (Performance > 80, Accessibility > 95)
- ✓ At least one human reviewer approval

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

After every staging and production deploy, a Playwright smoke test suite runs against the deployed URL:

- Home page renders with stats
- Product page renders
- Vendor page renders
- Search returns results
- Auth login page loads

If any smoke test fails, the deployment is marked failed and:
- Staging: Slack notification, no auto-rollback (devs investigate)
- Production: auto-rollback to previous deployment, Slack alert

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
- [ ] Algolia app created with dev/staging/production indexes
- [ ] Datadog account configured with appropriate API keys
- [ ] Loops account configured with environment-specific senders
- [ ] Linear workspace configured per `STAGE_1_SPEC.md` §24
- [ ] DNS configured for `aecintegrations.com` and `staging.aecintegrations.com`
- [ ] `.dev.vars.example` committed showing all required local secrets
- [ ] First end-to-end deploy validated against a test PR
