# Environments

> **Status (AECI-76, stub).** This file documents the topology and the manual setup checklist needed to bring the staging deploy online. The full operator runbook (how to trigger each button, what to do when something fails, how to recover an orphaned PR branch DB, etc.) lands in [AECI-80](https://linear.app/aec-integrations/issue/AECI-80) at the close of the AECI-71 epic. Until then, refer back to the AECI-71 issue body for any detail not yet captured here.

## Topology

AECi runs three tiers of environment plus local. Worker and Supabase project naming is rigid — workflows, smoke tests, and docs assume these exact names.

| Tier | Cloudflare Workers | Supabase | Public URL | Access control |
| --- | --- | --- | --- | --- |
| **Local** | `wrangler dev` / `pnpm dev:bound` | Local Postgres (`supabase start`, port 54322) | `http://localhost:8788` | None (loopback) |
| **PR preview** | `aeci-{api,web}-pr-<N>` (`*.aec-integrations.workers.dev`) | Dev project, ephemeral branch DB per PR (AECI-79) | `*.workers.dev` (PR-specific) | Cloudflare Access — service token for CI, OTP-to-email for humans |
| **Staging** | `aeci-{api,web}-staging` | Dev project, `main` branch | `https://staging.aecintegrations.com` | Cloudflare Access — same allowlist as previews |
| **Production** | `aeci-{api,web}-production` | Prod project | `https://aecintegrations.com` + `https://www.aecintegrations.com` | Public |

Worker `name` (deployed) values in `apps/{web,api}/wrangler.jsonc`:

| Worker | Preview env | Staging env | Production env |
| --- | --- | --- | --- |
| `apps/api` | `aeci-api-preview` | `aeci-api-staging` | `aeci-api-production` |
| `apps/web` | `aeci-web` (`workers_dev: true`) | `aeci-web-staging` | `aeci-web-production` |

The SSR Worker (`apps/web`) is the only public ingress. The API Worker (`apps/api`) is reachable only via the SSR Worker's `services.API` binding. This is enforced per environment by matching `services.binding.service` to the API Worker's deployed `name` in the same tier.

## Promotion model

```
local → PR preview → staging (auto on merge to main) → production (manual)
```

- **PR previews**: created by `.github/workflows/pr-preview.yml` (AECI-79) on `pull_request` open/sync; torn down on close.
- **Staging**: deployed by `.github/workflows/deploy.yml` `deploy-staging` job on every push to `main`, gated by `vars.STAGING_ENABLED`.
- **Staging refresh** (prod data → staging): `.github/workflows/refresh-staging.yml` (AECI-77), `workflow_dispatch` only.
- **Production**: deployed by `.github/workflows/promote-to-prod.yml` (AECI-78), `workflow_dispatch` with required `commit_sha` + `confirm=PROMOTE` inputs and a GH Environment approval gate.

There is intentionally **no auto-deploy to production**.

## Secrets

Secrets are stored in three places:
- **GitHub Actions secrets** (repo-level, used by `.github/workflows/*.yml`).
- **Cloudflare Worker secrets** (per Worker `name`, set via `wrangler secret put <KEY> --env <env>`; not visible in source).
- **Local `.dev.vars`** (per app, gitignored; mirrors a subset of Worker secrets for local dev).

| Secret | Staging Worker | Prod Worker | GH Actions | Notes |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` (staging Prisma Accelerate `prisma://…`) | ✅ on `aeci-{api}-staging` | ❌ | ✅ as `DATABASE_URL_STAGING` (CI tooling that needs raw access uses `DIRECT_URL_STAGING` instead) | Worker runtime path only. Never the pooler URL. |
| `DATABASE_URL` (prod Prisma Accelerate `prisma://…`) | ❌ | ✅ on `aeci-{api}-production` | ✅ as `DATABASE_URL_PRODUCTION` | Worker runtime path only. |
| `DIRECT_URL_STAGING` (Supabase pooler `postgresql://…`) | ❌ | ❌ | ✅ | Used by `supabase db push`, `pg_dump`, `pg_restore`. Workers never see this. |
| `DIRECT_URL_PRODUCTION` | ❌ | ❌ | ✅ | Same. |
| Supabase service role key (staging) | ✅ on staging Workers | ❌ | ✅ as `SUPABASE_SERVICE_ROLE_KEY_STAGING` | |
| Supabase service role key (prod) | ❌ | ✅ on prod Workers | ✅ as `SUPABASE_SERVICE_ROLE_KEY_PRODUCTION` | |
| `SUPABASE_ACCESS_TOKEN` | ❌ | ❌ | ✅ | For `supabase` CLI in CI. |
| `SUPABASE_MANAGEMENT_API_TOKEN` | ❌ | ❌ | ✅ | For PR-preview branch lifecycle (AECI-79). |
| `CLOUDFLARE_API_TOKEN` | ❌ | ❌ | ✅ | Scoped narrowly per CICD_PLAN §7.1. |
| `CLOUDFLARE_ACCOUNT_ID` | ❌ | ❌ | ✅ | `e62ec9d8012c3e0c225f8e4dbab76b79` |
| `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` | ❌ | ❌ | ✅ | Service token for non-prod smoke tests (`docs/access.md` §1). |
| `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` + `R2_ENDPOINT` | ❌ | ❌ | ✅ | Prod snapshot uploads (AECI-78). Bucket: `aeci-prod-snapshots`. |
| `LOOPS_API_KEY` (test) | ✅ on staging Workers | ❌ | — | Sends to allowlisted addresses only in staging. |
| `LOOPS_API_KEY` (prod) | ❌ | ✅ on prod Workers | — | Sends to real users. |
| Datadog `DD_*` (per `apps/web/wrangler.jsonc` header) | ✅ per env | ✅ per env | — | RUM + Logs intake. |
| `ADMIN_PURGE_TOKEN`, `CF_PURGE_API_TOKEN`, `CF_ZONE_ID` | ✅ per env | ✅ per env | — | Cache-tag purge (AECI-56). |

All Worker secrets are pushed per environment: `wrangler secret put DATABASE_URL --env staging` (and the same for `--env production` once the prod project exists).

## GitHub Environments

| Environment | Required reviewers | Used by | Purpose |
| --- | --- | --- | --- |
| `staging` | None | `deploy.yml` (`deploy-staging` job) | Display the staging URL in the run summary; no gate. |
| `staging-refresh` | None | `refresh-staging.yml` (AECI-77) | Idempotent button — Chris triggers, action runs. |
| `production` | Chris | `promote-to-prod.yml` (AECI-78) | The "see SQL before it runs" approval gate. |

## Repository variables (GitHub UI: Settings → Secrets and variables → Actions → Variables)

| Variable | Value | Purpose |
| --- | --- | --- |
| `STAGING_ENABLED` | `"true"` once Chris finishes the manual checklist below | Gates the `deploy-staging` job. Skipped (not failed) while empty/false, so merges to main stay green during bootstrap. |

## Manual prerequisites — Chris's checklist before `STAGING_ENABLED=true`

The following must be done by hand (Supabase and Cloudflare dashboards + `gh secret set` + `wrangler secret put`) before the `deploy-staging` job in `.github/workflows/deploy.yml` will succeed.

### 1. Supabase projects

- [ ] **Rename** the current Supabase project to `aeci-development` (Supabase Dashboard → Project Settings → General → Project name). The project ref stays the same.
- [ ] **Provision a new project** named `aeci-production` in the same Supabase org. Region: match the existing dev project (lowest latency to Workers).
- [ ] **Bootstrap the prod project schema**:
  ```bash
  supabase link --project-ref <prod-ref>
  pnpm db:push   # applies every supabase/migrations/*.sql to prod
  ```
  Then `supabase link --project-ref <dev-ref>` to leave the CLI pointed at dev (default for day-to-day work).
- [ ] Verify both projects show all six baseline migrations in `supabase migration list`.

### 2. Cloudflare DNS

- [ ] Confirm `aecintegrations.com` is on Cloudflare with the AEC account and a Pro plan.
- [ ] Add a custom hostname for `staging.aecintegrations.com` pointing at the Workers zone (Cloudflare Dashboard → Workers & Pages → `aeci-web-staging` → Settings → Triggers → Custom Domains → Add). Wrangler will reconcile the route on first deploy.
- [ ] Add `www.aecintegrations.com` as a second custom domain on `aeci-web-production` if not already present.

### 3. Cloudflare Access

Already provisioned per `docs/access.md` §1. Re-verify after bootstrapping the staging hostname:

- [ ] `curl -I https://staging.aecintegrations.com` returns `HTTP/2 302` redirecting to Cloudflare Access (no service-token headers).
- [ ] `curl -I -H "CF-Access-Client-Id: …" -H "CF-Access-Client-Secret: …" https://staging.aecintegrations.com/api/version` returns `HTTP/2 200`.

### 4. GitHub Environments

- [ ] Create environment `staging` (no reviewers).
- [ ] Create environment `staging-refresh` (no reviewers) — used by AECI-77.
- [ ] Create environment `production` with **chrisw@thewbsproject.com as required reviewer** — used by AECI-78.

### 5. GitHub Actions secrets (`gh secret set <NAME>`)

From the Secrets table above, set at minimum:

- [ ] `CLOUDFLARE_API_TOKEN`
- [ ] `CLOUDFLARE_ACCOUNT_ID`
- [ ] `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` (already done per AECI-75)
- [ ] `DATABASE_URL_STAGING` (Prisma Accelerate `prisma://…` for the dev project's main branch)
- [ ] `DIRECT_URL_STAGING` (Supabase pooler `postgresql://…` for the dev project)
- [ ] `SUPABASE_ACCESS_TOKEN` (used by `supabase` CLI in CI)
- [ ] `SUPABASE_SERVICE_ROLE_KEY_STAGING`

Prod-only secrets (`DATABASE_URL_PRODUCTION`, `DIRECT_URL_PRODUCTION`, `SUPABASE_SERVICE_ROLE_KEY_PRODUCTION`, R2 keys) can wait until AECI-78.

### 6. Cloudflare Worker secrets (`wrangler secret put <KEY> --env staging`)

Run from `apps/api` and `apps/web` respectively:

```bash
cd apps/api
wrangler secret put DATABASE_URL --env staging              # Prisma Accelerate prisma://…
wrangler secret put DIRECT_URL --env staging                # Supabase pooler postgresql://… (only used by `prisma db pull` locally; harmless on Worker)
wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging
wrangler secret put DD_API_KEY --env staging
wrangler secret put ADMIN_PURGE_TOKEN --env staging
wrangler secret put CF_PURGE_API_TOKEN --env staging
# …plus any others the Worker reads at runtime
```

```bash
cd apps/web
wrangler secret put DD_API_KEY --env staging
wrangler secret put DD_APPLICATION_ID --env staging
wrangler secret put DD_CLIENT_TOKEN --env staging
wrangler secret put ADMIN_PURGE_TOKEN --env staging
# …
```

### 7. Flip the gate

- [ ] `gh variable set STAGING_ENABLED --body "true"` (or set in the UI).

The next push to `main` will trigger `deploy-staging`. The smoke test will assert `staging.aecintegrations.com/api/version` returns `{ sha: <merge commit>, environment: "staging" }`.

## What lives where

| File | Purpose |
| --- | --- |
| `apps/web/wrangler.jsonc` | SSR Worker — has `[env.preview]`, `[env.staging]`, `[env.production]`. |
| `apps/api/wrangler.jsonc` | API Worker — has `[env.preview]`, `[env.staging]`, `[env.production]`. `COMMIT_SHA` and `DEPLOYED_AT` declared with placeholder defaults per env; overridden at deploy via `--var`. |
| `.github/workflows/deploy.yml` | CI: lint, typecheck, unit, build, e2e local, integration local, then **`deploy-staging`** on push to `main` (gated by `vars.STAGING_ENABLED`). |
| `.github/workflows/refresh-staging.yml` | (AECI-77) one-button workflow to restore prod data into staging with credentials scrubbed. |
| `.github/workflows/promote-to-prod.yml` | (AECI-78) two-button workflow to promote a staging commit to production with manual approval. |
| `.github/workflows/pr-preview.yml` | (AECI-79) per-PR ephemeral preview lifecycle. |
| `.github/workflows/drift-check.yml` | (AECI-80) PR-time drift detection between `supabase/migrations/` and `apps/api/prisma/schema.prisma`. |
| `scripts/scrub-auth-credentials.sql` | (AECI-77) nulls credentials on `auth.users`, deletes `auth.sessions`/`auth.refresh_tokens`. |
| `scripts/seed-staging-users.sql` | (AECI-77) idempotent test-account seed for staging. |
| `scripts/prisma-drift-check.sh` | (AECI-77) `prisma db pull` + `prisma migrate diff --exit-code` — reused by promote-to-prod and drift-check. |
| `scripts/smoke-test.sh` | (AECI-77) pluggable-HOST `/api/health` smoke test with Access headers. |
| `scripts/seed-from-staging.sh` | (AECI-80) local dev helper to pull staging into local Postgres. |

Cross-references:
- [`docs/CICD_PLAN.md`](./CICD_PLAN.md) — the canonical CI/CD plan (this file is its operational companion).
- [`docs/access.md`](./access.md) — Cloudflare Access setup and service-token rotation.
- [`docs/migrations.md`](./migrations.md) — Supabase CLI migration workflow.
- [`docs/prisma.md`](./prisma.md) — Prisma as query-builder only contract.
- [`CLAUDE.md`](../CLAUDE.md) — non-negotiable constraints (Prisma Accelerate, `nodejs_compat` scope, `--var COMMIT_SHA` mandate, etc.).
