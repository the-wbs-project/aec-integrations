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

## PR previews

Every PR against `main` gets a pair of ephemeral preview Workers — `aeci-api-pr-<N>` (private; bound to via service binding) and `aeci-web-pr-<N>` (public on the `*.aec-integrations.workers.dev` wildcard) — deployed by [`pr-preview.yml`](../.github/workflows/pr-preview.yml) on `pull_request` `opened` / `synchronize` / `reopened` and torn down on `closed`. First-party PRs only — fork PRs skip cleanly since they receive no secrets.

### DB strategy: Option 1 (shared dev DB)

Per-PR API Workers connect via Prisma Accelerate to the dev project's `main` branch — the same DB that staging serves — by reusing the `DATABASE_URL_STAGING` GH Actions secret (pushed to the per-PR Worker via `wrangler secret put DATABASE_URL --name aeci-api-pr-<N>` on every deploy). The DB is shared; the Worker is not.

The SSR Worker's `env.preview.services` binding is defined statically in `apps/web/wrangler.jsonc` as `aeci-api-preview`. Wrangler 4 has no CLI override for service bindings, so the workflow sed-rewrites the binding to `aeci-api-pr-<N>` on the runner before deploying SSR. The repo file is untouched.

This is the simplest of three options the AECI-79 issue body enumerated:

1. **(picked)** Shared dev DB. No per-PR Supabase branches; no Management API calls. Trade-off: previews cannot exercise migrations that haven't yet landed on `main`. Migration safety is covered by the PR-level drift check (`drift-check.yml`, future per AECI-71 build sequence) and by `refresh-staging.yml`'s drift gate.
2. Per-PR Supabase branch DB enrolled in Prisma Accelerate via the Prisma Data Platform API. Preserves migration isolation and respects the CLAUDE.md Accelerate-only baseline, but requires PDP API access from CI plus a different secret-management approach (each branch DB has its own Accelerate URL).
3. Per-PR Supabase branch DB consumed by `@prisma/adapter-pg-worker` (preview-only carve-out from CLAUDE.md), with `nodejs_compat` enabled on the preview API Worker. Same isolation as (2) without PDP API dependency, but introduces a documented exception to the Accelerate-only contract.

**Revisit conditions for (2) or (3).** Escalate if a migration-bearing PR ships a regression that per-PR DB isolation would have caught — e.g., a destructive migration whose effects are only visible against newly-shaped data. The orphan-detection runbook below covers both per-PR Workers under Option 1.

### Hitting a preview manually

Cloudflare Access fronts the `*.aec-integrations.workers.dev` wildcard via the "AECi Non-Prod" app (see [`docs/access.md`](./access.md) §2). Use the `aeci-gh-actions` service token from a shell:

```bash
export N=123  # PR number
curl \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  "https://aeci-web-pr-${N}.aec-integrations.workers.dev/api/version"
```

For browser access, the same Access app accepts OTP-to-email for the allowlisted human identities listed in `docs/access.md` §1.

### Orphan detection (monthly)

The `pr-preview.yml` cleanup job is idempotent and runs on every PR close, including merges and re-opens, so the steady-state should be zero orphan Workers. Audit monthly — there are now **two** per-PR Worker names to check per PR:

```bash
# Check a suspected orphan PR's Workers.
wrangler deployments list --name aeci-web-pr-<N>
wrangler deployments list --name aeci-api-pr-<N>
# Broader: enumerate via the Cloudflare Workers API and grep ^aeci-(api|web)-pr-
```

For any closed PR with leftover Workers, delete both (SSR first to drop public traffic, then API):

```bash
wrangler delete --name aeci-web-pr-<N> --force
wrangler delete --name aeci-api-pr-<N> --force
```

Under Option 1 there are no Supabase branches to audit — none are created. If we ever switch to Option 2 or 3, that audit step must be added here.

## Promote runbook

The [`promote-to-prod.yml`](../.github/workflows/promote-to-prod.yml) workflow (AECI-78) is the only way prod gets new code. Trigger it from the GitHub Actions UI:

1. Repo → Actions → **promote-to-prod** → **Run workflow**.
2. `commit_sha`: paste the full 40-char SHA you already verified on staging (matches what `https://staging.aecintegrations.com/api/version` reports).
3. `confirm`: type `PROMOTE` exactly.
4. Click **Run workflow**.

What happens, in order:

- **Pre-promotion checks (unattended, ~2 min)** — `pre-promotion-checks` job. Validates `confirm`, hits `staging.aecintegrations.com/api/version` with Cloudflare Access headers, and refuses to continue unless the staging SHA matches `inputs.commit_sha`. Then prints `supabase migration list --linked` against prod into the run log **and** the job summary so you can read the pending SQL inline before approving the next job.
- **Approval pause** — the `apply-prod-migrations` job enters the `production` GH Environment and blocks. The GitHub Actions UI shows "Waiting for review". Read the migration list in the previous job's summary before clicking Approve.
- **After approval (~5–10 min)** — `pg_dump` of prod → R2 (`aeci-prod-snapshots/prod-pre-<short-sha>.dump` plus a companion `-auth.dump` for auth-schema data), `supabase db push --linked`, drift check via `scripts/prisma-drift-check.sh` against `DIRECT_URL_PRODUCTION`. **HARD STOP on drift** — Workers don't deploy if drift is detected.
- **Worker deploys** — API first (`aeci-api-production`), SSR second (`aeci-web-production`). Each `wrangler deploy` line passes `--var COMMIT_SHA:${{ inputs.commit_sha }} --var DEPLOYED_AT:<shared timestamp>` per the CLAUDE.md non-negotiable.
- **Deploy marker + smoke** — Datadog `/api/v1/events` marker (docs/CICD_PLAN.md §9.1) tagged `env:production`, `service:aeci-ssr`, `commit:<sha>`. Then polls `https://aecintegrations.com/api/version` (public — no Access headers) until it returns `{ "sha": "<input>", "environment": "production" }`. Fails after a 60-second budget.

**Recovering from a bad promote.** The R2 snapshot is the rollback insurance. For DB:

```bash
aws --endpoint-url "$R2_ENDPOINT" s3 cp s3://aeci-prod-snapshots/prod-pre-<short-sha>.dump .
pg_restore --clean --no-owner --no-privileges --dbname "$DIRECT_URL_PRODUCTION" prod-pre-<short-sha>.dump
```

For Worker code: `wrangler rollback --env production` against `apps/api` and `apps/web` (docs/CICD_PLAN.md §6.1). Snapshots live 30 days per the bucket lifecycle rule — older incidents require a Supabase point-in-time restore.

**Common failure modes:**

| Failure | Where | What it means / what to do |
| --- | --- | --- |
| `staging is at <x>, refusing to promote <y>` | `pre-promotion-checks` | Staging's `/api/version` doesn't match `inputs.commit_sha`. Either re-deploy staging on the target SHA or change the input. |
| Drift check exits 1 with Prisma `P4002` | `apply-prod-migrations` | Known issue carried over from AECI-77 — cross-schema FK `public.profiles.id → auth.users(id)` makes `prisma db pull` fail. The drift step will hard-stop here until that FK is resolved in a separate issue. See `scripts/prisma-drift-check.sh:24-33` and `docs/prisma.md` §7. |
| Migrations applied but `/api/version` doesn't return the new SHA within 60s | `deploy-prod-workers` | Wrangler deploy completed but propagation hasn't caught up, or the SSR deploy failed half-way. Inspect the `wrangler-action` step logs; if SSR is wedged, `wrangler rollback --env production` on `apps/web`. |
| R2 upload fails | `apply-prod-migrations` | The snapshot is step 4 — migrations have NOT run yet, so it's safe to re-run after fixing R2 access. Check `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT`. |
| Snapshot needed but the bucket lifecycle already expired it | — | Snapshots live 30 days. Older incidents require a Supabase point-in-time restore. |

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
| `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` + `R2_ENDPOINT` | ❌ | ❌ | ✅ | Prod snapshot uploads (AECI-78). Bucket `aeci-prod-snapshots`, object key `prod-pre-<short-sha>.dump` (12-char truncated input SHA). Uploaded via AWS CLI against `R2_ENDPOINT` (S3-compatible). |
| `DATADOG_API_KEY` | ❌ | ❌ | ✅ | Used by `promote-to-prod.yml` (AECI-78) to POST deploy markers to Datadog `/api/v1/events` per CICD_PLAN §9.1. |
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
| `SUPABASE_DEV_PROJECT_REF` | The Supabase project ref for `aeci-development` (the dev/staging project, host the `main` branch DB used as staging) | Consumed by `refresh-staging.yml` (AECI-77) for `supabase link --project-ref` before `supabase db push --linked`. Set once when the dev project is provisioned per §1 below. |
| `SUPABASE_PROD_PROJECT_REF` | The Supabase project ref for `aeci-production` (`jgxebjufabtwkcgxjqvk` per §1) | Consumed by `promote-to-prod.yml` (AECI-78) for `supabase link --project-ref` before `supabase migration list --linked` (pre-promotion check) and `supabase db push --linked` (apply-prod-migrations). |

## Manual prerequisites — Chris's checklist before `STAGING_ENABLED=true`

The following must be done by hand (Supabase and Cloudflare dashboards + `gh secret set` + `wrangler secret put`) before the `deploy-staging` job in `.github/workflows/deploy.yml` will succeed.

### 1. Supabase projects

Production existed before the AECI Stage 1 migration system did — it holds the
live landing-page `feedback` and `mailing_list` tables written by
`apps/landing/` via PostgREST (see `20260101000000_landing_baseline.sql`). So
the dual-environment split is built around keeping that DB *as production* and
provisioning a fresh empty project for development:

- [x] **Rename** the existing Supabase project to `aeci-production` (Supabase Dashboard → Project Settings → General → Project name). Project ref `jgxebjufabtwkcgxjqvk` stays the same. This is the prod URL the landing Worker already points at.
- [x] **Provision a new empty project** named `aeci-development` in the same Supabase org. Region: match the prod project (lowest latency to Workers).
- [ ] **Reconcile prod migration history.** Prod's `supabase_migrations.schema_migrations` table has one stray row (`20260525060654`) from a manual repair attempt and is missing every AECI baseline. Before pushing, clear the stray row and record the landing baseline as already-applied (the tables exist; the SQL must not re-run):
  ```bash
  supabase link --project-ref jgxebjufabtwkcgxjqvk        # aeci-production
  npx supabase migration repair --linked --status reverted 20260525060654
  npx supabase migration repair --linked --status applied  20260101000000
  pnpm db:push   # applies the six AECI baselines on top of feedback/mailing_list
  ```
- [ ] **Bootstrap the dev project schema** (it's empty, so this is a clean push of all seven migrations):
  ```bash
  supabase link --project-ref <dev-ref>
  pnpm db:push
  ```
  Then `supabase link --project-ref <dev-ref>` is the day-to-day default (the CLI link should sit pointed at dev unless explicitly flipped for a prod operation).
- [ ] Verify both projects show all seven migrations in `pnpm db:list`. Dev should show all seven matched on both columns; prod should show the same once the steps above run successfully.

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

- [ ] `gh variable set SUPABASE_DEV_PROJECT_REF --body "<dev-ref>"` (consumed by `refresh-staging.yml` — AECI-77).
- [ ] `gh variable set STAGING_ENABLED --body "true"` (or set in the UI).

The next push to `main` will trigger `deploy-staging`. The smoke test will assert `staging.aecintegrations.com/api/version` returns `{ sha: <merge commit>, environment: "staging" }`.

### 8. Production bootstrap — Chris's checklist for `promote-to-prod.yml` (AECI-78)

These steps must land before the first successful `promote-to-prod.yml` run. None of them are reversible from CI — they create infrastructure outside the repo.

- [ ] **R2 bucket.** Cloudflare dashboard → R2 → **Create bucket** named `aeci-prod-snapshots` in the same account (`e62ec9d8012c3e0c225f8e4dbab76b79`).
- [ ] **R2 lifecycle rule.** On the bucket → Settings → Object lifecycle rules → add a rule that deletes all objects after 30 days. Acceptance criterion #4 requires this; a manual spot-check that an old object disappeared after the window is the verification.
- [ ] **R2 access keys.** R2 → Manage R2 API Tokens → create a token scoped to `aeci-prod-snapshots` (read + write). Push the three values:
  ```bash
  gh secret set R2_ACCESS_KEY_ID --body "<key id>"
  gh secret set R2_SECRET_ACCESS_KEY --body "<secret>"
  gh secret set R2_ENDPOINT --body "https://<account>.r2.cloudflarestorage.com"
  ```
- [ ] **Production Supabase secrets.** Once prod Supabase is fully bootstrapped (per §1):
  ```bash
  gh secret set DATABASE_URL_PRODUCTION --body "<prisma:// Accelerate URL>"
  gh secret set DIRECT_URL_PRODUCTION   --body "<postgresql://... pooler URL>"
  gh secret set SUPABASE_SERVICE_ROLE_KEY_PRODUCTION --body "<service role key>"
  ```
- [ ] **Datadog deploy-marker secret.** `gh secret set DATADOG_API_KEY --body "<key>"` (already exists for Worker runtime intake; CI needs its own copy to POST to `/api/v1/events`).
- [ ] **Production Worker secrets.** Run the same `wrangler secret put …` list from §6 against `--env production` from `apps/api/` and `apps/web/`.
- [ ] **Production project ref repo variable.** `gh variable set SUPABASE_PROD_PROJECT_REF --body "jgxebjufabtwkcgxjqvk"` (per §1).
- [ ] **Verify GH Environment.** The `production` GH Environment (created in §4) must list `chrisw@thewbsproject.com` as a required reviewer. Without that, the workflow's `apply-prod-migrations` job will not pause for approval.

Once all boxes are ticked, dry-run the workflow with a deliberately wrong `commit_sha` to verify the negative path: `pre-promotion-checks` must fail at step 4 with `staging is at <actual>, refusing to promote <input>` and the run must stop before any downstream job (acceptance criterion #2).

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
