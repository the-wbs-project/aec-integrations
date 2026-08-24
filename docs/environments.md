# Environments

> **Operator runbook.** Topology, promotion model, both manual buttons (`refresh-staging`, `promote-to-prod`), PR-preview lifecycle, PR-time drift gate, local seeding, secrets, and the one-time manual bootstrap checklist. If you only need to push a code change to staging or prod, the **Promote runbook** and **Refresh runbook** sections below are sufficient — everything above them is reference; everything below is reference + setup.
>
> Cross-references at the bottom point at companion docs that own narrower contracts (CI/CD plan, migrations, Cloudflare Access).

## Topology

AECi runs four permanent tiers of environment plus local, and — while Stage 2 is being tested — one temporary fifth (`stage2`, AECI-637). Worker and Supabase project naming is rigid — workflows, smoke tests, and docs assume these exact names.

| Tier | Cloudflare Workers | Supabase Auth | Public URL | Access control |
| --- | --- | --- | --- | --- |
| **Local** | `wrangler dev` / `pnpm dev:bound` | Shared auth project (or local `supabase start`) | `http://localhost:8788` | None (loopback) |
| **PR preview** | `aeci-{api,web}-pr-<N>` (`*.aec-integrations.workers.dev`) | Shared auth project | `*.workers.dev` (PR-specific) | Cloudflare Access — service token for CI, OTP-to-email for humans |
| **Staging** | `aeci-{api,web}-staging` | Shared auth project | `https://staging.aecintegrations.com` | Cloudflare Access — same allowlist as previews |
| **Demo** | `aeci-{api,web}-demo` | Shared auth project | `https://demo.aecintegrations.com` | Public (showcase) |
| **Production** | `aeci-{api,web}-production` | Shared auth project | `https://prod.aecintegrations.com` | Cloudflare Access until launch (ADR 0017), then public |
| **stage2** _(temporary — AECI-637)_ | `aeci-{api,web}-stage2` | Shared auth project | `https://stage2.aecintegrations.com` | Cloudflare Access — same allowlist as staging |

> **`stage2` is a throwaway tier, not a fifth permanent one.** It exists because staging auto-tracks `main` (ADR 0019), so the completed Stage 2 build on the `stage-2` branch has no deployed surface. It is **hand-deployed** from a `stage-2` SHA — there is no `promote-to-stage2.yml`, no GH Environment, no CI step and no GH secret that names it — and it runs **no crons and no queues** so it can never send real email or do scheduled work. Bootstrap + teardown: **§10** below. It also has **no Algolia** — search is not being tested on it (§10.4). Delete it when Stage 2 testing is done; everything about it, including the `env.stage2` config blocks and the `stage2` entries in the `ENV` / `DatadogEnv` / `AlgoliaEnv` unions, is meant to be reverted in one commit.

> **Supabase is auth-only** (app data is on D1 — ADR 0016). Per **[ADR 0017](./adr/0017-single-supabase-auth-project-across-environments.md)** a single shared auth project (`ktuhnlypztujpsseujzx`) backs **every** tier; per-environment isolation is provided by Cloudflare Access, not project separation. (The retained legacy Supabase-Postgres `public`-schema gate still lives on the old `dmbygwupskttzsvfzluq` / `jgxebjufabtwkcgxjqvk` projects until AECI-256/257 retire it — that's what the `SUPABASE_*_PROJECT_REF` repo variables below point at, unrelated to auth.)

> The **production** tier serves the apex `aecintegrations.com` + `www.aecintegrations.com` (the public home, `ALLOW_INDEXING="true"`, indexable) and `prod.aecintegrations.com` (the Access-gated internal host per ADR 0017, crawler-free); the **demo** tier serves `demo.aecintegrations.com` (the public showcase, still **no-index** `ALLOW_INDEXING="false"`). The **apex cutover** (AECI-247/277) binds `aecintegrations.com` + `www.` to `aeci-web-production` in the web wrangler config and folds the bare apex→`www.` with a 301 in the SSR Worker (`www.` is the canonical served host — ADR 0011 amendment 2026-07-05, reversing the original www→apex direction); the retired `apps/landing` Worker no longer serves them. The DNS reassignment (off the old landing Worker onto the app) executes on the next `promote-to-prod` deploy after the cutover PR merges — see `docs/launch-cutover-runbook.md`.
>
> **All tiers share one Supabase auth project** (ADR 0017; auth-only — the app DB is Cloudflare D1 per ADR 0016), so one admin login works everywhere. Demo and Production still have **independent** D1, KV, Cloudflare Queues, and Algolia index sets: production keeps `aeci-app-production` / `aeci-*-production` / `production_*`; demo has its own `aeci-app-demo` / `aeci-*-demo` / `demo_*`. The `ENV` var (and therefore Algolia prefix + Datadog `env` tag) is `production` vs `demo`; the two are the audience-facing tiers recognised by `isPublicSite()` (`@aeci/shared/deploy-env`) — both block `/preview/*`, strip per-request response validation, and bound per-render Datadog log volume.

Worker `name` (deployed) values in `apps/{web,api}/wrangler.jsonc`:

| Worker | Preview env | Staging env | Demo env | Production env | stage2 env _(temp)_ |
| --- | --- | --- | --- | --- | --- |
| `apps/api` | `aeci-api-preview` | `aeci-api-staging` | `aeci-api-demo` | `aeci-api-production` | `aeci-api-stage2` |
| `apps/web` | `aeci-web` (`workers_dev: true`) | `aeci-web-staging` | `aeci-web-demo` | `aeci-web-production` | `aeci-web-stage2` |

The SSR Worker (`apps/web`) is the only public ingress. The API Worker (`apps/api`) is reachable only via the SSR Worker's `services.API` binding. This is enforced per environment by matching `services.binding.service` to the API Worker's deployed `name` in the same tier.

## Promotion model

```
local → PR preview → staging (auto on merge to main) → demo (manual) → production (manual)
```

- **PR previews**: created by `.github/workflows/pr-preview.yml` (AECI-79) on `pull_request` open/sync; torn down on close.
- **Staging**: deployed by `.github/workflows/deploy.yml` `deploy-staging` job on every push to `main`, gated by `vars.STAGING_ENABLED`.
- **Staging refresh** (prod data → staging): `.github/workflows/refresh-staging.yml` (AECI-77), `workflow_dispatch` only.
- **Demo**: deployed by `.github/workflows/promote-to-demo.yml`, `workflow_dispatch` with `commit_sha` + `confirm=PROMOTE`. Verifies **staging** is at the SHA, then deploys the demo tier (GH Environment `demo`; no required reviewer unless you add one). The light sibling of promote-to-prod — it touches no Postgres (demo shares the prod Supabase project, which production owns), only the demo D1/queues/Workers/Algolia.
- **Production**: deployed by `.github/workflows/promote-to-prod.yml` (AECI-78), `workflow_dispatch` with required `commit_sha` + `confirm=PROMOTE` inputs and a GH Environment approval gate. Verifies **demo** (the immediate upstream tier) is at the SHA before promoting.

There is intentionally **no auto-deploy to demo or production** — both are deliberate `workflow_dispatch` buttons.

> **Branch model (post-launch, ADR 0019).** Production is live, so `main` is the **production/stable line** and Stage 2 develops on a **long-lived `stage-2` integration branch** (`docs/CICD_PLAN.md` §10). Staging auto-tracks `main`, which now means **staging is always a prod candidate** — only hotfixes and prod-safe additive work land on `main`. Applying a fix to live prod is the ordinary flow: branch from `main` → PR → squash-merge → staging auto-deploys → `promote-to-demo` (SHA) → `promote-to-prod` (SHA). Because the promote buttons take an **arbitrary** `commit_sha` (gated only on the SHA being live one tier up), no workflow change was needed; keeping Stage 2 off `main` is what keeps prod's D1 from receiving a Stage 2 migration (`promote-to-prod` applies migrations forward-only). Stage 2 is previewed via per-PR preview Workers, not staging.

## PR previews

Every PR against `main` gets a pair of ephemeral preview Workers — `aeci-api-pr-<N>` (private; bound to via service binding) and `aeci-web-pr-<N>` (public on the `*.aec-integrations.workers.dev` wildcard) — deployed by [`pr-preview.yml`](../.github/workflows/pr-preview.yml) on `pull_request` `opened` / `synchronize` / `reopened` and torn down on `closed`. First-party PRs only — fork PRs skip cleanly since they receive no secrets.

### DB strategy: Cloudflare D1 (ADR 0016)

Per-PR API Workers reach the app database through their `DB` D1 binding, inherited from the `env.preview` block in `apps/api/wrangler.jsonc` — no Prisma Accelerate, no `DATABASE_URL` secret. The Prisma Accelerate runtime path is retired (AECI-253), so the per-PR deploy no longer pushes `DATABASE_URL`. (Migrations are applied with `wrangler d1 migrations apply`.)

The SSR Worker's `env.preview.services` binding is defined statically in `apps/web/wrangler.jsonc` as `aeci-api-preview`. Wrangler 4 has no CLI override for service bindings, so the workflow sed-rewrites the binding to `aeci-api-pr-<N>` on the runner before deploying SSR. The repo file is untouched.

This is the simplest of three options the AECI-79 issue body enumerated:

1. **(picked)** Shared DB. No per-PR Supabase branches; no Management API calls. Trade-off: previews cannot exercise migrations that haven't yet landed on `main`. Migration safety is covered by the PR-level D1 schema drift check (`drift-check.yml`). _(Post-D1 note: per-PR API Workers now use the local D1 from the `env.preview` `DB` binding — there is no shared Postgres dev DB to point at anymore; ADR 0016.)_
2. _(no longer applicable — the Postgres/Prisma-Accelerate options below were enumerated pre-D1 and are kept only as decision history; Prisma was removed in AECI-278.)_ Per-PR Supabase branch DB enrolled in Prisma Accelerate via the Prisma Data Platform API. Preserved migration isolation but required PDP API access from CI plus a different secret-management approach.
3. _(no longer applicable — see (2).)_ Per-PR Supabase branch DB consumed by `@prisma/adapter-pg-worker`, with `nodejs_compat` on the preview API Worker. Same isolation as (2) without the PDP API dependency.

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

Under Option 1 there are no Supabase branches to audit — none are created. If we ever switch to Option 2 or 3 (per-PR branch DBs), an additional audit step lives below.

### Manually deleting a Supabase branch DB

Documented for completeness — under Option 1 (current) no per-PR branches exist, so this should never be needed. Kept here for two reasons: (a) human-runnable fallback if we adopt Option 2/3 and `pr-preview.yml` ever fails its cleanup step, and (b) recovery path if a branch is created manually (`supabase branch create …`) during ad-hoc testing and forgotten.

```bash
# Required: SUPABASE_MANAGEMENT_API_TOKEN with `branches:write` scope.
# Get one at https://supabase.com/dashboard/account/tokens (personal access
# token) or via the GH Actions secret of the same name in this repo.

# 1. List branches on the dev project. Look for the orphan by `git_branch` or `name`.
curl -sS \
  -H "Authorization: Bearer $SUPABASE_MANAGEMENT_API_TOKEN" \
  "https://api.supabase.com/v1/projects/$SUPABASE_PROJECT_REF/branches" \
  | jq '.[] | {id, name, git_branch, status}'

# 2. Delete the orphan by its branch ID (NOT name).
curl -sS -X DELETE \
  -H "Authorization: Bearer $SUPABASE_MANAGEMENT_API_TOKEN" \
  "https://api.supabase.com/v1/branches/<branch-id>"

# 3. Confirm it's gone — re-run the list call and grep for the ID.
```

Cost note: branch DBs bill per active day. A forgotten branch is the silent budget leak `pr-preview.yml` close-handling was designed to prevent.

## Refresh-staging runbook

The [`refresh-staging.yml`](../.github/workflows/refresh-staging.yml) workflow (AECI-77) **redeploys the staging Workers and smoke-tests them**. It was **gutted with the Postgres-app-DB decommission (AECI-278)**: it no longer does any `pg_dump` / `pg_restore` / `supabase db push` / GRANT-RLS re-assert / Postgres drift check — there is no Postgres app DB to refresh. Per [ADR 0017](./adr/0017-single-supabase-auth-project-across-environments.md) it **never touches the auth schema** either — auth is one shared project across all environments, and the test accounts are seeded into the shared auth project out of band (see "Test accounts" / `scripts/seed-staging-users.sql`).

**Refreshing staging _app data_ is now a separate, D1-native operation.** The Access-gated [`apps/datatool`](../apps/datatool) Worker clones one environment's D1 into another (replace-mirror of all tables) and reindexes Algolia; the staging D1 (`aeci-app-staging`) is seeded/cloned that way, not from a Postgres dump.

Trigger the redeploy from the GitHub Actions UI:

1. Repo → Actions → **refresh-staging** → **Run workflow** → branch `main` → **Run workflow**.
2. No inputs, no approval gate. The `staging-refresh` GH Environment is configured with no reviewers because the workflow is idempotent.
3. Concurrency group `refresh-staging` queues overlapping clicks rather than cancelling — a second press while the first is still running just waits, it does not stomp.

What happens, in order:

1. Checkout `main`; install pnpm + Node.
2. Deploy `aeci-api-staging` then `aeci-web-staging` via `wrangler-action`, passing `--var COMMIT_SHA:${{ github.sha }} --var DEPLOYED_AT:<shared timestamp>` per the CLAUDE.md non-negotiable.
3. Smoke test `https://staging.aecintegrations.com/api/health` with Cloudflare Access headers; then via `scripts/verify-version.sh` poll until **both** `/api/version` (API Worker) and `/_version` (SSR Worker, AECI-92) report the workflow's commit SHA (60-second budget). `/api/version` is proxied raw to the API Worker, so on its own it can't catch a stale SSR deploy.

**When to press it:**
- You want staging running the latest `main` SHA.

**Common failure modes:**

| Failure | Where | What it means / what to do |
| --- | --- | --- |
| Smoke test times out at 60s | Smoke step | Worker deploy completed but propagation lagging, or the Cloudflare Access service token (CF_ACCESS_CLIENT_ID/SECRET) rotated. Check `docs/access.md` §2. |
| Staging data looks stale / empty | (not this workflow) | App data is no longer refreshed here — use the `apps/datatool` Worker to clone/seed the staging D1 + reindex Algolia. |

## Drift check (PR-time)

The [`drift-check.yml`](../.github/workflows/drift-check.yml) workflow (AECI-264) is the PR-time **schema-vs-migrations** gate for the **D1 app database** (ADR 0016 / AECI-248→257). It runs on every PR that touches `apps/api/src/db/schema.ts`, `apps/api/drizzle.config.ts`, `apps/api/migrations/**`, or itself. Most PRs skip it entirely thanks to the `paths:` filter — you'll only see it on schema-changing work.

**What it does:**

1. `pnpm install --frozen-lockfile`, then `pnpm --filter @aeci/api db:generate` (drizzle-kit generate). No database is booted — drizzle-kit reads the TS schema (`apps/api/src/db/schema.ts`) and writes SQL into `apps/api/migrations/`.
2. Fails if `git status --porcelain -- apps/api/migrations` is non-empty afterwards — i.e. `schema.ts` produced a migration that isn't committed. New untracked files are caught (porcelain, not `git diff`).

**When it fails — how to fix:**

Drift means you edited `apps/api/src/db/schema.ts` but didn't generate + commit the migration. Fix locally:

```bash
git checkout <your-branch>
pnpm --filter @aeci/api db:generate    # drizzle-kit writes the new migration SQL + snapshot
git add apps/api/migrations            # includes meta/_journal.json + the snapshot
git commit -m "chore: generate migration for schema.ts change"
git push
```

The drift-check job will re-run on the new commit and pass.

**Drift, recap.** `drift-check.yml` (this PR-time workflow) is the **only** schema-drift gate now — it guards the **D1 app schema** (`schema.ts` ↔ `apps/api/migrations/`). The former Postgres `schema.prisma` drift gate (`scripts/prisma-drift-check.sh`, run by `refresh-staging.yml`) and the post-promote Postgres drift check were **deleted with the Postgres-app-DB decommission (AECI-278)**; there is no Postgres schema/RLS drift gate anymore.

**Re-running manually.** To reproduce the PR-time check on your laptop:

```bash
pnpm --filter @aeci/api db:generate
git status --porcelain -- apps/api/migrations   # empty output = no drift
```

That's the literal check CI runs.

## Promote-to-demo runbook

The [`promote-to-demo.yml`](../.github/workflows/promote-to-demo.yml) workflow promotes a staging-verified SHA to the public **demo** tier (`demo.aecintegrations.com`). It is the light sibling of promote-to-prod: demo shares the prod Supabase project (which production owns), so this workflow touches **no Postgres** — no R2 snapshot, no `supabase db push`, no RLS/drift gate. It only provisions the demo queues, applies the **demo D1** (`aeci-app-demo`) migrations, deploys the `aeci-{web,api}-demo` Workers, pushes the demo Worker secrets, and smoke-tests `demo.aecintegrations.com`.

1. Repo → Actions → **promote-to-demo** → **Run workflow**.
2. `commit_sha`: paste the full 40-char SHA you verified on staging (matches `https://staging.aecintegrations.com/api/version`).
3. `confirm`: type `PROMOTE` exactly, then **Run workflow**.

What happens, in order: validate `confirm` → preflight required secrets → assert **staging** is at the SHA (both Workers, with Access headers) → (GH Environment `demo`) provision `aeci-*-demo` queues → apply `aeci-app-demo` D1 migrations + taxonomy seed (`scripts/d1-apply-migrations.sh`, which retries each remote D1 command on a transient Cloudflare `[code: 7500]` internal error) → deploy API then SSR (`--env demo`) → push demo Worker secrets (warn-and-skip for the non-critical ones) → smoke-test `demo.aecintegrations.com` (both Workers at SHA + `/api/health` db:ok) → apply demo Algolia index settings → auto-rollback both demo Workers on a smoke failure. The `demo` GH Environment has no required reviewer by default (add one to gate it). Demo is a showcase, so only the D1 `/api/health` gate (the `DB` binding must answer `db:ok`) is fail-closed; Algolia/email/analytics are warn-and-skip.

## Promote runbook

The [`promote-to-prod.yml`](../.github/workflows/promote-to-prod.yml) workflow (AECI-78) is the only way prod gets new code. **It promotes from the demo tier** (chain: staging → demo → production), so promote a SHA to **demo** first via [`promote-to-demo.yml`](#promote-to-demo-runbook). Trigger it from the GitHub Actions UI:

1. Repo → Actions → **promote-to-prod** → **Run workflow**.
2. `commit_sha`: paste the full 40-char SHA you already verified on demo (matches what `https://demo.aecintegrations.com/api/version` reports).
3. `confirm`: type `PROMOTE` exactly.
4. Click **Run workflow**.

What happens, in order:

- **Pre-promotion checks (unattended, ~2 min)** — `pre-promotion-checks` job. Validates `confirm`, runs `scripts/require-secrets.sh` (refuses to promote — **before** the approval gate — if a required prod secret is missing), then via `scripts/verify-version.sh` asserts the **demo** SHA matches `inputs.commit_sha` on **both** `demo.aecintegrations.com/api/version` (API Worker) and `/_version` (SSR Worker, AECI-92) — demo is public, so the Cloudflare Access headers are harmless — refusing to continue unless both match. `/api/version` is proxied raw to the API Worker, so on its own it can't catch a stale SSR deploy.
- **Approval pause** — the `deploy-prod-workers` job enters the `production` GH Environment and blocks **before any mutation** (queue/D1/deploy). The GitHub Actions UI shows "Waiting for review". This is the single approval gate.
- **After approval (~5 min)** — provisions the prod scheduled-job queues, then applies the **app DB migrations to Cloudflare D1** (`wrangler d1 migrations apply aeci-app-production --remote`), reconciles the D1 taxonomy seed (`wrangler d1 execute … --file=seed/taxonomy.sql`), and purges the taxonomy cache tags. This is the **only** data migration: the app DB is D1 (ADR 0016) and auth is the single shared Supabase project (ADR 0017) whose auth-only baseline is maintained out of band, so the promote touches **no** Supabase Postgres — there is no pg_dump → R2 snapshot, no `supabase db push`, no drift/RLS gate (mirrors `promote-to-demo.yml`, the post-D1 template — AECI-256/278).
- **Worker deploys** — API first (`aeci-api-production`), SSR second (`aeci-web-production`). Each `wrangler deploy` line passes `--var COMMIT_SHA:${{ inputs.commit_sha }} --var DEPLOYED_AT:<shared timestamp>` per the CLAUDE.md non-negotiable, then pushes the Worker runtime secrets.
- **Deploy marker + smoke** — Datadog `/api/v1/events` marker (docs/CICD_PLAN.md §9.1) tagged `env:production`, `service:aeci-ssr`, `commit:<sha>`. Then via `scripts/verify-version.sh` + `scripts/verify-health.sh` polls until **both** `https://prod.aecintegrations.com/api/version` (API Worker) and `/_version` (SSR Worker, AECI-92) report `sha: "<input>"` **and** `/api/health` is `db:ok`. Fails after a 60-second budget; a smoke failure auto-rolls-back both Workers.

**Recovering from a bad promote.** Worker code rolls back automatically on a smoke failure, or by hand: `wrangler rollback --env production` against `apps/api` and `apps/web` (docs/CICD_PLAN.md §6.1). The app DB is **Cloudflare D1** with 30-day time-travel — restore it to a point just before the promote (the DB is **not** auto-restored; the failure runbook in the run summary prints the exact commands):

```bash
cd apps/api
pnpm exec wrangler d1 time-travel info aeci-app-production --env production
pnpm exec wrangler d1 time-travel restore aeci-app-production --env production --timestamp=<ISO8601-before-promote>
```

Auth lives in the single shared Supabase project (ADR 0017) and is **not** touched by the promote — recover it via a Supabase point-in-time restore only if ever needed.

**Common failure modes.** Re-runs are **job-scoped**: `Re-run failed jobs` re-runs only the failed job and its dependents, preserving the original `commit_sha` / `confirm` inputs, and a re-run of `deploy-prod-workers` re-enters the `production` approval gate. So a `pre-promotion-checks` failure costs one ~2-min job, not a full promote. There is no step-level resume — see `CICD_PLAN.md` §13.4 for why that is sufficient here.

| Failure | Where | What it means / what to do |
| --- | --- | --- |
| `[production] REFUSING to deploy — required secret(s) missing: …` | `pre-promotion-checks` | A required prod GH Actions secret is unset/empty; `scripts/require-secrets.sh` lists every missing one at once. Set them (Settings → Secrets and variables → Actions) and re-run — nothing was deployed and no DB was touched. |
| `demo is not at <sha> on both Workers (API + SSR), refusing to promote` | `pre-promotion-checks` | Demo's `/api/version` (API Worker) and/or `/_version` (SSR Worker) don't match `inputs.commit_sha`; `scripts/verify-version.sh` logs the actual per-Worker SHAs. Promote the SHA to demo first (`promote-to-demo`), or change the input. |
| `wrangler d1 migrations apply` exits non-zero | `deploy-prod-workers` | The D1 migration failed (commonly `CLOUDFLARE_API_TOKEN` lacking Account → D1 → Edit). Runs after approval but **before** the Worker deploys, so nothing shipped — fix the token/migration and re-run. |
| Deployed but `/api/version` or `/_version` doesn't return the new SHA within 60s | `deploy-prod-workers` | Wrangler deploy completed but propagation hasn't caught up, or the SSR deploy failed half-way (a stale `/_version` with a current `/api/version` is exactly the AECI-92 case the dual check catches). The smoke failure auto-rolls-back both Workers; inspect the deploy step logs. |
| `pnpm algolia:apply-settings` exits non-zero | `deploy-prod-workers`, **after** the smoke gate | **The release is live and healthy** — this step runs after smoke and sits outside the auto-rollback guard (which fires only on `steps.smoke.outcome == 'failure'`), so nothing was reverted. Do **not** re-run the whole promote to retry one `setSettings`. Re-apply directly: `pnpm algolia:apply-settings --env production` (needs `ALGOLIA_APP_ID` + `ALGOLIA_ADMIN_KEY`). |

## Local dev: running the API Worker (D1)

The API Worker reaches the application database through its native **D1 `DB` binding** via Drizzle (ADR 0016) — no external proxy, no `DATABASE_URL`, no Prisma Accelerate. In local `wrangler dev` / `pnpm dev:bound`, that binding resolves to a **per-workspace local SQLite D1** in `.wrangler/state` (not a shared remote DB).

### The local D1 is auto-migrated and seeded

You don't point a connection string at anything. `pnpm dev` / `dev:preview` run `db:setup:local` before booting, which applies the Drizzle migrations (`wrangler d1 migrations apply … --local`) and seeds the local D1 (taxonomy reference data + a sample catalog). To do it by hand:

```bash
pnpm --filter @aeci/api db:setup:local     # migrate + seed the local SQLite D1
```

Each workspace has its **own** local D1 (`.wrangler/state` is gitignored and not shared), so local writes never touch staging, another developer, or prod.

### What this means day to day

Running the app locally renders real seeded data and you can freely exercise write paths (`POST /api/promote`, review/moderation flows, page-view inserts) against your isolated local D1. There is **no `supabase start` / local Postgres container** in the DB path — that was the retired Prisma/Supabase-CLI workflow. Supabase is only involved for **Auth** (set `SUPABASE_URL` + the anon key in `.dev.vars`; see "Local dev: Supabase auth" below).

### Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `/api/health` returns 500 `{ ok:false, db:"error" }` | The local D1 wasn't migrated/seeded, or the `DB` binding is missing | Run `pnpm --filter @aeci/api db:setup:local`, then restart `pnpm dev:agent`. (`pnpm dev` runs this for you.) |

## Local dev: Supabase auth (Phase 5)

AECI-193 wired Supabase Auth into both Workers. To exercise it locally against
the **single shared auth project** (`ktuhnlypztujpsseujzx`, ADR 0017):

1. **`.dev.vars` setup.**
   - `apps/web/.dev.vars`: set `SUPABASE_URL=https://ktuhnlypztujpsseujzx.supabase.co`
     and `SUPABASE_ANON_KEY=<publishable key>` (fetch with
     `supabase projects api-keys --project-ref ktuhnlypztujpsseujzx`). Also set
     `SUPABASE_TEST_USER_EMAIL` / `SUPABASE_TEST_USER_PASSWORD` for the mint
     script (these are **never** Worker bindings).
   - `apps/api/.dev.vars`: set the same `SUPABASE_URL` (the API Worker reads it
     for JWKS + issuer). It needs **no** anon key to verify tokens; the
     service-role key is optional locally (only the ADR-0016 admin seams use it).

2. **Mint a session.** From `apps/web`:
   ```bash
   node --env-file=.dev.vars scripts/mint-dev-session.mjs
   ```
   It signs in the test user and prints the JWT header (confirm `alg: ES256`),
   the raw access token, and a ready-to-paste `Cookie:` header. The session
   lasts 1h — re-mint when it lapses.

3. **curl smoke** (boot the stack with `pnpm dev:agent`; note the printed web
   port, e.g. `8790`):
   ```bash
   # 401 without a session, non-cacheable:
   curl -is http://localhost:8790/auth/whoami
   # 200 { ssr, api } with the minted cookie (proves the full chain):
   curl -s  http://localhost:8790/auth/whoami -H "Cookie: <minted cookie>"
   # Direct API: 401 without / 200 with the bearer token:
   curl -s  http://localhost:8790/api/auth/whoami -H "Authorization: Bearer <token>"
   ```
   An unprovisioned Worker (no `SUPABASE_ANON_KEY`) returns `503
   auth_not_configured` instead of 401 — distinct on purpose.

4. **Authed console-health e2e (AECI-235).** `apps/web/e2e/authed-console.spec.ts`
   reuses the same mint recipe to visit the four auth-gated Phase 5 pages
   (`/account`, `/admin`, `/admin/reviews`, `/products/:slug/review`) with a real
   admin session and assert zero console errors. To run it locally, the **test user
   must be the admin** — set `SUPABASE_TEST_USER_EMAIL=test@thewbsproject.com` /
   `SUPABASE_TEST_USER_PASSWORD=<password>` in `apps/web/.dev.vars`
   (`playwright.config.ts` reads the `SUPABASE_*` keys from there). The admin role is
   re-read from the **D1 `profiles`** table on every API request, so the admin's
   `role='admin'` profile (`apps/api/seed/auth-fixtures.sql`, keyed to that account's
   Supabase user id `519f1e77-6e60-440e-81a9-3354d06be0b6`) must be seeded — `dev:bound`
   → `db:seed:local` does this automatically. If the account is ever recreated, re-mint
   it and update the id in `auth-fixtures.sql` to match the new `sub`. The spec **skips**
   (never fails) when the
   creds/anon key are absent or sign-in fails. In CI it stays skipped until the
   `SUPABASE_TEST_USER_EMAIL` / `SUPABASE_TEST_USER_PASSWORD` GH secrets are set (see
   "Secrets"); the `deploy.yml` Playwright step already passes them through.

   **Vendor persona (AECI-522).** `apps/web/e2e/vendor-dashboard.spec.ts` drives the
   Stage 2 `/vendor` portal with a **second** minted persona — the `auth-session.ts`
   mint is parameterized (`mintSessionCookies(baseURL, 'vendor')`). It needs a real
   `vendor_admin` account (`SUPABASE_VENDOR_TEST_USER_EMAIL` /
   `SUPABASE_VENDOR_TEST_USER_PASSWORD`) with a `role='vendor_admin'` **and a non-null
   `vendor_id`** D1 profile — seeded in `apps/api/seed/auth-fixtures.sql`, anchored to the
   `...061` fixture vendor (`fixture-procore-technologies`, which carries a
   `product_vendors` link so the dashboard has an owned product). The profile `id` in that
   file **is** the vendor account's real Supabase `sub` (`e1a8f812-…`); if the account is
   recreated, re-mint and update it. Same skip-when-unconfigured posture; local dev sets
   the pair in `apps/web/.dev.vars`. **Remaining manual step** (one-time): set the two
   `SUPABASE_VENDOR_TEST_USER_*` GH secrets to activate the gate in CI (the `deploy.yml`
   Playwright step already passes them through, warn-and-skip when absent).

5. **`SUPABASE_URL` override for local-stack RLS specs.** The API Worker runtime
   `SUPABASE_URL` points at the shared auth project, but the PostgREST/RLS
   integration suites can run against a **local** `supabase start` stack by
   overriding per-invocation — a shell-set var beats `dotenv -e .dev.vars`:
   ```bash
   SUPABASE_URL=http://127.0.0.1:54321 \
   SUPABASE_ANON_KEY=<local anon> SUPABASE_SERVICE_ROLE_KEY=<local secret> \
   pnpm --filter @aeci/api test:integration
   ```

> ⚠️ **Never run service-role admin-API specs against the shared dev project.**
> Any integration spec (or the CI lane's mint step) that creates/deletes real
> `auth.users` via the admin API must run only against a throwaway local
> `supabase start` stack. Keep `SUPABASE_SERVICE_ROLE_KEY` empty in
> `apps/api/.dev.vars` (specs that need it self-skip) and supply it **only** in a
> local-stack override like the one above.

## Deployed Supabase Auth: redirect-URL configuration (dashboard)

Magic-link and Google-OAuth links are built by Supabase, not by us. Our browser
client passes `emailRedirectTo = <origin>/auth/callback?...` (`auth.service.ts`),
but **Supabase only honours that value if the URL matches the project's
"Redirect URLs" allow-list**; otherwise it silently falls back to the project's
**Site URL**. So a project left at the Supabase defaults
(`site_url = http://localhost:3000`, no real redirect URLs) makes every deployed
magic link **point at localhost** — even though the request came from staging.

> `supabase/config.toml` `[auth].site_url` / `additional_redirect_urls` configure
> only the **local `supabase start` stack**. They do **not** reach the deployed
> project — the dashboard (Authentication → URL Configuration) is the source of
> truth. Per **[ADR 0017](./adr/0017-single-supabase-auth-project-across-environments.md)**
> there is now **one** shared auth project, so it must allow-list **every** origin
> across all environments (there is no per-env split inside one project).

**Shared auth project `ktuhnlypztujpsseujzx`** (serves local dev + PR previews + staging + production):
- **Redirect URLs** (wildcards allowed; `/**` covers `/auth/callback?…`):
  - `https://demo.aecintegrations.com/**` — production
  - `https://staging.aecintegrations.com/**` — staging
  - `https://*.aec-integrations.workers.dev/**` — PR-preview SSR origins
  - `http://localhost:8788/**` and `http://localhost:8790/**` — local dev (primary + agent workspaces; `globalThis.location.origin` is the SSR port)
  - `https://aecintegrations.com/**` — the public launch domain, when it lands
- **Site URL**: `https://demo.aecintegrations.com` — the deployed fallback (only used when a request omits/​mismatches `emailRedirectTo`).

After editing the allow-list, re-request the magic link — the email's `redirect_to`
should now carry the staging callback, not localhost. No deploy is needed (it's
project config, not a Worker secret).

## Deployed Supabase Auth: Google OAuth provider (dashboard)

The redirect-URL allow-list above governs where Supabase is *allowed to send the
user back*; it is **independent** of which OAuth providers are *enabled*. Magic
link can work perfectly while Google is off. If the Google provider is not enabled
on the shared project, `auth.service.ts`'s `signInWithOAuth({ provider: 'google' })`
fails immediately — before any redirect — with:

```
{"code":400,"error_code":"validation_failed","msg":"Unsupported provider: provider is not enabled"}
```

Because there is **one** shared auth project (ADR 0017), enabling Google there
turns it on for every environment at once (and leaving it off breaks Google in
every environment at once). Provider config, like redirect URLs, does **not** live
in `supabase/config.toml` for the deployed project — the dashboard is the source of
truth. Two dashboards, done once:

1. **Google Cloud Console** (create the OAuth client):
   - APIs & Services → OAuth consent screen → configure (External; add the app name,
     support email, and the `aecintegrations.com` authorized domain).
   - APIs & Services → Credentials → **Create Credentials → OAuth client ID** →
     **Web application**.
   - **Authorized redirect URI** — add **exactly one**, the shared project's Supabase
     callback (Google only ever redirects back to Supabase; the app origins live in
     the "Redirect URLs" allow-list above, **not** here):
     `https://ktuhnlypztujpsseujzx.supabase.co/auth/v1/callback`
   - Copy the generated **Client ID** and **Client Secret**.
2. **Supabase Dashboard** (`ktuhnlypztujpsseujzx`) → **Authentication → Providers →
   Google**:
   - Toggle **Enable Sign in with Google** on.
   - Paste the **Client ID** and **Client Secret** from step 1. **Save**.

No Worker deploy is needed — it's project config, not a Worker secret. Verify from
`/auth/login` on any origin already in the redirect allow-list (e.g. `localhost:8788`
or staging): "Continue with Google" should now reach the Google consent screen and
land back on `/auth/callback` with a session (watch `aeci.auth.signin{method:google}`
in Datadog, per `docs/OBSERVABILITY.md`). If it still 400s with "provider is not
enabled", the toggle didn't save or `SUPABASE_URL` is pointed at a different project
than the one you edited.

## Secrets

Secrets are stored in three places:
- **GitHub Actions secrets** (repo-level, used by `.github/workflows/*.yml`).
- **Cloudflare Worker secrets** (per Worker `name`, set via `wrangler secret put <KEY> --env <env>`; not visible in source).
- **Local `.dev.vars`** (per app, gitignored; mirrors a subset of Worker secrets for local dev).

| Secret | Staging Worker | Prod Worker | GH Actions | Notes |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` — **RETIRED** | ❌ | ❌ | ❌ — the `DATABASE_URL_{STAGING,PRODUCTION}` GH secrets have been removed | The app DB is Cloudflare D1 (ADR 0016), reached via the Worker's `DB` binding — there is **no DB connection secret**. The Prisma Accelerate runtime path is retired (AECI-253), so CI no longer pushes `DATABASE_URL` to any Worker and the e2e/Lighthouse runs boot a local D1 via `db:setup:local`. |
| `DIRECT_URL_STAGING` / `DIRECT_URL_PRODUCTION` (Supabase pooler `postgresql://…`) — **orphaned** | ❌ | ❌ | ⚠️ orphaned | Formerly used by `deploy.yml`'s `db-migrate-dev` and `refresh-staging.yml` for `supabase db push` / `pg_dump`. The Postgres-app-DB machinery was decommissioned (AECI-278) — `db-migrate-dev` was removed, `refresh-staging.yml` gutted to a redeploy, and the local `seed-from-staging.sh` helper deleted — so **nothing reads these any more**. Safe to delete from GH secrets. Workers never see them. |
| `SUPABASE_ACCESS_TOKEN` — **orphaned** | ❌ | ❌ | ⚠️ orphaned | Was for the `supabase` CLI in CI (`deploy.yml` db-migrate-dev + `refresh-staging.yml`). Those Postgres steps were removed (AECI-278); the only CLI use left is the manual auth-baseline `supabase migration repair` decommission step. |
| `SUPABASE_MANAGEMENT_API_TOKEN` | ❌ | ❌ | ✅ | For PR-preview branch lifecycle (AECI-79). |
| `CLOUDFLARE_API_TOKEN` | ❌ | ❌ | ✅ | Scoped narrowly per CICD_PLAN §7.1. |
| `CLOUDFLARE_ACCOUNT_ID` | ❌ | ❌ | ✅ | `e62ec9d8012c3e0c225f8e4dbab76b79` |
| `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` | ❌ | ❌ | ✅ | Service token for non-prod smoke tests (`docs/access.md` §1). |
| `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` + `R2_ENDPOINT` | ❌ | ❌ | ⚠️ orphaned | Formerly the prod pre-promote `pg_dump` → R2 snapshot (AECI-78; bucket `aeci-prod-snapshots`, object key `prod-pre-<short-sha>.dump`). **Retired with the Postgres steps (AECI-256)** — no workflow writes the bucket now; the app DB is D1 with 30-day time-travel for rollback. Safe to delete the GH secrets once the bucket's retained dumps age out. |
| `DATADOG_API_KEY` | ❌ | ❌ | ✅ | Used by `promote-to-prod.yml` (AECI-78) to POST deploy markers to Datadog `/api/v1/events` per CICD_PLAN §9.1. |
| `RESEND_API_KEY` | ✅ on staging API Worker | ✅ on prod API Worker | — | Transactional email (AECI-240). **Single shared (un-suffixed) key** — one Resend account/key spans every env (like `SUPABASE_ANON_KEY`); `deploy.yml` (staging), `promote-to-demo.yml`, and `promote-to-prod.yml` all push this same secret to the Worker as `RESEND_API_KEY`. Graceful warn-and-skip; absent → sends `'skipped'`. See `docs/email.md`. |
| Datadog `DD_*` (per `apps/web/wrangler.jsonc` header) | ✅ per env | ✅ per env | — | RUM + Logs intake. |
| `ADMIN_PURGE_TOKEN` | ✅ on **web Worker** (CI-pushed) | ✅ on **web Worker** (CI-pushed) | ✅ un-suffixed `ADMIN_PURGE_TOKEN` (one shared value, every env) | Gates `POST /admin/purge` — native `ctx.cache.purge()` in-process since WC-6 (AECI-56 / AECI-320). Bearer the **caller** presents (CI's taxonomy purge + manual incident purges). **CI-pushed since 2026-08-12** by `deploy.yml` (staging), `promote-to-demo.yml`, `promote-to-prod.yml` — the same GH secret CI presents is the one placed on the Worker, so the two can't drift. Optional + fail-open (warn-and-skip): absent → the endpoint 401s and cache invalidation degrades to TTL self-heal. **Never on the API Worker.** |
| `CF_ZONE_ID` | ✅ on **API Worker** (CI-pushed) | ✅ on **API Worker** (CI-pushed) | ✅ un-suffixed (single zone) | Zone id for the AECI-262 WAF firewall-event poll (paired with `CF_ANALYTICS_API_TOKEN`). **CI-pushed since 2026-08-12** by the same three workflows. It was also the old cache-purge zone; that use is gone — `CF_PURGE_API_TOKEN` was retired in WC-10 (AECI-324) and the web Worker no longer needs a zone id at all. Optional + fail-open: absent → the WAF poll reports `skipped_no_creds`. |
| `ALGOLIA_APP_ID` | ✅ per env (both Workers) | ✅ per env (both Workers) | ✅ (shared, one value) | Algolia app id (AECI-134). Single value, all envs. |
| `ALGOLIA_SEARCH_KEY` (query-only) | ✅ on web Worker (CI-pushed) | ✅ on web Worker (CI-pushed) | ✅ **single shared** un-suffixed `ALGOLIA_SEARCH_KEY` (one value for every env — staging/production/demo, and the `lighthouse.yml` preview `/search` measurement, AECI-188). The former `_STAGING`/`_PRODUCTION`/`_PREVIEW`/`_DEMO` secrets are retired. | Search-only key, client-exposed. **Must be scoped to cover every env's indexes it serves** (`staging_*`/`production_*`/`demo_*`/`preview_*`) — it's now one shared value, so a key scoped to a single env breaks the others. CI-pushed to the web Worker alongside `ALGOLIA_APP_ID` by `deploy.yml` (staging — recommended/warn-and-skip), `promote-to-prod.yml` (production — required/fail-closed), `promote-to-demo.yml` (demo). **Never on the API Worker.** |
| `ALGOLIA_ADMIN_KEY` (management) | ✅ on API Worker | ✅ on API Worker | ✅ **single shared** un-suffixed `ALGOLIA_ADMIN_KEY` (one value, all envs). The former `_STAGING`/`_PRODUCTION` secrets are retired. | Management key (search + index-mutation) — sync from 3.5. One Algolia app spans all envs and the admin key reaches every index (`--env` is only an index-name prefix). **Never on the web Worker / never client-exposed.** |
| `SUPABASE_URL` (shared auth project URL) | ✅ all envs (both Workers, as a wrangler `var`) | ✅ all envs (both Workers, as a wrangler `var`) | — (it's a public `var` in `wrangler.jsonc`, not a GH secret) | AECI-193 / Phase 5 / ADR 0017. Public base URL — the **single shared auth project** (`ktuhnlypztujpsseujzx`) across every environment. Web Worker → cookie-session factory; API Worker → JWKS user-JWT verify (no DB round-trip). |
| `SUPABASE_ANON_KEY` (publishable/anon) | ✅ on **web Worker only** (CI-pushed) | ✅ on **web Worker only** (CI-pushed) | ✅ as the un-suffixed `SUPABASE_ANON_KEY` — a **single shared key**, one value for every env (ADR 0017); demo + per-PR previews push the same secret | AECI-193 / Phase 5 / ADR 0017. Publishable key for the **single shared auth project** (`ktuhnlypztujpsseujzx`); stored as a secret only to keep it out of git (like `ALGOLIA_SEARCH_KEY`). Pushed by `deploy.yml` (staging), `promote-to-prod.yml` (production), `promote-to-demo.yml` (demo), `pr-preview.yml` (per-PR). **It must match `SUPABASE_URL`'s project** — a stale per-project key against the shared URL is what produces the browser `Invalid API key` sign-in error. **Never on the API Worker** (it verifies with public JWKS material). **Recommended, not required, during Phase 5 — warn-and-skip; flips to REQUIRED in 5.5.** Absent → SSR auth surfaces return `503 auth_not_configured`. |
| `SUPABASE_TEST_USER_EMAIL` + `SUPABASE_TEST_USER_PASSWORD` | ❌ never on a Worker | ❌ never on a Worker | ✅ (CI test only) | AECI-235. Credentials for the **admin** test user (`test@thewbsproject.com`, an admin account in the shared Supabase project; its `role='admin'` D1 profile is keyed to Supabase user id `519f1e77-…` in `apps/api/seed/auth-fixtures.sql`) that `apps/web/e2e/authed-console.spec.ts` signs in to console-check the auth-gated Phase 5 pages. Consumed only by the `deploy.yml` Playwright step `env:` (never a Worker binding, never client-exposed). **Optional — warn-and-skip:** absent → the spec skips its 4 cases. Local dev sets the same pair in `apps/web/.dev.vars`. **Remaining manual step** to activate the gate in CI. |
| `SUPABASE_VENDOR_TEST_USER_EMAIL` + `SUPABASE_VENDOR_TEST_USER_PASSWORD` | ❌ never on a Worker | ❌ never on a Worker | ✅ (CI test only) | AECI-522. Credentials for the **vendor** test user (a `role='vendor_admin'` account with a non-null `vendor_id`; its D1 profile is seeded in `apps/api/seed/auth-fixtures.sql`, id `e1a8f812-…` = the account's real Supabase `sub`, anchored to the `...061` fixture vendor) that `apps/web/e2e/vendor-dashboard.spec.ts` signs in to drive the Stage 2 `/vendor` portal. Same warn-and-skip posture as the admin pair; `deploy.yml` Playwright step already passes them through. **Remaining manual step:** set the two GH secrets to activate the gate in CI. |
| `ANTHROPIC_API_KEY` (review toxicity scoring) | ✅ on **API Worker only** (CI-pushed) | ✅ on **API Worker only** (CI-pushed) | ✅ as `ANTHROPIC_API_KEY_STAGING` / `_PRODUCTION` (previews reuse `_STAGING`) | AECI-258. Anthropic key for Claude-Haiku toxicity scoring on `POST /api/reviews`. CI-pushed to the API Worker by `deploy.yml` (staging), `promote-to-prod.yml` (production), and `pr-preview.yml` (per-PR). **Optional + fail-open on every env (prod included) — warn-and-skip:** a missing key stores `toxicity_score=null` ("Not scored") and the review still enters the moderation queue, so it is **never** in `REQUIRED_WORKER_SECRETS`. **Never on the web Worker.** Supersedes the sunsetting Perspective API. **GDPR prerequisite:** the Messages API has no per-request no-store control (Perspective's `doNotStore` had no equivalent), so the Anthropic org behind the key **must** have zero data retention (ZDR) enabled before a real key is provisioned — confirm as a launch gate, otherwise scored review bodies are retained ~30 days outside the §8 erasure boundary. |
| `POSTHOG_KEY` (publishable project key) | ✅ on **web Worker only** (CI-pushed) | ✅ on **web Worker only** (CI-pushed) | ✅ as `POSTHOG_KEY_STAGING` / `_PRODUCTION` (previews reuse `_STAGING`) | AECI-239 / Phase 7.4. Client-exposed project API key for the browser product-analytics layer; stored as a secret only to keep it out of git (like `ALGOLIA_SEARCH_KEY`). CI-pushed to the web Worker by `deploy.yml` (staging), `promote-to-prod.yml` (production), `pr-preview.yml` (per-PR). **Optional + fail-open on every env — warn-and-skip:** absent → no `window.__AECI_POSTHOG__` and analytics no-ops. Also gated client-side by the consent banner + DNT. **Never on the API Worker.** |
| `POSTHOG_HOST` (ingestion host) | ✅ per env (web Worker, wrangler `var`) | ✅ per env (web Worker, wrangler `var`) | — (public `var` in `wrangler.jsonc`, not a GH secret) | AECI-239. `https://us.i.posthog.com` (US Cloud). The static CSP `connect-src` is pinned to the US hosts, so a non-US host needs a matching CSP change. Defaulted in code when unset. |
| `SUPABASE_SERVICE_ROLE_KEY` (GoTrue Admin API) | ✅ on **API Worker only** (CI-pushed) | ✅ on **API Worker only** (CI-pushed) | ✅ as the un-suffixed `SUPABASE_SERVICE_ROLE_KEY` — a **single shared key**, one value for every env (ADR 0017); demo pushes the same secret | AECI-530 / ADR 0016 §6. Runtime key for the **split-identity seams** — the register is `AUTH_AND_RLS.md` §3.1: `auth.users` email reads (#2), GDPR erasure of the `auth.users` row (#3), and vendor-claimant lookup + provisioning (#4a/#4b). Read in exactly **one** module, `apps/api/src/lib/supabase-admin.ts` (the single-module invariant). CI-pushed to the API Worker by `deploy.yml` (staging), `promote-to-demo.yml` (demo), `promote-to-prod.yml` (production). **Optional + fail-open on every env (prod included) — warn-and-skip,** so it is **never** in `REQUIRED_WORKER_SECRETS`; absent → reviewer emails read `null`, the erasure `auth.users` delete is silently **skipped** (GDPR — the D1 erasure still commits, the auth row survives), and vendor-claim resolution reports `unavailable` (claim approval 503s). **Never on the web Worker** (it verifies user JWTs with public JWKS material — `apps/web/src/supabase-bootstrap-inject.spec.ts` is the standing regression guard), and **deliberately never on per-PR previews** (see `pr-preview.yml`). **Not involved in sign-in** — auth uses `SUPABASE_URL` + the anon key (rows above). ⚠️ **Accepted risk:** this is the *project-wide* auth key and under ADR 0017 one project backs every env including production, so holding it allows enumerating every user, minting a session for any address (including `admin`), and deleting identities. GoTrue offers **no scoped admin credential**, so narrowing is unavailable; the levers are the ones above plus rotation (`CICD_PLAN.md` §7.4). One consequence to know: a `DELETE /api/account` on **staging or demo** now really deletes the shared `auth.users` row that also backs production. The `integration-db-tests` job is unrelated — it mints its own key from a local `supabase start` stack (`supabase status -o env`), never this secret. |

#### Declared-but-unset knobs (the "seam" vars)

Two API-Worker vars are **deliberately shipped unset on every tier**. They are not
secrets and not GH-managed; they exist so a policy can be turned on later without
a code change, and their absence *is* the current policy. Set either with a plain
`wrangler` `var` (or a `--var` on deploy) only when you actually want the
behaviour.

| Var | Tiers | Unset behaviour (today, everywhere) | Set behaviour |
| --- | --- | --- | --- |
| `PAGE_VIEWS_MIN_BOT_SCORE` | API Worker | Every page view is captured. Inert in practice anyway — CF **Pro** exposes no bot score, so `cf_bot_score` is null on every row. | Drops captured views below the integer floor (`STAGE_1_SPEC.md` §14.2 sampling policy, deferred until launch traffic is visible). |
| `ANALYTICS_INTERNAL_ASNS` | API Worker | The admin panel's internal-traffic filter is **unavailable**: every figure is reported unfiltered, `excluding_internal` is null, and the UI hides the toggle. | The panel additionally reports each traffic figure with those ASNs excluded — **alongside** the unfiltered number, never instead of it. |

`ANALYTICS_INTERNAL_ASNS` (AECI-574 / `ADMIN_PANEL_SPEC.md` §13 **D10**) is a
comma/semicolon/whitespace-separated ASN list, `AS` prefix optional —
`ANALYTICS_INTERNAL_ASNS="AS23700, 4134"`. Its purpose is the operator's own ISP:
on 2026-08-10, 67 of the digest's 92 "human" page views came from AS23700
(Jakarta). Three constraints are binding and a review checks all three:

1. **Query-time only.** It is a `WHERE` clause at read time
   (`apps/api/src/lib/internal-asns.ts`). It never touches `is_bot`, never runs at
   ingest, and never enters `scripts/ops/backfill-page-view-bots.sql`. That is
   what distinguishes it from `DATACENTER_ASNS`, which writes a permanent
   classification and therefore carries a much stricter membership doctrine. Keep
   them separate; do not merge the lists.
2. **Show both numbers, never substitute.** On the aggregate endpoints that is
   `AdminCount.total` (always unfiltered) plus `excluding_internal`. On the §5.2
   Activity feed (AECI-577), which returns *rows*, the toggle filters the row list
   while `window_total` / `window_visitors` are computed **both ways regardless of
   the toggle** — otherwise switching it on would leave a smaller number with
   nothing to compare it against, which is the substitution this constraint
   forbids. `/admin/activity` therefore reads "1,204 views · 312 excluding
   internal traffic" whether the toggle is on or off.
3. **Ship it unset. Do not hardcode an ASN.** With the var absent the toggle is
   not rendered at all on `/admin/activity` — a permanently-disabled control is
   worse than no control. Prefer the precise instruments
   first — AECI-575 (exclude `/admin/*` from `PageViewTracker`) and AECI-585
   (`cf_as_organization` at ingest, so the filter can label itself). Both have
   shipped; the holder name is captured from AECI-585's production deploy forward
   and is null on every earlier row.

Because it is a plain `var`, `scripts/require-secrets.sh` and
`verify-worker-secrets.sh` do not check it, and its absence never fails a deploy.

All Worker secrets are pushed per environment: `wrangler secret put REVIEW_APP_TOKEN --env staging` (and the same for `--env production`).

> **`REVIEW_APP_TOKEN` is pushed automatically by CI.** `deploy.yml` (`deploy-staging`) re-pushes it to the staging API Worker from `REVIEW_APP_TOKEN`; `promote-to-prod.yml` (`deploy-prod-workers`) does the same to the prod API Worker. Idempotent, right after the API Worker deploys. The manual `wrangler secret put` is only needed to bootstrap a Worker *before* its first CI deploy (and as a fallback). The other Worker secrets in §6 are still pushed by hand. (`DATABASE_URL` is no longer pushed — the app DB is D1, ADR 0016 / AECI-253.)

### The required-secrets rule (CI fails closed)

**A deploy/promote will not proceed to an environment that is missing a secret it needs.** Three gates enforce it; the required vs. recommended split must stay in sync with the runtime contracts in `apps/api/src/env.ts` and `apps/web/src/env.ts`:

1. **Preflight** — `scripts/require-secrets.sh` runs *before* any deploy (staging: first step of `deploy-staging`; prod: `pre-promotion-checks`, **before** the approval gate and any D1 migration or deploy). It fails the run, listing every missing **required** GH Actions secret at once, so nothing is deployed and no DB is touched. **Recommended-but-optional** secrets only emit a `::warning::`.
2. **Push** — the required Worker runtime secrets (`REVIEW_APP_TOKEN`, plus the Algolia keys on prod) are pushed to the API Worker from those GH secrets (idempotent), each fail-loud if its source is empty. (`DATABASE_URL` is no longer pushed — the app DB is D1, ADR 0016 / AECI-253.)
3. **Postflight** — `scripts/verify-worker-secrets.sh` lists the live Worker's secrets (`wrangler secret list`) and asserts the required runtime names are actually present; `scripts/verify-health.sh` proves the DB is reachable. Both run after deploy and fail the release if the environment didn't end up with what it needs.

| Tier | Staging (`deploy.yml`) | Production (`promote-to-prod.yml`) | Effect if missing |
| --- | --- | --- | --- |
| **Required (fail)** | `REVIEW_APP_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | + `ALGOLIA_APP_ID`, `ALGOLIA_ADMIN_KEY`, `ALGOLIA_SEARCH_KEY` (the prod promote no longer requires `DIRECT_URL_PRODUCTION` / `SUPABASE_ACCESS_TOKEN` / R2 keys — it touches no Postgres, AECI-256) | Deploy/promote refused |
| **Recommended (warn)** | `ADMIN_PURGE_TOKEN`, `DATADOG_API_KEY`, `DD_APPLICATION_ID`, `DD_CLIENT_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY` | `ADMIN_PURGE_TOKEN`, `DATADOG_API_KEY`, `DD_APPLICATION_ID`, `DD_CLIENT_TOKEN`, `CF_ZONE_ID`, `SUPABASE_SERVICE_ROLE_KEY` | Degraded only (observability / WAF poll / the `AUTH_AND_RLS.md` §3.1 split-identity seams); deploy proceeds |

To make a recommended secret blocking, move its name from `RECOMMENDED_SECRETS` to `REQUIRED_SECRETS` in the relevant workflow's preflight step (and, if it's a Worker runtime secret, add a push step + the postflight `REQUIRED_WORKER_SECRETS` list).

> **Every name in `RECOMMENDED_SECRETS` / `REQUIRED_SECRETS` must ALSO be mapped in the preflight step's `env:` block.** `require-secrets.sh` checks the **value** of an environment variable, not the existence of a GitHub secret — a name that is listed but not mapped always reads empty and warns `not set` on every single run, even when the secret exists. `DD_APPLICATION_ID` / `DD_CLIENT_TOKEN` did exactly that from AECI-326 until 2026-08-12: they warned on every staging deploy and every demo/prod promote while being pushed to the web Workers successfully by the very same jobs. If you add a name to either list, add the `NAME: ${{ secrets.NAME }}` line with it.

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
| `SUPABASE_PROJECT_REF` — **orphaned** | Was the **legacy Postgres** project ref for the `public`-schema `supabase db push` gate (**not** the auth project — auth is the single shared `ktuhnlypztujpsseujzx`, ADR 0017). The Postgres-app-DB machinery was decommissioned (AECI-278): `deploy.yml`'s `db-migrate-dev` job was removed and `refresh-staging.yml` gutted, so nothing `supabase link --project-ref`s against it for the app DB anymore. | No live consumer for the app DB. |

## Manual prerequisites — Chris's checklist before `STAGING_ENABLED=true`

The following must be done by hand (Supabase and Cloudflare dashboards + `gh secret set` + `wrangler secret put`) before the `deploy-staging` job in `.github/workflows/deploy.yml` will succeed.

### 1. Supabase projects

> **Auth (ADR 0017).** Authentication for **every** environment runs on a single
> shared project, `ktuhnlypztujpsseujzx`. Provision it on a **paid tier** (Free
> pauses + caps MAU), configure its redirect-URL allow-list + Site URL (see
> "Deployed Supabase Auth: redirect-URL configuration" above), wire Resend custom
> SMTP (`docs/email.md`) and Google OAuth, then point `SUPABASE_URL` (both
> `wrangler.jsonc`s, already flipped) at it and set the single un-suffixed
> `SUPABASE_ANON_KEY` GH secret (one value, every env — `deploy.yml` /
> `promote-to-prod.yml` / `promote-to-demo.yml` / `pr-preview.yml` all push it)
> + the un-suffixed `SUPABASE_SERVICE_ROLE_KEY` (also one value for every env — CI
> pushes it to the **API Worker** on staging/demo/production, never the web Worker
> and never per-PR previews; AECI-530). Per-environment isolation is Cloudflare
> Access (`docs/access.md`), not project separation. The two projects below are
> the **legacy Postgres** gate (app data is on D1 — ADR 0016), retained only until
> AECI-256/257 decommission it; they no longer serve auth.

The legacy Postgres production project existed before the AECI Stage 1 migration
system did — it holds the live landing-page `feedback` and `mailing_list` tables
written by `apps/landing/` via PostgREST (see `20260101000000_landing_baseline.sql`).
So the dual-environment Postgres split is built around keeping that DB *as
production* and provisioning a fresh empty project for development:

- [x] **Rename** the existing Supabase project to `aeci-production` (Supabase Dashboard → Project Settings → General → Project name). Project ref `jgxebjufabtwkcgxjqvk` stays the same. This is the prod URL the landing Worker already points at.
- [x] **Provision a new empty project** named `aeci-development` in the same Supabase org. Region: match the prod project (lowest latency to Workers).
- [ ] **Reconcile prod migration history.** Prod's `supabase_migrations.schema_migrations` table has one stray row (`20260525060654`) from a manual repair attempt and is missing every AECI baseline. Before pushing, clear the stray row and record the landing baseline as already-applied (the tables exist; the SQL must not re-run):
  ```bash
  supabase link --project-ref jgxebjufabtwkcgxjqvk        # aeci-production
  npx supabase migration repair --linked --status reverted 20260525060654
  npx supabase migration repair --linked --status applied  20260101000000
  pnpm db:push   # applies the six AECI baselines on top of feedback/mailing_list
  ```
- [ ] **Bootstrap the dev project schema** (it's empty, so this is a clean push of all eight migrations — seven AECi baselines plus the landing baseline; AECI-67 `capture_rls_auto_enable` and AECI-69 `drop_profiles_auth_fk_add_delete_trigger` landed after this section was first written):
  ```bash
  supabase link --project-ref <dev-ref>
  pnpm db:push
  ```
  Then `supabase link --project-ref <dev-ref>` is the day-to-day default (the CLI link should sit pointed at dev unless explicitly flipped for a prod operation).
- [ ] Verify both projects show all eight migrations in `pnpm db:list`. Dev should show all eight matched on both columns; prod should show the same once the steps above run successfully.

### 2. Cloudflare DNS

- [ ] Confirm `aecintegrations.com` is on Cloudflare with the AEC account and a Pro plan.
- [ ] Add a custom hostname for `staging.aecintegrations.com` pointing at the Workers zone (Cloudflare Dashboard → Workers & Pages → `aeci-web-staging` → Settings → Triggers → Custom Domains → Add). Wrangler will reconcile the route on first deploy.
- [ ] `demo.aecintegrations.com` and `prod.aecintegrations.com` need **no manual zone edits** — `custom_domain: true` in each web env block makes wrangler provision the DNS record + cert on deploy: `prod.` on the first prod deploy, `demo.` on the first demo deploy (the latter **reassigns** the hostname off the old production Worker, so deploy demo BEFORE re-deploying production). The apex (`aecintegrations.com`) + `www` are also `custom_domain: true` on `aeci-web-production` (AECI-247/277); their reassignment off the retired landing Worker is the apex-cutover DNS flip and executes on the next `promote-to-prod` after the cutover PR merges (`docs/launch-cutover-runbook.md`).

### 2a. Cloudflare Queues — Algolia jobs (ADR 0013)

The two daily Algolia jobs run as cron → enqueue → consume (ADR 0013). The four queues are created by an **idempotent `wrangler queues create` step in `deploy.yml` / `promote-to-prod.yml`** (before each API deploy), so no manual creation is normally needed — but two account/token prerequisites must be satisfied first or both that step and the Worker deploy (its `queues.consumers` binding) fail:

- [ ] **Workers Paid plan** is active on the AEC Cloudflare account (Cloudflare Queues require it).
- [ ] The CI **`CLOUDFLARE_API_TOKEN`** carries the **Queues edit** permission (Account → *Queues* → Edit), in addition to the Workers Scripts edit it already uses for `wrangler deploy`. Without it, `wrangler queues create` returns a permission error.
- [ ] (Optional, to pre-create by hand before the first deploy) from `apps/api`:
  ```bash
  for q in aeci-algolia-sync-staging aeci-algolia-drift-staging \
           aeci-algolia-sync-production aeci-algolia-drift-production; do
    pnpm exec wrangler queues create "$q"   # "already exists" is fine
  done
  ```

**Cross-Worker cache-purge queue (WC-5 / AECI-319 / ADR 0020 §3).** `aeci-cache-purge-{staging,demo,production}` is provisioned by the **same** idempotent `create_queue` step (in `deploy.yml` / `promote-to-demo.yml` / `promote-to-prod.yml`, before the SSR deploy) and needs the same two prerequisites above. It differs from the ADR-0013 job queues in that its **producers** are the API Worker (`CACHE_PURGE_QUEUE`, enqueued on promote/moderation) **and** — since WC-7 (AECI-321) — the manual-deploy `apps/datatool` Worker (per-tier producer bindings `CACHE_PURGE_QUEUE_{STAGING,DEMO,PRODUCTION}`, enqueued after a copy/seed/reindex with `{ purgeEverything: true, source: 'datatool' }`), while its **consumer** is the **SSR Worker** (`apps/web/wrangler.jsonc` `queues.consumers`, which issues `ctx.cache.purge()`) — so the queue must exist before the SSR deploy, not only the API deploy (and before a datatool deploy). No queue on preview/local (the producers no-op gracefully). Retire it, like the job queues, only after removing all bindings.

### 2b. Promote Workflow + `PROMOTE_KV` (AECI-563 / ADR 0021)

`POST /api/promote` returns `202 { jobId }` and commits inside a Cloudflare **Workflow**, one per environment (`aeci-promote-{preview,staging,demo,production}`, binding `PROMOTE_WORKFLOW`, class `PromoteWorkflow`).

- [ ] **No provisioning step needed for the Workflow itself** — unlike Queues, `wrangler deploy` creates/updates it from the `workflows` block in `apps/api/wrangler.jsonc`. It does require the **Workers Paid plan** (already satisfied for Queues) and the CI `CLOUDFLARE_API_TOKEN`'s existing **Workers Scripts: Edit** permission.
- [x] **`PROMOTE_KV` — all four namespaces provisioned 2026-08-12** and their ids are in `apps/api/wrangler.jsonc`, in the base block **and in each of the four env blocks**. The per-env entries are load-bearing: wrangler **replaces** (does not merge) the top-level `kv_namespaces` for an env, so an env block without its own `PROMOTE_KV` entry simply has no such binding. (The temporary `env.stage2` block added later carries its own pair — §10.2. This checklist covers the four permanent tiers.) Two key spaces (see `apps/api/src/lib/promote-jobs.ts`): `promote:payload:{jobId}` (24h) stages a bundle too large for the 1 MiB Workflow event-params cap, and `promote:result:{jobId}` (90d) mirrors the committed ID map so it outlives the 30-day instance retention.

  | Namespace | Id |
  |---|---|
  | `aeci-api-promote-preview` | `30d6ca5b9f9e444ea97362e9757b21c3` |
  | `aeci-api-promote-staging` | `eee38f83e62f473d8d589e08b2a99c07` |
  | `aeci-api-promote-demo` | `bda4c6f152384073861d5ff218e0d7da` |
  | `aeci-api-promote-production` | `9f0ce48f3a6b46f98458907baec65bf3` |

  To recreate from scratch (KV ids must be literal in the config at deploy time, so this can never be a CI step), from `apps/api`:
  ```bash
  for e in preview staging demo production; do
    pnpm exec wrangler kv namespace create "aeci-api-promote-$e"
  done
  # then paste each id into the base block AND that env's block:
  #   { "binding": "PROMOTE_KV", "id": "<id>" }
  ```
  **Verify with `wrangler deploy --env <env> --dry-run`** and confirm `env.PROMOTE_KV` appears in the binding table for all four envs — the binding name must be `PROMOTE_KV` (what the code reads), not the namespace title.
- [ ] **If the binding is ever absent it degrades gracefully** rather than failing closed: normal promotes (every real bundle) work unchanged; an oversize bundle is rejected `413 PAYLOAD_TOO_LARGE`; and the IDs are fetchable only for the instance retention window rather than the 90-day tail.
- [ ] **CLI gotcha:** because the preview entries carry both `id` and `preview_id` (mirroring `TAXONOMY_KV`), `wrangler kv key …` against them needs an explicit `--preview false` (or `--preview`) or it errors with "has both an `id` and a `preview_id` configured".
- [x] **Release ordering (cleared 2026-08-13):** the hard cutover meant a review app on the old synchronous `200` contract would break on every promote. Ordering was respected — the review app's AECI-567 (async kick-off/poll/collect) merged 2026-08-12, and prod was promoted to the async API afterwards. Keep the rule in mind for any future promote-contract change: **the review app ships first, then `promote-to-prod`.**

Operating a stuck or failed job: `docs/RUNBOOKS.md` → "Promote job errored or stuck".

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
- [ ] (No `DATABASE_URL_STAGING` — the app DB is Cloudflare D1, ADR 0016; the Prisma Accelerate runtime path is retired, AECI-253.)
- [ ] (`DIRECT_URL_STAGING` / `SUPABASE_ACCESS_TOKEN` are **orphaned** — the Postgres `supabase db push` machinery was decommissioned in AECI-278 and nothing reads them any more; safe to delete from GH secrets.)
- [ ] `SUPABASE_ANON_KEY` — the **single shared** publishable/anon key for the auth project `ktuhnlypztujpsseujzx` (un-suffixed; the SAME value drives staging, demo, production, and per-PR previews — ADR 0017). It must belong to the project named in `SUPABASE_URL`; a leftover per-project key (`…_STAGING` / `…_PRODUCTION` from before the consolidation) is what surfaces as `Invalid API key` at sign-in. Recommended (warn-and-skip) until 5.5.
- [x] `SUPABASE_SERVICE_ROLE_KEY` — the **single shared** GoTrue Admin API key for the auth project `ktuhnlypztujpsseujzx` (un-suffixed; the SAME value drives staging, demo and production — ADR 0017). *Optional* — recommended/warn-and-skip, never required for a deploy — but it **is** CI-consumed since AECI-530: `deploy.yml` / `promote-to-demo.yml` / `promote-to-prod.yml` push it to that tier's **API Worker**, where the `AUTH_AND_RLS.md` §3.1 split-identity seams read it. Not pushed to per-PR previews (deliberate) and never to a web Worker. Already set. See the service-role row in §Secrets for the accepted-risk note.

`DIRECT_URL_PRODUCTION` is now **orphaned** — `refresh-staging.yml` was gutted (no more `pg_dump`) and the prod promote touches no Postgres (AECI-278). The R2 snapshot keys are likewise orphaned. There is no `DATABASE_URL_PRODUCTION` — the app DB is D1 (ADR 0016 / AECI-253).

### 6. Cloudflare Worker secrets (`wrangler secret put <KEY> --env staging`)

Run from `apps/api` and `apps/web` respectively:

```bash
cd apps/api
# No DATABASE_URL / DIRECT_URL — the app DB is Cloudflare D1 (ADR 0016), reached
# via the `DB` binding; the Prisma Accelerate runtime path is retired (AECI-253)
# and Prisma is fully removed (AECI-278).
# The Supabase service-role key goes to the API Worker ONLY — never the web Worker
# (AUTH_AND_RLS.md §3.1) and never a per-PR preview. CI pushes it from the shared
# un-suffixed GH secret on every staging deploy / demo + prod promote (AECI-530), so
# the line below is only a bootstrap/fallback for a Worker that has not had a CI
# deploy yet:
# wrangler secret put SUPABASE_SERVICE_ROLE_KEY --env staging
wrangler secret put DD_API_KEY --env staging
# CF_ZONE_ID is CI-pushed (see the note below) — this is a bootstrap fallback only.
# The API Worker does NOT take ADMIN_PURGE_TOKEN: that bearer gates the SSR Worker's
# own /admin/purge, which purges in-process (WC-6). There is no CF_PURGE_API_TOKEN
# anywhere — WC-10 retired it.
wrangler secret put CF_ZONE_ID --env staging              # WAF poll zone (AECI-262)
wrangler secret put CF_ANALYTICS_API_TOKEN --env staging  # WAF poll token (AECI-262)
# …plus any others the Worker reads at runtime
```

```bash
cd apps/web
wrangler secret put DD_API_KEY --env staging
# DD_APPLICATION_ID / DD_CLIENT_TOKEN / ADMIN_PURGE_TOKEN / CF_PURGE_API_TOKEN /
# CF_ZONE_ID are all CI-pushed (see the note below) — bootstrap fallbacks only.
wrangler secret put DD_APPLICATION_ID --env staging
wrangler secret put DD_CLIENT_TOKEN --env staging
wrangler secret put ADMIN_PURGE_TOKEN --env staging
wrangler secret put CF_PURGE_API_TOKEN --env staging
wrangler secret put CF_ZONE_ID --env staging
# …
```

> **Most of this list is now CI-pushed and only needs the GH secret.** Every deploy/promote
> (`deploy.yml`, `promote-to-demo.yml`, `promote-to-prod.yml`) idempotently pushes
> `REVIEW_APP_TOKEN`, the Algolia keys, `SUPABASE_ANON_KEY`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`,
> `POSTHOG_KEY`, `DD_APPLICATION_ID`/`DD_CLIENT_TOKEN`, `CF_ANALYTICS_API_TOKEN`, and — since
> **2026-08-12** — the cache-purge trio (`ADMIN_PURGE_TOKEN` on web; `CF_PURGE_API_TOKEN` +
> `CF_ZONE_ID` on both Workers). Set the GH secret and the next deploy wires the Worker. The manual
> `wrangler secret put` matters only to bootstrap a Worker before its first CI deploy, or to
> unblock without waiting for one.

### 6b. Algolia indexes + keys (AECI-134)

One-time per env. Provisions the `staging_*` indexes and mints the scoped keys, then sets the secrets. The app-wide **root** admin key stays in your shell only — never `wrangler secret put` it. Full reference: `scripts/algolia/README.md` and CICD_PLAN §7.5.

```bash
# Run once for staging (also run --env preview so PR/local search has indexes).
export ALGOLIA_APP_ID=…
export ALGOLIA_ADMIN_KEY=<root admin key>   # operator-held; NOT pushed to a Worker
node scripts/algolia/provision.mjs --env staging   # prints the keys + the commands below
```

- [ ] `gh secret set ALGOLIA_APP_ID` (shared — set once across all envs).
- [ ] `gh secret set ALGOLIA_SEARCH_KEY` and `ALGOLIA_ADMIN_KEY` (the printed search + management keys) — **single shared** secrets, one value for every env (no `_STAGING`/`_PRODUCTION`/`_PREVIEW`/`_DEMO` suffix). The shared search key must cover every env's indexes it serves.
- [ ] Web Worker `ALGOLIA_APP_ID` + `ALGOLIA_SEARCH_KEY`: **CI-pushed** by `deploy.yml` (staging) / `promote-to-prod.yml` (production) / `promote-to-demo.yml` (demo) from the shared `ALGOLIA_APP_ID` + `ALGOLIA_SEARCH_KEY` GH secrets above — set those and the next deploy/promote wires the web Worker (no manual `wrangler secret put` needed in steady state). To unblock _before_ the next deploy, push manually: `cd apps/web && wrangler secret put ALGOLIA_APP_ID --env staging` + `wrangler secret put ALGOLIA_SEARCH_KEY --env staging`. **Never the admin key on web.**
- [ ] API Worker: `cd apps/api && wrangler secret put ALGOLIA_APP_ID --env staging` + `wrangler secret put ALGOLIA_ADMIN_KEY --env staging`.
- [ ] Also run `node scripts/algolia/provision.mjs --env preview` and push its keys to the shared `aeci-api-preview` Worker (no GitHub secret — pr-preview.yml is untouched until 3.9).

#### 6c. PostHog product analytics (AECI-239 / Phase 7.4)

- [ ] In PostHog (US Cloud), create the project and copy its **project API key**.
- [ ] `gh secret set POSTHOG_KEY_STAGING --body "<project api key>"` — CI-pushes to the staging web Worker (`deploy.yml`) and to every PR-preview web Worker (`pr-preview.yml`, which reuses `_STAGING`). Until set, analytics no-ops (fail-open, warn-and-skip).
- [ ] To unblock _before_ the next deploy, push manually: `cd apps/web && wrangler secret put POSTHOG_KEY --env staging`. **Never on the API Worker.** `POSTHOG_HOST` is a public `var` in `wrangler.jsonc` (US Cloud) — no secret needed.

#### 6d. BrowserStack cross-browser smoke (AECI-154 / Phase 7.8)

Optional, non-blocking. The `.github/workflows/browserstack.yml` lane runs the curated Playwright smoke subset on real iOS Safari + real Android Chrome + desktop Safari/Firefox/Edge against deployed staging (reusing the existing `CF_ACCESS_*` service-token secrets — no new CF Access work). It is **inert and skips green** until these personal-subscription secrets are set:

- [ ] `gh secret set BROWSERSTACK_USERNAME --body "<username>"`
- [ ] `gh secret set BROWSERSTACK_ACCESS_KEY --body "<access key>"`

The subscription must include the **Automate** product (real iOS Safari Playwright is Automate-only) with a parallel-session quota ≥ the 5-platform matrix in `apps/web/browserstack.yml`. No Worker secret is involved — this is a CI-only lane that never gates merge.

### 7. Flip the gate

- [ ] `gh variable set SUPABASE_PROJECT_REF --body "<legacy-postgres-ref>"` (consumed by `deploy.yml` db-migrate-dev + `refresh-staging.yml` — AECI-77; the single legacy-Postgres gate ref shared with `promote-to-prod.yml`).
- [ ] `gh variable set STAGING_ENABLED --body "true"` (or set in the UI).

The next push to `main` will trigger `deploy-staging`. The smoke test (`scripts/verify-version.sh`) will assert that **both** `staging.aecintegrations.com/api/version` (API Worker) and `/_version` (SSR Worker, AECI-92) report `sha: <merge commit>`.

### 8. Production bootstrap — Chris's checklist for `promote-to-prod.yml` (AECI-78)

These steps must land before the first successful `promote-to-prod.yml` run. None of them are reversible from CI — they create infrastructure outside the repo.

- [ ] ~~**R2 snapshot bucket / lifecycle / access keys.**~~ **Retired (AECI-256).** The prod promote no longer `pg_dump`s prod to R2 — the app DB is Cloudflare D1 with 30-day time-travel for rollback. The `aeci-prod-snapshots` bucket and the `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT` GH secrets are no longer required by any workflow; delete them once any retained dumps age out.
- [ ] **`DIRECT_URL_PRODUCTION` — orphaned (AECI-278).** The prod promote touches no Postgres, and `refresh-staging.yml` was gutted (no more `pg_dump`), so no workflow consumes it. Skip it. (The service-role key is a separate concern — since AECI-530 CI pushes the shared un-suffixed `SUPABASE_SERVICE_ROLE_KEY` to the **API Worker** on staging/demo/production; see the service-role row in §Secrets.)
- [ ] **Datadog deploy-marker secret.** `gh secret set DATADOG_API_KEY --body "<key>"` (already exists for Worker runtime intake; CI needs its own copy to POST to `/api/v1/events`).
- [ ] **Production Worker secrets.** Run the same `wrangler secret put …` list from §6 against `--env production` from `apps/api/` and `apps/web/`. There is **no** `DATABASE_URL` / `DIRECT_URL` to push — the app DB is Cloudflare D1 (ADR 0016), reached via the `DB` binding (Prisma fully removed, AECI-278). `REVIEW_APP_TOKEN` is pushed automatically by `promote-to-prod.yml` on every promote (the manual put is a bootstrap fallback), as are `DD_APPLICATION_ID`/`DD_CLIENT_TOKEN` and — since 2026-08-12 — `ADMIN_PURGE_TOKEN` (web Worker) + `CF_ZONE_ID` (API Worker; `CF_PURGE_API_TOKEN` was retired in WC-10). Set the GH secret; the promote wires the Worker. (`RESEND_API_KEY` is **not** manual — `promote-to-prod.yml` pushes it from the shared, un-suffixed `RESEND_API_KEY` GH secret, graceful; AECI-240.) (The service-role key is **not** manual either — since AECI-530 `promote-to-prod.yml` pushes the shared un-suffixed `SUPABASE_SERVICE_ROLE_KEY` to the **API Worker** (never the web Worker); see the service-role row in §Secrets.)
- [ ] **Algolia production indexes + keys (AECI-134).** With the root creds exported (as in §6b), `node scripts/algolia/provision.mjs --env production`. Then:
  ```bash
  gh secret set ALGOLIA_SEARCH_KEY --body "<printed search key>"   # single shared key (covers production_* + the other envs' indexes)
  gh secret set ALGOLIA_ADMIN_KEY  --body "<printed management key>"  # single shared key, all envs
  # ALGOLIA_APP_ID is shared — already set in §6b.
  cd apps/web && wrangler secret put ALGOLIA_APP_ID --env production && wrangler secret put ALGOLIA_SEARCH_KEY --env production   # never the admin key on web
  cd ../api  && wrangler secret put ALGOLIA_APP_ID --env production && wrangler secret put ALGOLIA_ADMIN_KEY  --env production
  ```
- [ ] **PostHog production key (AECI-239).** `gh secret set POSTHOG_KEY_PRODUCTION --body "<prod project api key>"` — `promote-to-prod.yml` CI-pushes it to the prod web Worker (warn-and-skip; analytics no-ops if unset). `POSTHOG_HOST` is a public `var` (US Cloud). To unblock manually: `cd apps/web && wrangler secret put POSTHOG_KEY --env production`. **Never on the API Worker.**
- [ ] ~~**Project ref repo variable** (`SUPABASE_PROJECT_REF`).~~ **Orphaned (AECI-278).** The Postgres `supabase db push` gate was decommissioned — `deploy.yml`'s `db-migrate-dev` job was removed and `refresh-staging.yml` gutted — so no workflow links against this variable for the app DB. Nothing to set.
- [ ] **Verify GH Environment.** The `production` GH Environment (created in §4) must list `chrisw@thewbsproject.com` as a required reviewer. Without that, the workflow's `deploy-prod-workers` job will not pause for approval.

Once all boxes are ticked, dry-run the workflow with a deliberately wrong `commit_sha` to verify the negative path: `pre-promotion-checks` must fail with `demo is not at <input> on both Workers (API + SSR), refusing to promote` and the run must stop before the `deploy-prod-workers` job.

### 9. Demo tier bootstrap — Chris's checklist for `promote-to-demo.yml`

The demo tier (`demo.aecintegrations.com`) is the public showcase, inserted between staging and production. It SHARES the prod Supabase project (so no new Supabase setup) but needs its own Cloudflare data-plane resources + a few GH secrets. Wrangler binds D1/KV by id, so the new ids must be pasted into `apps/api/wrangler.jsonc`'s `env.demo` block (placeholders ship as all-zeros).

- [ ] **Provision demo Cloudflare resources** and paste the printed ids into `apps/api/wrangler.jsonc` (`env.demo`):
  ```bash
  cd apps/api
  pnpm exec wrangler d1 create aeci-app-demo                 # → database_id
  pnpm exec wrangler kv namespace create aeci-api-taxonomy-demo  # → id
  for q in aeci-algolia-sync-demo aeci-algolia-drift-demo aeci-stats-demo \
           aeci-reconcile-demo aeci-data-quality-demo; do
    pnpm exec wrangler queues create "$q"                    # "already exists" is fine
  done
  ```
  (The queues are also created idempotently by `promote-to-demo.yml`; pre-creating is optional.)
- [ ] **Provision the demo Algolia index set + the one net-new key:**
  ```bash
  ALGOLIA_APP_ID=… ALGOLIA_ADMIN_KEY=<root admin key> \
    node scripts/algolia/provision.mjs --env demo           # creates demo_* indexes + prints a demo search key
  ```
  `ALGOLIA_APP_ID`, `ALGOLIA_ADMIN_KEY` **and `ALGOLIA_SEARCH_KEY` are all single shared** secrets now — one Algolia app spans all envs and the admin key reaches every index (`--env` is only an index-name prefix, NOT a per-env key scope). Demo therefore adds **no net-new Algolia GH secret**: it reads the same shared `ALGOLIA_SEARCH_KEY` as staging/production. ⚠️ Because the search key is shared, it must be scoped to cover `demo_*` (and every other env's indexes) — the old per-`demo_*` `ALGOLIA_SEARCH_KEY_DEMO` isolation no longer applies. Every other demo secret reuses the shared `*_PRODUCTION` values (demo shares the prod Supabase project + zone).
- [ ] **GitHub Environment.** Create a `demo` GH Environment (Settings → Environments) — already done. `promote-to-demo.yml`'s deploy job targets it; leave reviewers empty for an unattended promote, or add a required reviewer to gate it.
- [ ] **DNS — nothing to do.** `custom_domain: true` makes wrangler create `prod.aecintegrations.com` on the first prod deploy and `demo.aecintegrations.com` on the first demo deploy (the latter reassigns the hostname off the old production Worker). No manual zone edits.
- [ ] **Cutover order (avoids any `demo.` downtime).** Run **promote-to-demo first** — `aeci-web-demo` claims `demo.aecintegrations.com` (reassigning it off the old production Worker) — then seed `aeci-app-demo` (clone via `apps/datatool`, or re-promote the catalog + `scripts/seed-reviews`). **Then** run **promote-to-prod** — `aeci-web-production` picks up `prod.aecintegrations.com` and keeps serving the existing production data.

> **Apex cutover — wired in config (AECI-247/277); executes at launch.** The web/api wrangler configs now carry the cutover: `aecintegrations.com` + `www` are `custom_domain: true` on `aeci-web-production` (reassigned off the retired landing Worker on the next `promote-to-prod`), the production web Worker's `ALLOW_INDEXING="true"`, and the API Worker's `PUBLIC_SITE_URL` is the apex. The remaining launch-day steps are **ops, not code**: provision the launch-only SEO secrets so the post-promote search-engine pings fire — `gh secret set INDEXNOW_KEY_PRODUCTION` (AECI-236) and `gh secret set GOOGLE_INDEXING_SA_EMAIL_PRODUCTION` + `GOOGLE_INDEXING_SA_PRIVATE_KEY_PRODUCTION` (AECI-263, the service-account `client_email` + PKCS#8 `private_key`); `promote-to-prod.yml` pushes them to the prod API Worker (recommended/warn-and-skip — both remain graceful no-ops until set) — then run the ordered ceremony in `docs/launch-cutover-runbook.md` (verify on `prod.`, promote, confirm the apex serves the app, send the Resend broadcast).

### 10. `stage2` temporary tier — bootstrap, operate, tear down (AECI-637)

A **throwaway** tier for end-to-end testing of the completed Stage 2 build (vendor portal, attestations, paid tiers, real-time) on `stage2.aecintegrations.com`. Modelled on §9's demo bootstrap, with temp-env trims. **Read §10.6 before you start — two of these steps can damage production if run carelessly.**

Unlike every other tier, this one is **deployed by hand from a `stage-2` SHA**. There is no workflow, no GH Environment, and no GH secret that names it — `stage-2` never reaches staging, so the usual "verify one tier up" gate has nothing to check.

> **As-built status — 2026-08-20.** LIVE at `82f26ba1` and **Access-gated**. D1 `aeci-app-stage2` (`d6960a3f-…`, region APAC) migrated to `0019` and seeded; both KV namespaces provisioned; both Workers deployed and reporting the SHA on `/api/version` + `/_version`, `/api/health` `db:ok`. Seeded content verified rendering: pair-page agreement states (`confirmed` / `single_source` / `unverified`), the vendor verified badge, and the version-diff selectors.
>
> **Access verified 2026-08-20.** A bare request to `/`, `/api/version` and `/_version` all `302` to `aecintegrations.cloudflareaccess.com/cdn-cgi/access/login/stage2.aecintegrations.com`, and the redirect's `kid` is `6d89b808…d98643` — byte-equal to the **App AUD tag** in `docs/access.md` §1, which confirms the hostname was added as a destination on the existing `AECi Non-Prod` app rather than a new one (the §"Locked decisions" requirement). `staging.aecintegrations.com` still `302`s with the same AUD, so nothing regressed on the shared app.
>
> **Verification now needs the service token.** §10.8's `verify-version.sh` / `verify-health.sh` recipe worked pre-gate without headers; it will `302` now. Export `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` (the `aeci-gh-actions` token, `docs/access.md` §1) first, or reach it in a browser via email-OTP. Nothing automated hits this host — there is no workflow for this tier — so the service token is a convenience for manual checks, not a functional dependency.
>
> Still pending: the Supabase redirect-URL entry (§10.3), without which magic-link sign-in bounces to the project Site URL. No Algolia by decision (§10.4).

#### 10.1 What's in the repo already

Committed to `stage-2` (the AECI-637 PR):

- `env.stage2` blocks in `apps/{api,web}/wrangler.jsonc` — mirroring `env.demo` minus `triggers`, `queues`, and (web) `exports`, plus `custom_domain: true` on `stage2.aecintegrations.com`. **`workflows` is kept** (`aeci-promote-stage2`): Workflows are created by `wrangler deploy` with no provisioning step, and `POST /api/promote` returns 503 without the binding, which would kill the re-promote seeding path.
- `stage2` added to the `ENV` unions (`apps/{api,web}/src/env.ts`) and to the three unions that must stay supersets of them or the build breaks: `DatadogEnv.ENV` (`packages/shared/src/datadog.ts`) and `AlgoliaEnv` / `AlgoliaIndexPrefix` (`packages/shared/src/algolia.ts`). The Algolia pair is a **compile** requirement only — this tier has no indexes (§10.4). The Algolia operator scripts are deliberately **not** touched.
- `pnpm --filter @aeci/{api,web} deploy:stage2` and `pnpm --filter @aeci/api db:seed:stage2`.

`isPublicSite()` deliberately does **not** include `stage2` — it is Access-gated, so `/preview/*` stays reachable and per-request response validation stays on, which is what you want on a test tier.

#### 10.2 Provision (once)

Prereqs: Workers **Paid** plan, `CLOUDFLARE_API_TOKEN` with Workers + D1 + KV edit.

```bash
cd apps/api
pnpm exec wrangler d1 create aeci-app-stage2                    # → database_id
pnpm exec wrangler kv namespace create aeci-api-taxonomy-stage2 # → id  (optional)
pnpm exec wrangler kv namespace create aeci-api-promote-stage2  # → id  (optional)
```

Paste the three ids over the all-zero placeholders in `apps/api/wrangler.jsonc` `env.stage2` and commit. Both KV namespaces are genuinely optional — `routes/taxonomy.ts` falls back to a direct D1 read, and `PROMOTE_KV` only matters for an oversize promote bundle plus the 90-day result mirror — but the bindings must either carry a real id or be deleted from the block; an all-zero id is not a valid namespace.

**No queues.** `stage2` has no crons, so nothing produces onto the five scheduled-job queues, and the SSR Worker is uncached so `CACHE_PURGE_QUEUE` has nothing to invalidate. Both producer bindings are optional in `apps/api/src/env.ts` and no-op when unbound.

#### 10.3 Access, DNS, and the Supabase redirect allow-list

- **DNS — nothing to do.** `custom_domain: true` provisions `stage2.aecintegrations.com` + its cert on the first SSR deploy. This is a **new** hostname, so nothing is reassigned off another Worker (unlike the demo and apex cutovers), and the record is removed when the Worker is deleted.
- **Access.** Add `stage2.aecintegrations.com` as a destination on the existing `AECi Non-Prod` app — same allowlist and same `aeci-gh-actions` service-token policy. See `docs/access.md` §1. Do **not** create a second Access app (§"Locked decisions").
- **Supabase.** Add `https://stage2.aecintegrations.com/**` to the shared auth project's redirect-URL allow-list (dashboard → Authentication → URL Configuration). Without it, magic-link and OAuth callbacks silently fall back to the project Site URL and you land on the wrong host.

#### 10.4 Algolia — out of scope. This tier has NO search.

**Decided 2026-08-20: `stage2` ships without Algolia.** Search is not being tested on it, so there are no `stage2_*` indexes, no `ALGOLIA_*` secrets on either Worker, and no entry in either script's `VALID_ENVS` — `--env stage2` is rejected by `provision.mjs` / `apply-settings.mjs` on purpose. Nothing to provision here, and nothing to tear down in §10.9.

What that costs: `/search` renders the degraded shell (`ALGOLIA_APP_ID` / `ALGOLIA_SEARCH_KEY` absent → `algolia-bootstrap-inject.ts` no-ops). Everything the tier exists to exercise — vendor portal, attestations, paid tiers, real-time — is untouched. The one Stage 2 feature that reads Algolia is the AECI-529 verified badge on the search surfaces; verify that on a PR preview against `preview_*`.

`AlgoliaEnv` / `AlgoliaIndexPrefix` in `packages/shared/src/algolia.ts` **do** carry a `stage2` member, and that is a compile requirement rather than a claim that indexes exist: `algolia-drift-deps.ts` and `routes/promote.ts` assign the Worker's `ENV` straight into an `AlgoliaEnv` position, so the union must stay a superset of `Env['ENV']` or the API Worker does not build. Both paths are inert without credentials.

> **If search on `stage2` is ever wanted, it needs a quota decision first.** The shared Algolia app is **already over its index limit** — 24 live indexes against a 20 cap — so `provision.mjs` cannot create *any* new index. Verified 2026-08-20: `✗ Algolia setSettings failed: Too many indices (24>20)`. A stage2 set matching the other tiers is 7 more (3 primaries + 4 sort replicas). Raising the plan limit is the only unblock that degrades nothing — deleting the three `preview_*` indexes reaches only 21 and breaks PR previews plus the `lighthouse.yml` `/search` gate. Do **not** point `stage2` at another tier's index prefix to dodge it: this tier's promote→index hook would then write into indexes that tier reads. And whatever happens, do **not** overwrite the shared `ALGOLIA_SEARCH_KEY` GitHub secret with a per-env key — it is one value that staging, demo and production all read (§Secrets).

#### 10.5 Secrets

All by hand — no CI pushes to this tier.

```bash
cd apps/api   # API Worker
printf '%s' "$DD_API_KEY"        | pnpm exec wrangler secret put DD_API_KEY --env stage2        # optional
printf '%s' "$REVIEW_APP_TOKEN"  | pnpm exec wrangler secret put REVIEW_APP_TOKEN --env stage2  # only if re-seeding via promote
printf '%s' "$ANTHROPIC_API_KEY" | pnpm exec wrangler secret put ANTHROPIC_API_KEY --env stage2 # optional

cd ../web     # SSR Worker
printf '%s' "$SUPABASE_ANON_KEY" | pnpm exec wrangler secret put SUPABASE_ANON_KEY --env stage2
printf '%s' "$DD_APPLICATION_ID" | pnpm exec wrangler secret put DD_APPLICATION_ID --env stage2 # optional
printf '%s' "$DD_CLIENT_TOKEN"   | pnpm exec wrangler secret put DD_CLIENT_TOKEN --env stage2   # optional
printf '%s' "$ADMIN_PURGE_TOKEN" | pnpm exec wrangler secret put ADMIN_PURGE_TOKEN --env stage2 # optional (uncached tier)
```

`SUPABASE_ANON_KEY` is the only one that gates a headline feature: without it every SSR auth surface returns `503 auth_not_configured`, so sign-in — and therefore the whole vendor portal — is untestable. Everything else above is fail-open.

**No `ALGOLIA_*` secrets** — this tier has no search by decision (§10.4). Leaving them unset is what makes `/search` degrade cleanly instead of querying indexes that do not exist.

`CF_ZONE_ID` / `CF_ANALYTICS_API_TOKEN` are pointless here: they feed the hourly WAF poll, which is a cron, and this tier has none.

#### 10.6 Two secrets to leave OFF, and why

- **`SUPABASE_SERVICE_ROLE_KEY` — omit** unless you are specifically testing claim approval. Under ADR 0017 one auth project backs **every** tier including production, and this is the project-wide GoTrue Admin key: it can enumerate every real user, mint a session for any address, and delete identities. `DELETE /api/account` on this throwaway tier would delete the **real production** `auth.users` row. Without it the seams degrade exactly as documented in §Secrets — reviewer emails read `null`, claim approval 503s, and everything else works.
- **`RESEND_API_KEY` — omit** unless you are specifically testing email. It is a single shared key and sends real mail to real addresses; absent, every send is a fail-open `'skipped'`. (This tier runs no crons, so the nightly digests that would otherwise mail on their own cannot fire either — belt and braces.)

If you do provision either one, note it here with a date and remove it the moment that test is finished.

#### 10.7 Migrate, seed, deploy

```bash
# 1. Schema + reference data (taxonomy, data objects, trades). cwd MUST be apps/api.
cd apps/api
bash "$(git rev-parse --show-toplevel)/scripts/d1-apply-migrations.sh" aeci-app-stage2 stage2

# 2. Test data. The local/CI fixture set — catalog, the verified fixture vendor WITH its
#    matching vendor_entitlements row, the AECi claim + attestation, product versions,
#    and the admin + vendor_admin profiles.
pnpm db:seed:stage2

# 3. Deploy — API FIRST (the SSR services.API binding targets aeci-api-stage2), SSR second.
pnpm --filter @aeci/api  deploy:stage2
pnpm --filter @aeci/web  deploy:stage2      # runs the web build first
```

Both `deploy:stage2` scripts derive `COMMIT_SHA` from `git rev-parse HEAD` and `DEPLOYED_AT` from `date -u`, so run them from a checked-out `stage-2` SHA and the version endpoints report it without any extra flags.

`seed/catalog.sql` and `seed/phase2-fixtures.sql` carry a "dev / CI only — never staging/production" warning. Applying them to `stage2` is a **deliberate exception**: it is a throwaway tier that exists to be thrown away, and hand-writing equivalent SQL would be strictly worse. They give you, for free, the four things the Stage 2 surfaces need and a bare catalog does not:

| Fixture | What it unlocks |
| --- | --- |
| `phase2-fixtures.sql` vendor `…061` (`verified = 1`) **+** its `vendor_entitlements` row | The paid-tiers mirror is consistent, so the vendor plan panel renders a real active term. Seeding `verified = 1` **without** the entitlement row is the classic mistake — nothing fails until something reads the mirror. |
| `phase2-fixtures.sql` claim `…066` + `aeci` attestation `…067` | The pair page's "Layer B" and the vendor dashboard's Integrations tab have a real lane, on `unverified`, ready for a vendor affirm to move it to `single_source`. |
| `auth-fixtures.sql` profile `e1a8f812-…` (`vendor_admin`, `vendor_id` = `…061`) | `requireVendor()` authorizes the `/vendor` portal. Pair it with the `SUPABASE_VENDOR_TEST_USER_*` account. |
| `version-diff-fixtures.sql` | Product versions + version-stamped attestations, so the §9 version-diff selectors actually render. |

Three things the fixture set does **not** cover, all applied by hand on 2026-08-20:

- **Reviews.** `seed/*.sql` seeds none, so product review sections and the admin moderation queue render empty. `pnpm --filter @aeci/api db:seed-reviews -- --remote --env stage2 --apply` reads this tier's own catalog and writes a deterministic set (46 approved here). Every row carries the `aeceed00-…` id prefix, so `--teardown --apply` removes exactly those.
- **An operator profile.** The fixture profiles are the two e2e personas; **your own account has no row**, so signing in with it lands you as a role-less user — no `/admin`, no `/vendor`. Authorization is per-tier D1 (ADR 0016), so a profile here grants nothing anywhere else. Seed one with your Supabase `sub` as the PK:
  ```sql
  INSERT OR REPLACE INTO profiles (id, display_name, role, created_at, updated_at)
  VALUES ('<your auth.users.id>', '<name> (operator)', 'admin',
          strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  ```
  Find the id with a read-only GoTrue admin call — `GET {SUPABASE_URL}/auth/v1/admin/users?filter=<substring>`, which is a **case-sensitive substring** match over email OR full name, not an equality lookup.
- **Home stats.** `GET /api/stats/home` **never live-aggregates** — `stats_cache` is its only source (`routes/stats.ts`), and that table is written by the 07:00 cron, which this tier does not run. Left alone the home page reports `0` products / vendors / reviews over a fully populated catalog, which reads as broken. The six scalar keys were inserted directly using the cron's own definitions from `lib/home-stats.ts` (note `total_reviews` and `total_contributing_firms` count **approved only**, unlike products/vendors/integrations which are unfiltered). The three list keys and two card keys are deliberately left absent so they fall back to `[]` / `null` — with no `page_views` history there is no honest `trending_products` to show.

Alternatives, for the record: **`apps/datatool` cannot clone into this tier** without code changes — `apps/datatool/src/targets.ts` has a closed four-element `ENV_IDS` list and one D1 binding per tier — and adding a fifth to a Worker that can wipe prod D1 is not worth it for a temp env. Re-promoting from the review app works (`REVIEW_APP_TOKEN` + the `PROMOTE_WORKFLOW` binding are both wired) but needs the review app pointed at this host.

#### 10.8 Verify

```bash
export HOST=https://stage2.aecintegrations.com
export EXPECTED_SHA=$(git rev-parse HEAD)
export CF_ACCESS_CLIENT_ID=… CF_ACCESS_CLIENT_SECRET=…   # the aeci-gh-actions service token
bash scripts/verify-version.sh   # /api/version AND /_version both report the stage-2 SHA
bash scripts/verify-health.sh    # /api/health → db:ok

# Access gate, both directions:
curl -sI "$HOST/api/version"                                   # expect 302 → cloudflareaccess.com
curl -sI "$HOST/api/version" \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"       # expect 200
```

#### 10.9 Teardown

Run the whole list — a half-torn-down temp env is worse than none, because the config blocks keep implying a tier that no longer answers.

```bash
pnpm exec wrangler delete --name aeci-web-stage2 --force   # also drops the DNS record + cert
pnpm exec wrangler delete --name aeci-api-stage2 --force
pnpm exec wrangler d1 delete aeci-app-stage2
pnpm exec wrangler kv namespace delete --namespace-id <taxonomy-id>
pnpm exec wrangler kv namespace delete --namespace-id <promote-id>
```

Then, by hand:

- **Algolia: nothing to do** — this tier creates no indexes and no keys (§10.4).
- Remove the `stage2.aecintegrations.com` destination from the `AECi Non-Prod` Access app and the entry from `docs/access.md` §1.
- Remove `https://stage2.aecintegrations.com/**` from the Supabase redirect allow-list.
- **Revert the repo side in one commit:** both `env.stage2` blocks, the `stage2` entries in the two `ENV` unions + `DatadogEnv.ENV` + `AlgoliaEnv`/`AlgoliaIndexPrefix`, the three `package.json` scripts, this section, and the `stage2` rows in §Topology, `docs/access.md` §1 and `docs/CICD_PLAN.md` §2. Nothing under `scripts/algolia/` was changed, so nothing there needs reverting.

## What lives where

| File | Purpose |
| --- | --- |
| `apps/web/wrangler.jsonc` | SSR Worker — has `[env.preview]`, `[env.staging]`, `[env.demo]`, `[env.production]`. |
| `apps/api/wrangler.jsonc` | API Worker — has `[env.preview]`, `[env.staging]`, `[env.demo]`, `[env.production]`. `COMMIT_SHA` and `DEPLOYED_AT` declared with placeholder defaults per env; overridden at deploy via `--var`. |
| `.github/workflows/deploy.yml` | CI: lint, typecheck, unit, build, e2e local, integration local, then **`deploy-staging`** on push to `main` (gated by `vars.STAGING_ENABLED`). |
| `.github/workflows/refresh-staging.yml` | (AECI-77) one-button workflow to restore prod data into staging with credentials scrubbed. |
| `.github/workflows/promote-to-demo.yml` | One-button workflow to promote a staging commit to the public demo tier (`--env demo`). Light sibling of promote-to-prod — no Postgres (shared prod Supabase project). |
| `.github/workflows/promote-to-prod.yml` | (AECI-78) two-button workflow to promote a **demo** commit to production with manual approval. |
| `.github/workflows/pr-preview.yml` | (AECI-79) per-PR ephemeral preview lifecycle. |
| `.github/workflows/drift-check.yml` | (AECI-264) PR-time D1 schema-drift gate: `pnpm --filter @aeci/api db:generate` must leave `apps/api/migrations/` clean (`apps/api/src/db/schema.ts` ↔ committed migrations). |
| `scripts/scrub-auth-credentials.sql` | (AECI-77) nulls credentials on `auth.users`, deletes `auth.sessions`/`auth.refresh_tokens`. |
| `scripts/seed-staging-users.sql` | (AECI-77) idempotent test-account seed for staging. |
| `scripts/smoke-test.sh` | (AECI-77) pluggable-HOST `/api/health` smoke test with Access headers. |

(The former `scripts/prisma-drift-check.sh` Postgres drift gate, `scripts/apply-authorization.sql` / `scripts/verify-rls.sql` GRANT/RLS scripts, `scripts/seed-reference-data.sh` taxonomy seed, and the `scripts/seed-from-staging.sh` local-Postgres helper were all deleted with the Postgres-app-DB decommission — AECI-278; schema drift is now the D1/Drizzle `drift-check.yml`, and the taxonomy reference data is seeded into D1 from `apps/api/seed/taxonomy.sql`.)

Cross-references:
- [`docs/CICD_PLAN.md`](./CICD_PLAN.md) — the canonical CI/CD plan (this file is its operational companion).
- [`docs/access.md`](./access.md) — Cloudflare Access setup and service-token rotation.
- [`docs/migrations.md`](./migrations.md) — D1/Drizzle migration workflow (§0); the legacy Supabase-CLI body is auth-project-only history.
- [`CLAUDE.md`](../CLAUDE.md) — non-negotiable constraints (Drizzle over the D1 binding, `nodejs_compat` scope, `--var COMMIT_SHA` mandate, etc.).
