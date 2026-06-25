# Environments

> **Operator runbook.** Topology, promotion model, both manual buttons (`refresh-staging`, `promote-to-prod`), PR-preview lifecycle, PR-time drift gate, local seeding, secrets, and the one-time manual bootstrap checklist. If you only need to push a code change to staging or prod, the **Promote runbook** and **Refresh runbook** sections below are sufficient — everything above them is reference; everything below is reference + setup.
>
> Cross-references at the bottom point at companion docs that own narrower contracts (CI/CD plan, migrations, Prisma-as-query-builder, Cloudflare Access).

## Topology

AECi runs four tiers of environment plus local. Worker and Supabase project naming is rigid — workflows, smoke tests, and docs assume these exact names.

| Tier | Cloudflare Workers | Supabase Auth | Public URL | Access control |
| --- | --- | --- | --- | --- |
| **Local** | `wrangler dev` / `pnpm dev:bound` | Shared auth project (or local `supabase start`) | `http://localhost:8788` | None (loopback) |
| **PR preview** | `aeci-{api,web}-pr-<N>` (`*.aec-integrations.workers.dev`) | Shared auth project | `*.workers.dev` (PR-specific) | Cloudflare Access — service token for CI, OTP-to-email for humans |
| **Staging** | `aeci-{api,web}-staging` | Shared auth project | `https://staging.aecintegrations.com` | Cloudflare Access — same allowlist as previews |
| **Demo** | `aeci-{api,web}-demo` | Shared auth project | `https://demo.aecintegrations.com` | Public (showcase) |
| **Production** | `aeci-{api,web}-production` | Shared auth project | `https://prod.aecintegrations.com` | Cloudflare Access until launch (ADR 0017), then public |

> **Supabase is auth-only** (app data is on D1 — ADR 0016). Per **[ADR 0017](./adr/0017-single-supabase-auth-project-across-environments.md)** a single shared auth project (`ktuhnlypztujpsseujzx`) backs **every** tier; per-environment isolation is provided by Cloudflare Access, not project separation. (The retained legacy Supabase-Postgres `public`-schema gate still lives on the old `dmbygwupskttzsvfzluq` / `jgxebjufabtwkcgxjqvk` projects until AECI-256/257 retire it — that's what the `SUPABASE_*_PROJECT_REF` repo variables below point at, unrelated to auth.)

> Pre-launch, the **production** tier serves `prod.aecintegrations.com` (the eventual home page; Cloudflare Access-gated until launch per ADR 0017) and the **demo** tier serves `demo.aecintegrations.com` (the public showcase). Both are **no-index** (`ALLOW_INDEXING="false"`) until the apex cutover. The apex (`aecintegrations.com`) and `www.aecintegrations.com` remain served by the **landing** Worker (`apps/landing`) — we are not promoting the app to the apex yet.
>
> **All tiers share one Supabase auth project** (ADR 0017; auth-only — the app DB is Cloudflare D1 per ADR 0016), so one admin login works everywhere. Demo and Production still have **independent** D1, KV, Cloudflare Queues, and Algolia index sets: production keeps `aeci-app-production` / `aeci-*-production` / `production_*`; demo has its own `aeci-app-demo` / `aeci-*-demo` / `demo_*`. The `ENV` var (and therefore Algolia prefix + Datadog `env` tag) is `production` vs `demo`; the two are the audience-facing tiers recognised by `isPublicSite()` (`@aeci/shared/deploy-env`) — both block `/preview/*`, strip per-request response validation, and bound per-render Datadog log volume.

Worker `name` (deployed) values in `apps/{web,api}/wrangler.jsonc`:

| Worker | Preview env | Staging env | Demo env | Production env |
| --- | --- | --- | --- | --- |
| `apps/api` | `aeci-api-preview` | `aeci-api-staging` | `aeci-api-demo` | `aeci-api-production` |
| `apps/web` | `aeci-web` (`workers_dev: true`) | `aeci-web-staging` | `aeci-web-demo` | `aeci-web-production` |

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

## PR previews

Every PR against `main` gets a pair of ephemeral preview Workers — `aeci-api-pr-<N>` (private; bound to via service binding) and `aeci-web-pr-<N>` (public on the `*.aec-integrations.workers.dev` wildcard) — deployed by [`pr-preview.yml`](../.github/workflows/pr-preview.yml) on `pull_request` `opened` / `synchronize` / `reopened` and torn down on `closed`. First-party PRs only — fork PRs skip cleanly since they receive no secrets.

### DB strategy: Cloudflare D1 (ADR 0016)

Per-PR API Workers reach the app database through their `DB` D1 binding, inherited from the `env.preview` block in `apps/api/wrangler.jsonc` — no Prisma Accelerate, no `DATABASE_URL` secret. The Prisma Accelerate runtime path is retired (AECI-253), so the per-PR deploy no longer pushes `DATABASE_URL`. (Migrations are applied with `wrangler d1 migrations apply`.)

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

The [`refresh-staging.yml`](../.github/workflows/refresh-staging.yml) workflow (AECI-77) restores prod **public-schema** data into the dev project's `main` branch (= staging) and redeploys staging Workers. It's the "give me realistic data" button. Per [ADR 0017](./adr/0017-single-supabase-auth-project-across-environments.md) it **no longer touches the auth schema** — auth is one shared project across all environments, so staging auth is never sourced from prod and the test accounts are seeded into the shared auth project out of band (see "Test accounts" / `scripts/seed-staging-users.sql`). Trigger it from the GitHub Actions UI:

1. Repo → Actions → **refresh-staging** → **Run workflow** → branch `main` → **Run workflow**.
2. No inputs, no approval gate. The `staging-refresh` GH Environment is configured with no reviewers because the workflow is idempotent.
3. Concurrency group `refresh-staging` queues overlapping clicks rather than cancelling — a second press while the first is still running just waits, it does not stomp.

What happens, in order (each numbered step matches a job step in the workflow):

1. Checkout `main`.
2. Install pnpm, Node, PostgreSQL 17 client, Supabase CLI, generate Prisma client.
3. `pg_dump` prod (DIRECT_URL_PRODUCTION) into two artifacts: full public schema and `supabase_migrations.schema_migrations` history. (Auth is not dumped — ADR 0017.)
4. Wipe staging (`DROP SCHEMA public CASCADE`, truncate migration history). The auth schema is left untouched.
5. `pg_restore` the public dump + replay the migration-history into staging.
6. `supabase db push --linked --include-all` — applies any migration committed under `supabase/migrations/` that isn't yet in the migration-history table just restored from prod. This is the **only** moment staging schema can be ahead of prod schema.
7. Re-assert the PostgREST authorization surface + verify the RLS GRANT matrix (HARD STOP on a missing policy/GRANT).
8. Seed taxonomy reference data (idempotent upserts). _(The former auth credential-scrub + test-account seed steps were removed per ADR 0017 — auth lives in the shared project, seeded out of band.)_
9. **Drift check (HARD STOP).** `scripts/prisma-drift-check.sh $DIRECT_URL_STAGING`. If staging's actual schema doesn't match `apps/api/prisma/schema.prisma`, the workflow exits before deploying Workers. This is the spec's "do not let an inconsistent staging hide from operators" rule.
10. Deploy `aeci-api-staging` then `aeci-web-staging` via `wrangler-action`, passing `--var COMMIT_SHA:${{ github.sha }} --var DEPLOYED_AT:<shared timestamp>` per the CLAUDE.md non-negotiable.
11. **Reindex Algolia (AECI-229).** `pnpm --filter @aeci/api exec tsx scripts/algolia-bulk-sync.ts --env staging` upserts every promoted product/vendor/integration from the just-restored DB into the `staging_*` indexes, so staging search is fresh the moment the refresh finishes. Without it staging search stays stale: the daily 08:00 UTC sync cron can't self-heal the index, because step 5 restores prod's `stats_cache` — including the `algolia_sync_watermark` row — so the cron reads prod's recent fence and finds almost nothing to push. Runs on the Actions runner — direct `tsx` over `DIRECT_URL_STAGING` with the vanilla Prisma driver, **not** a Cloudflare Worker. Skips with a `::warning::` if the Algolia secrets (`ALGOLIA_APP_ID` / the shared `ALGOLIA_ADMIN_KEY`) aren't provisioned; a genuine sync failure hard-stops the refresh (post-deploy, so nothing rolls back).
12. Smoke test `https://staging.aecintegrations.com/api/health` with Cloudflare Access headers; then via `scripts/verify-version.sh` poll until **both** `/api/version` (API Worker) and `/_version` (SSR Worker, AECI-92) report the workflow's commit SHA (60-second budget). `/api/version` is proxied raw to the API Worker, so on its own it can't catch a stale SSR deploy.
13. Job summary table: migrations applied, commit SHA, actor, status. (Auth-user counts are no longer reported — this workflow doesn't touch auth; ADR 0017.)

**What to expect:** total runtime ~5-10 minutes. The drift check (step 9) is the most likely failure point — see "Common failure modes" below.

**When to press it:**
- Staging data has drifted from prod and you want fresh shape.
- Test users have accumulated cruft from manual review work.
- After landing a destructive migration on `main`, before pressing promote — refresh first to confirm the migration applies cleanly against prod-shaped data.

**Common failure modes:**

| Failure | Where | What it means / what to do |
| --- | --- | --- |
| `permission denied for schema public` during step 4/5 | Step 4 wipe or step 5 restore | `DIRECT_URL_STAGING` doesn't have owner-level access. The staging DB role used by the secret must own the public schema; the Supabase pooler URL with the `postgres` user does. |
| Drift check exits 1 | Step 9 | Staging schema diverges from `apps/api/prisma/schema.prisma`. Almost always means a migration was committed without re-pulling. Resolve by running `pnpm db:reset && pnpm db:pull` against the local DB used to author the migration, committing the regenerated schema, and re-deploying. Workflow hard-stops here on purpose — Workers don't deploy against a drifted DB. |
| `supabase db push --linked` says "no migrations to apply" but `pnpm db:list` shows pending | Step 6 | The migration-history table from prod is ahead of the committed `supabase/migrations/` files. Usually means an out-of-band manual migration was applied to prod. Resolve with `supabase migration repair`. |
| Algolia reindex fails | Step 11 | A genuine failure (Algolia API error, bad `ALGOLIA_ADMIN_KEY`, or `DIRECT_URL_STAGING` unreachable) hard-stops the refresh after the Workers already deployed — nothing rolls back. Re-run the button, or reindex by hand: `pnpm --filter @aeci/api db:algolia-bulk-sync -- --env staging` (with the staging secrets in env). If the secrets are simply unset the step skips with a warning instead of failing. |
| Smoke test (step 12) times out at 60s | Step 12 | Worker deploy completed but propagation lagging, or the Cloudflare Access service token (CF_ACCESS_CLIENT_ID/SECRET) rotated. Check `docs/access.md` §2. |

If a refresh leaves staging in an inconsistent state (drift fired, but you need staging usable for unrelated work), the fix is to either resolve the drift cause and re-press the button, or hand-revert by re-applying the prior good dump from R2 (the prod snapshots in `aeci-prod-snapshots` are functionally interchangeable as "any prod-shaped data").

## Drift check (PR-time)

The [`drift-check.yml`](../.github/workflows/drift-check.yml) workflow (AECI-80) is the **first** of the three drift layers from AECI-71. It runs on every PR that touches `supabase/migrations/**`, `apps/api/prisma/schema.prisma`, `scripts/prisma-drift-check.sh`, or itself. Most PRs skip it entirely thanks to the `paths:` filter — you'll only see it on schema-changing work.

**What it does:**

1. Boots a fresh local Supabase Postgres 17 on the runner (`supabase db start`).
2. Applies every migration in `supabase/migrations/` via `supabase db reset --local --no-seed`. Same path `pnpm db:reset` runs locally — CI and local stay in lock-step.
3. Runs `scripts/prisma-drift-check.sh` against the fresh DB. The script does `prisma db pull --print` + `prisma migrate diff --exit-code` and exits 1 on any non-empty diff.

**When it fails — how to fix:**

Drift means the committed `apps/api/prisma/schema.prisma` doesn't match what the migrations actually produce. Almost always: a migration was committed without re-pulling the schema. Fix locally:

```bash
git checkout <your-branch>
pnpm db:reset                          # apply all migrations to local
pnpm db:pull                           # regenerate schema.prisma from local DB
git add apps/api/prisma/schema.prisma
git commit -m "chore: regenerate schema.prisma after migration"
git push
```

The drift-check job will re-run on the new commit and pass.

**Three layers, recap.** This is layer 1. The remaining two are documented above and below:

| Layer | Workflow | Step | Against |
| --- | --- | --- | --- |
| 1. PR check | `drift-check.yml` | every step (whole job) | fresh local DB built from migrations |
| 2. Post-refresh | `refresh-staging.yml` | step 9 | staging post-restore + post-migrate |
| 3. Post-promote | `promote-to-prod.yml` | `apply-prod-migrations` job | prod post-migrate |

**Re-running manually.** If you want to reproduce the PR-time check on your laptop:

```bash
pnpm db:reset
./scripts/prisma-drift-check.sh 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
```

That's the literal command CI runs.

**Historical note.** AECI-80 originally inherited a P4002 hard-stop from the cross-schema FK `public.profiles.id → auth.users(id)`. AECI-80 first worked around it by enabling Prisma's `multiSchema` feature and mirroring the full `auth.*` shape in `apps/api/prisma/schema.prisma`; AECI-69 then dropped the FK entirely in favour of a trigger-based sync (see `docs/AUTH_AND_RLS.md` §8.1) and reverted the schema to single-schema `public` only. P4002 cannot recur in this shape. The full story is in `docs/prisma.md` §7 and `docs/adr/0007-prisma-migrate-dev-unsupported.md`.

## Promote-to-demo runbook

The [`promote-to-demo.yml`](../.github/workflows/promote-to-demo.yml) workflow promotes a staging-verified SHA to the public **demo** tier (`demo.aecintegrations.com`). It is the light sibling of promote-to-prod: demo shares the prod Supabase project (which production owns), so this workflow touches **no Postgres** — no R2 snapshot, no `supabase db push`, no RLS/drift gate. It only provisions the demo queues, applies the **demo D1** (`aeci-app-demo`) migrations, deploys the `aeci-{web,api}-demo` Workers, pushes the demo Worker secrets, and smoke-tests `demo.aecintegrations.com`.

1. Repo → Actions → **promote-to-demo** → **Run workflow**.
2. `commit_sha`: paste the full 40-char SHA you verified on staging (matches `https://staging.aecintegrations.com/api/version`).
3. `confirm`: type `PROMOTE` exactly, then **Run workflow**.

What happens, in order: validate `confirm` → preflight required secrets → assert **staging** is at the SHA (both Workers, with Access headers) → (GH Environment `demo`) provision `aeci-*-demo` queues → apply `aeci-app-demo` D1 migrations + taxonomy seed → deploy API then SSR (`--env demo`) → push demo Worker secrets (warn-and-skip for the non-critical ones) → smoke-test `demo.aecintegrations.com` (both Workers at SHA + `/api/health` db:ok) → apply demo Algolia index settings → auto-rollback both demo Workers on a smoke failure. The `demo` GH Environment has no required reviewer by default (add one to gate it). Demo is a showcase, so only `DATABASE_URL` (the `/api/health` gate) is fail-closed; Algolia/email/analytics are warn-and-skip.

## Promote runbook

The [`promote-to-prod.yml`](../.github/workflows/promote-to-prod.yml) workflow (AECI-78) is the only way prod gets new code. **It promotes from the demo tier** (chain: staging → demo → production), so promote a SHA to **demo** first via [`promote-to-demo.yml`](#promote-to-demo-runbook). Trigger it from the GitHub Actions UI:

1. Repo → Actions → **promote-to-prod** → **Run workflow**.
2. `commit_sha`: paste the full 40-char SHA you already verified on demo (matches what `https://demo.aecintegrations.com/api/version` reports).
3. `confirm`: type `PROMOTE` exactly.
4. Click **Run workflow**.

What happens, in order:

- **Pre-promotion checks (unattended, ~2 min)** — `pre-promotion-checks` job. Validates `confirm`, then via `scripts/verify-version.sh` asserts the **demo** SHA matches `inputs.commit_sha` on **both** `demo.aecintegrations.com/api/version` (API Worker) and `/_version` (SSR Worker, AECI-92) — demo is public, so the Cloudflare Access headers are harmless — refusing to continue unless both match. `/api/version` is proxied raw to the API Worker, so on its own it can't catch a stale SSR deploy. Then prints `supabase migration list --linked` against the (shared) prod Supabase project into the run log **and** the job summary so you can read the pending SQL inline before approving the next job.
- **Approval pause** — the `apply-prod-migrations` job enters the `production` GH Environment and blocks. The GitHub Actions UI shows "Waiting for review". Read the migration list in the previous job's summary before clicking Approve.
- **After approval (~5–10 min)** — `pg_dump` of prod → R2 (`aeci-prod-snapshots/prod-pre-<short-sha>.dump` plus a companion `-auth.dump` for auth-schema data), `supabase db push --linked`, drift check via `scripts/prisma-drift-check.sh` against `DIRECT_URL_PRODUCTION`. **HARD STOP on drift** — Workers don't deploy if drift is detected.
- **Worker deploys** — API first (`aeci-api-production`), SSR second (`aeci-web-production`). Each `wrangler deploy` line passes `--var COMMIT_SHA:${{ inputs.commit_sha }} --var DEPLOYED_AT:<shared timestamp>` per the CLAUDE.md non-negotiable.
- **Deploy marker + smoke** — Datadog `/api/v1/events` marker (docs/CICD_PLAN.md §9.1) tagged `env:production`, `service:aeci-ssr`, `commit:<sha>`. Then via `scripts/verify-version.sh` polls until **both** `https://prod.aecintegrations.com/api/version` (API Worker) and `/_version` (SSR Worker, AECI-92) report `sha: "<input>"` — public, so no Access headers. `/api/version` is proxied raw to the API Worker, so on its own it can't catch a stale SSR deploy. Fails after a 60-second budget.

**Recovering from a bad promote.** The R2 snapshot is the rollback insurance. For DB:

```bash
aws --endpoint-url "$R2_ENDPOINT" s3 cp s3://aeci-prod-snapshots/prod-pre-<short-sha>.dump .
pg_restore --clean --no-owner --no-privileges --dbname "$DIRECT_URL_PRODUCTION" prod-pre-<short-sha>.dump
```

For Worker code: `wrangler rollback --env production` against `apps/api` and `apps/web` (docs/CICD_PLAN.md §6.1). Snapshots live 30 days per the bucket lifecycle rule — older incidents require a Supabase point-in-time restore.

**Common failure modes:**

| Failure | Where | What it means / what to do |
| --- | --- | --- |
| `demo is not at <sha> on both Workers (API + SSR), refusing to promote` | `pre-promotion-checks` | Demo's `/api/version` (API Worker) and/or `/_version` (SSR Worker) don't match `inputs.commit_sha`; `scripts/verify-version.sh` logs the actual per-Worker SHAs. Promote the SHA to demo first (`promote-to-demo`), or change the input. |
| Drift check exits 1 | `apply-prod-migrations` | Prod schema diverges from `apps/api/prisma/schema.prisma`. Almost always means a migration was applied to prod without the corresponding `schema.prisma` update being merged. Hard-stop; Workers don't deploy. Fix by syncing `schema.prisma` via `pnpm db:pull` against a fresh DB built from migrations, opening a follow-up PR. |
| Migrations applied but `/api/version` or `/_version` doesn't return the new SHA within 60s | `deploy-prod-workers` | Wrangler deploy completed but propagation hasn't caught up, or the SSR deploy failed half-way (a stale `/_version` with a current `/api/version` is exactly the AECI-92 case the dual check catches). Inspect the `wrangler-action` step logs; if SSR is wedged, `wrangler rollback --env production` on `apps/web`. |
| R2 upload fails | `apply-prod-migrations` | The snapshot is step 4 — migrations have NOT run yet, so it's safe to re-run after fixing R2 access. Check `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ENDPOINT`. |
| Snapshot needed but the bucket lifecycle already expired it | — | Snapshots live 30 days. Older incidents require a Supabase point-in-time restore. |

## Local dev: running the API Worker (Prisma Accelerate)

The API Worker reaches Postgres **only** through Prisma Accelerate over HTTPS — `@prisma/client/edge` + `withAccelerate()` in [`apps/api/src/prisma.ts`](../apps/api/src/prisma.ts) — in **every** tier, including local `wrangler dev` / `pnpm dev:bound`. There is no local-only, non-Accelerate code path: per `CLAUDE.md` the runtime is Accelerate-only, and `@prisma/adapter-pg-worker` / a TCP pooler from a Worker are forbidden. So locally, `DATABASE_URL` **must** be a `prisma://` Accelerate URL. A `postgresql://` value makes every query throw `P6001` ("the URL must start with the protocol `prisma://`") and every list/detail endpoint return 500.

### Point local `DATABASE_URL` at the shared dev DB (Option 1)

Set `DATABASE_URL` in `apps/api/.dev.vars` to the **same value as the `DATABASE_URL_STAGING` GitHub Actions secret** — the Prisma Accelerate URL for the `aeci-development` project's `main` branch. That is the same DB staging serves, and the same value `pr-preview.yml` and the `e2e-tests-local` job in `deploy.yml` push to their Workers (Option 1, shared dev DB — see "PR previews" above).

```
DATABASE_URL="prisma://accelerate.prisma-data.net/?api_key=<aeci-development key>"
```

**Where to get it:** the [Prisma Console](https://console.prisma.io) (Prisma Data Platform) → the `aeci-development` Accelerate project → its connection string. (The raw `DATABASE_URL_STAGING` GitHub secret can't be read back — GH secrets are write-only — so the Console is the self-service source.)

Edit **only** the `DATABASE_URL` line in your existing `.dev.vars`; leave `DIRECT_URL`, `SUPABASE_*`, and `DD_*` as they are. Do **not** copy the CI shortcut: the `e2e-tests-local` job writes `.dev.vars` with `printf … > apps/api/.dev.vars`, which truncates the file to a single line — fine for that job's Worker, but locally it would wipe your other vars.

### What this means day to day

Running the app locally is for **UI work**: the Worker reads the shared dev DB and renders real data. You won't normally write. Because the runtime DB is remote (Accelerate over HTTPS), **you do not need `supabase start` / the local Postgres container just to run the app** — that container is only for authoring migrations (`pnpm db:new` / `db:reset` / `db:pull`, which target `127.0.0.1:54322` by hard-coded URL and ignore `DATABASE_URL`; see [`prisma.md`](./prisma.md) §5). `prisma generate` (run by `pnpm dev` / `dev:preview`) reads `DATABASE_URL` but never connects, so a `prisma://` value is safe for it.

> **Heads-up — shared writes.** Under Option 1 the locally-running Worker reads **and writes** the shared `aeci-development` database. The rare local action that hits a write path (`POST /api/promote`, review/moderation flows, page-view inserts) mutates the same data staging and other developers see. It is never prod — `aeci-production` is a separate project — but treat local write testing as touching shared state.

### Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `/api/health` returns 500 `{ ok:false, db:"error" }`; logs show `P6001` / "the URL must start with the protocol `prisma://`" | Local `DATABASE_URL` is a `postgresql://` URL, but the edge client requires an Accelerate URL | Set `DATABASE_URL` in `apps/api/.dev.vars` to the `prisma://` value (same as `DATABASE_URL_STAGING`). See above. |

## Local dev: seeding from staging

[`scripts/seed-from-staging.sh`](../scripts/seed-from-staging.sh) (AECI-80) pulls staging's data shape into your local Postgres. Wrapped by `pnpm db:seed-from-staging`. This is the only sanctioned way to get realistic data on a laptop — **prod credentials never leave Cloudflare and GitHub Actions**.

### Prereqs

1. Local Supabase running: `pnpm db:start` (boots Postgres 17 on 54322).
2. `DIRECT_URL_STAGING` exported in your shell. Get it from:
   - Supabase Dashboard → `aeci-development` project → Project Settings → Database → Connection string → **URI** (pooler / Transaction mode, port 6543).
   - The same value Chris has in `gh secret` as `DIRECT_URL_STAGING`.

Add it to your shell config (`.zshrc` / `.bashrc` / `direnv` `.envrc`) — do **not** paste it into `.dev.vars`. The Worker has no use for raw Postgres credentials; only the seed script reads this variable.

### Running

```bash
pnpm db:start                         # if not already up
export DIRECT_URL_STAGING='postgresql://postgres:...@aws-0-...pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1'
pnpm db:seed-from-staging
pnpm db:studio                        # http://localhost:54323 — inspect
```

Runtime: ~30-90 seconds depending on staging size.

### What you get

- **Public schema:** every table, view, function, RLS policy as it currently exists in staging — same shape staging serves over PostgREST. Realistic row counts of vendors / products / integrations / reviews.
- **`auth.users` rows:** every staging user (which itself is every prod user, credential-scrubbed). IDs match staging, so FKs into `public` (e.g. `reviews.user_id`) all resolve. None of these accounts can authenticate — passwords are NULL.
- **Test accounts:** the four seeded by `seed-staging-users.sql` (chrisw, billh, reviewer, admin) — these **can** authenticate, with known passwords listed in the SQL file. Use these for local sign-in.
- **Migration history:** `supabase_migrations.schema_migrations` is restored from staging, so subsequent `pnpm db:push` / `pnpm db:reset` work without confusion.

### Safety guarantees

The script:
- Is **read-only** against staging — only `pg_dump` calls, no writes.
- **Refuses to run** against a `LOCAL_DATABASE_URL` that isn't `127.0.0.1` or `localhost` — drops the public schema on its target, so this is non-negotiable.
- **Refuses to run** without `DIRECT_URL_STAGING` set, without `pg_dump`/`pg_restore`/`psql`/`pg_isready` on PATH, or without local Postgres responding on the target URL.
- Re-runs the auth-credential scrub locally (defensive — staging is already scrubbed; cheap to do twice).
- Is **idempotent.** Re-running drops + restores cleanly. No accumulating state.

### Why staging, not prod

- Prod database credentials are GH-Actions-only and Cloudflare-Worker-only. They never land on a laptop. Period.
- Staging already mirrors prod's shape (refresh-staging.yml restores prod data on demand) with credentials scrubbed — the same payload, made safe to look at.
- Pattern B (R2 snapshot file) is a follow-up if staging connections ever become a bottleneck. Until then, staging is the source.

### Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `pg_dump: error: connection to server ... failed` | DIRECT_URL_STAGING is wrong or rotated | Re-fetch from Supabase dashboard (see Prereqs). |
| `Local Postgres at ... is not accepting connections.` | Forgot `pnpm db:start` | Run it. |
| `pg_dump` not found | Missing PostgreSQL client | macOS: `brew install libpq && brew link --force libpq`. Linux: `apt install postgresql-client-17` (PGDG repo). |
| `permission denied for schema public` | Local DB is in a half-reset state | `pnpm db:reset` then re-run. |
| Restore looks complete but `pnpm db:studio` shows no rows | Browsed to wrong DB | Studio defaults to `postgres` on 54322 — verify the connection bar. |

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

5. **`SUPABASE_URL` override for local-stack RLS specs.** The API Worker runtime
   `SUPABASE_URL` points at the shared auth project, but the PostgREST/RLS
   integration suites can run against a **local** `supabase start` stack by
   overriding per-invocation — a shell-set var beats `dotenv -e .dev.vars`:
   ```bash
   SUPABASE_URL=http://127.0.0.1:54321 \
   SUPABASE_ANON_KEY=<local anon> SUPABASE_SERVICE_ROLE_KEY=<local secret> \
   pnpm --filter @aeci/api test:integration
   ```

> ⚠️ **Never run the service-role trigger specs against the shared dev
> project.** `auth_user_delete_trigger.spec.ts` creates and deletes real
> `auth.users` via the admin API. Keep `SUPABASE_SERVICE_ROLE_KEY` empty in
> `apps/api/.dev.vars` (the spec self-skips) and supply it **only** in a
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

## Secrets

Secrets are stored in three places:
- **GitHub Actions secrets** (repo-level, used by `.github/workflows/*.yml`).
- **Cloudflare Worker secrets** (per Worker `name`, set via `wrangler secret put <KEY> --env <env>`; not visible in source).
- **Local `.dev.vars`** (per app, gitignored; mirrors a subset of Worker secrets for local dev).

| Secret | Staging Worker | Prod Worker | GH Actions | Notes |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` — **RETIRED** | ❌ | ❌ | ❌ — the `DATABASE_URL_{STAGING,PRODUCTION}` GH secrets have been removed | The app DB is Cloudflare D1 (ADR 0016), reached via the Worker's `DB` binding — there is **no DB connection secret**. The Prisma Accelerate runtime path is retired (AECI-253), so CI no longer pushes `DATABASE_URL` to any Worker and the e2e/Lighthouse runs boot a local D1 via `db:setup:local`. (The legacy `DIRECT_URL`/`supabase` Postgres gate survives until AECI-257.) |
| `DIRECT_URL_STAGING` (Supabase pooler `postgresql://…`) | ❌ | ❌ | ✅ | Used by `supabase db push`, `pg_dump`, `pg_restore`. Workers never see this. |
| `DIRECT_URL_PRODUCTION` | ❌ | ❌ | ✅ | Same. |
| `SUPABASE_ACCESS_TOKEN` | ❌ | ❌ | ✅ | For `supabase` CLI in CI. |
| `SUPABASE_MANAGEMENT_API_TOKEN` | ❌ | ❌ | ✅ | For PR-preview branch lifecycle (AECI-79). |
| `CLOUDFLARE_API_TOKEN` | ❌ | ❌ | ✅ | Scoped narrowly per CICD_PLAN §7.1. |
| `CLOUDFLARE_ACCOUNT_ID` | ❌ | ❌ | ✅ | `e62ec9d8012c3e0c225f8e4dbab76b79` |
| `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` | ❌ | ❌ | ✅ | Service token for non-prod smoke tests (`docs/access.md` §1). |
| `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` + `R2_ENDPOINT` | ❌ | ❌ | ✅ | Prod snapshot uploads (AECI-78). Bucket `aeci-prod-snapshots`, object key `prod-pre-<short-sha>.dump` (12-char truncated input SHA). Uploaded via AWS CLI against `R2_ENDPOINT` (S3-compatible). |
| `DATADOG_API_KEY` | ❌ | ❌ | ✅ | Used by `promote-to-prod.yml` (AECI-78) to POST deploy markers to Datadog `/api/v1/events` per CICD_PLAN §9.1. |
| `RESEND_API_KEY_STAGING` | ✅ on staging API Worker (as `RESEND_API_KEY`) | ❌ | — | Transactional email (AECI-240). Graceful warn-and-skip; sends to allowlisted addresses only in staging. See `docs/email.md`. |
| `RESEND_API_KEY_PRODUCTION` | ❌ | ✅ on prod API Worker (as `RESEND_API_KEY`) | — | Transactional email; sends to real users. |
| Datadog `DD_*` (per `apps/web/wrangler.jsonc` header) | ✅ per env | ✅ per env | — | RUM + Logs intake. |
| `ADMIN_PURGE_TOKEN`, `CF_PURGE_API_TOKEN`, `CF_ZONE_ID` | ✅ per env | ✅ per env | — | Cache-tag purge (AECI-56). |
| `ALGOLIA_APP_ID` | ✅ per env (both Workers) | ✅ per env (both Workers) | ✅ (shared, one value) | Algolia app id (AECI-134). Single value, all envs. |
| `ALGOLIA_SEARCH_KEY` (query-only) | ✅ on web Worker (CI-pushed) | ✅ on web Worker (CI-pushed) | ✅ **single shared** un-suffixed `ALGOLIA_SEARCH_KEY` (one value for every env — staging/production/demo, and the `lighthouse.yml` preview `/search` measurement, AECI-188). The former `_STAGING`/`_PRODUCTION`/`_PREVIEW`/`_DEMO` secrets are retired. | Search-only key, client-exposed. **Must be scoped to cover every env's indexes it serves** (`staging_*`/`production_*`/`demo_*`/`preview_*`) — it's now one shared value, so a key scoped to a single env breaks the others. CI-pushed to the web Worker alongside `ALGOLIA_APP_ID` by `deploy.yml` (staging — recommended/warn-and-skip), `promote-to-prod.yml` (production — required/fail-closed), `promote-to-demo.yml` (demo). **Never on the API Worker.** |
| `ALGOLIA_ADMIN_KEY` (management) | ✅ on API Worker | ✅ on API Worker | ✅ **single shared** un-suffixed `ALGOLIA_ADMIN_KEY` (one value, all envs). The former `_STAGING`/`_PRODUCTION` secrets are retired. | Management key (search + index-mutation) — sync from 3.5. One Algolia app spans all envs and the admin key reaches every index (`--env` is only an index-name prefix). **Never on the web Worker / never client-exposed.** |
| `SUPABASE_URL` (shared auth project URL) | ✅ all envs (both Workers, as a wrangler `var`) | ✅ all envs (both Workers, as a wrangler `var`) | — (it's a public `var` in `wrangler.jsonc`, not a GH secret) | AECI-193 / Phase 5 / ADR 0017. Public base URL — the **single shared auth project** (`ktuhnlypztujpsseujzx`) across every environment. Web Worker → cookie-session factory; API Worker → JWKS user-JWT verify (no DB round-trip). |
| `SUPABASE_ANON_KEY` (publishable/anon) | ✅ on **web Worker only** (CI-pushed) | ✅ on **web Worker only** (CI-pushed) | ✅ as the un-suffixed `SUPABASE_ANON_KEY` — a **single shared key**, one value for every env (ADR 0017); demo + per-PR previews push the same secret | AECI-193 / Phase 5 / ADR 0017. Publishable key for the **single shared auth project** (`ktuhnlypztujpsseujzx`); stored as a secret only to keep it out of git (like `ALGOLIA_SEARCH_KEY`). Pushed by `deploy.yml` (staging), `promote-to-prod.yml` (production), `promote-to-demo.yml` (demo), `pr-preview.yml` (per-PR). **It must match `SUPABASE_URL`'s project** — a stale per-project key against the shared URL is what produces the browser `Invalid API key` sign-in error. **Never on the API Worker** (it verifies with public JWKS material). **Recommended, not required, during Phase 5 — warn-and-skip; flips to REQUIRED in 5.5.** Absent → SSR auth surfaces return `503 auth_not_configured`. |
| `SUPABASE_TEST_USER_EMAIL` + `SUPABASE_TEST_USER_PASSWORD` | ❌ never on a Worker | ❌ never on a Worker | ✅ (CI test only) | AECI-235. Credentials for the **admin** test user (`test@thewbsproject.com`, an admin account in the shared Supabase project; its `role='admin'` D1 profile is keyed to Supabase user id `519f1e77-…` in `apps/api/seed/auth-fixtures.sql`) that `apps/web/e2e/authed-console.spec.ts` signs in to console-check the auth-gated Phase 5 pages. Consumed only by the `deploy.yml` Playwright step `env:` (never a Worker binding, never client-exposed). **Optional — warn-and-skip:** absent → the spec skips its 4 cases. Local dev sets the same pair in `apps/web/.dev.vars`. **Remaining manual step** to activate the gate in CI. |
| `ANTHROPIC_API_KEY` (review toxicity scoring) | ✅ on **API Worker only** (CI-pushed) | ✅ on **API Worker only** (CI-pushed) | ✅ as `ANTHROPIC_API_KEY_STAGING` / `_PRODUCTION` (previews reuse `_STAGING`) | AECI-258. Anthropic key for Claude-Haiku toxicity scoring on `POST /api/reviews`. CI-pushed to the API Worker by `deploy.yml` (staging), `promote-to-prod.yml` (production), and `pr-preview.yml` (per-PR). **Optional + fail-open on every env (prod included) — warn-and-skip:** a missing key stores `toxicity_score=null` ("Not scored") and the review still enters the moderation queue, so it is **never** in `REQUIRED_WORKER_SECRETS`. **Never on the web Worker.** Supersedes the sunsetting Perspective API. **GDPR prerequisite:** the Messages API has no per-request no-store control (Perspective's `doNotStore` had no equivalent), so the Anthropic org behind the key **must** have zero data retention (ZDR) enabled before a real key is provisioned — confirm as a launch gate, otherwise scored review bodies are retained ~30 days outside the §8 erasure boundary. |
| `POSTHOG_KEY` (publishable project key) | ✅ on **web Worker only** (CI-pushed) | ✅ on **web Worker only** (CI-pushed) | ✅ as `POSTHOG_KEY_STAGING` / `_PRODUCTION` (previews reuse `_STAGING`) | AECI-239 / Phase 7.4. Client-exposed project API key for the browser product-analytics layer; stored as a secret only to keep it out of git (like `ALGOLIA_SEARCH_KEY`). CI-pushed to the web Worker by `deploy.yml` (staging), `promote-to-prod.yml` (production), `pr-preview.yml` (per-PR). **Optional + fail-open on every env — warn-and-skip:** absent → no `window.__AECI_POSTHOG__` and analytics no-ops. Also gated client-side by the consent banner + DNT. **Never on the API Worker.** |
| `POSTHOG_HOST` (ingestion host) | ✅ per env (web Worker, wrangler `var`) | ✅ per env (web Worker, wrangler `var`) | — (public `var` in `wrangler.jsonc`, not a GH secret) | AECI-239. `https://us.i.posthog.com` (US Cloud). The static CSP `connect-src` is pinned to the US hosts, so a non-US host needs a matching CSP change. Defaulted in code when unset. |
| Supabase **service-role** key | ❌ never on a Worker | ❌ never on a Worker | operator-held `SUPABASE_SERVICE_ROLE_KEY` GH secret; **no workflow reads it** | The Worker runtime has no use for the service role (`AUTH_AND_RLS.md` §3) — it is **never** pushed to a Worker, and **no GitHub workflow consumes it**: the `integration-db-tests` job mints its own service-role key from a local `supabase start` stack (`supabase status -o env`), not from a repo secret. The GH secret exists only for transient operator-shell use (e.g. provisioning the dev test user, AECI-193). Not a per-env runtime secret and **not involved in sign-in** — auth uses `SUPABASE_URL` + the anon key (rows above). |

All Worker secrets are pushed per environment: `wrangler secret put REVIEW_APP_TOKEN --env staging` (and the same for `--env production`).

> **`REVIEW_APP_TOKEN` is pushed automatically by CI.** `deploy.yml` (`deploy-staging`) re-pushes it to the staging API Worker from `REVIEW_APP_TOKEN`; `promote-to-prod.yml` (`deploy-prod-workers`) does the same to the prod API Worker. Idempotent, right after the API Worker deploys. The manual `wrangler secret put` is only needed to bootstrap a Worker *before* its first CI deploy (and as a fallback). The other Worker secrets in §6 are still pushed by hand. (`DATABASE_URL` is no longer pushed — the app DB is D1, ADR 0016 / AECI-253.)

### The required-secrets rule (CI fails closed)

**A deploy/promote will not proceed to an environment that is missing a secret it needs.** Three gates enforce it; the required vs. recommended split must stay in sync with the runtime contracts in `apps/api/src/env.ts` and `apps/web/src/env.ts`:

1. **Preflight** — `scripts/require-secrets.sh` runs *before* any deploy (staging: first step of `deploy-staging`; prod: `pre-promotion-checks`, **before** the approval gate and any snapshot/migration). It fails the run, listing every missing **required** GH Actions secret at once, so nothing is deployed and no DB is touched. **Recommended-but-optional** secrets only emit a `::warning::`.
2. **Push** — the required Worker runtime secrets (`DATABASE_URL`, `REVIEW_APP_TOKEN`) are pushed to the API Worker from those GH secrets (idempotent), each fail-loud if its source is empty.
3. **Postflight** — `scripts/verify-worker-secrets.sh` lists the live Worker's secrets (`wrangler secret list`) and asserts the required runtime names are actually present; `scripts/verify-health.sh` proves the DB is reachable. Both run after deploy and fail the release if the environment didn't end up with what it needs.

| Tier | Staging (`deploy.yml`) | Production (`promote-to-prod.yml`) | Effect if missing |
| --- | --- | --- | --- |
| **Required (fail)** | `REVIEW_APP_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | + `DIRECT_URL_PRODUCTION`, `SUPABASE_ACCESS_TOKEN`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `ALGOLIA_APP_ID`, `ALGOLIA_ADMIN_KEY`, `ALGOLIA_SEARCH_KEY` | Deploy/promote refused |
| **Recommended (warn)** | `ADMIN_PURGE_TOKEN`, `DATADOG_API_KEY`, `DIRECT_URL_STAGING` | `ADMIN_PURGE_TOKEN`, `DATADOG_API_KEY`, `CF_PURGE_API_TOKEN`, `CF_ZONE_ID` | Degraded only (observability / cache-purge); deploy proceeds |

To make a recommended secret blocking, move its name from `RECOMMENDED_SECRETS` to `REQUIRED_SECRETS` in the relevant workflow's preflight step (and, if it's a Worker runtime secret, add a push step + the postflight `REQUIRED_WORKER_SECRETS` list).

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
| `SUPABASE_PROJECT_REF` | The **legacy Postgres** project ref for the retained `public`-schema gate. **Not** the auth project (auth is the single shared `ktuhnlypztujpsseujzx`, ADR 0017). **⚠️ Single value for both gates:** `deploy.yml`/`refresh-staging.yml` (staging) and `promote-to-prod.yml` (production) now both `supabase link --project-ref` against this one variable — formerly two distinct DBs (`dmbygwupskttzsvfzluq` dev, `jgxebjufabtwkcgxjqvk` prod). Confirm the single value is the DB whose schema both `supabase db push` calls should target, or keep the legacy gate's two DBs distinct until AECI-256/257 retire it. | Consumed by `deploy.yml` (db-migrate-dev) + `refresh-staging.yml` (AECI-77) and `promote-to-prod.yml` (AECI-78) for `supabase link --project-ref` before `supabase migration list --linked` / `db push --linked` against the retained public-schema gate. |

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
> + the un-suffixed `SUPABASE_SERVICE_ROLE_KEY`. Per-environment isolation is Cloudflare
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
- [ ] `demo.aecintegrations.com` and `prod.aecintegrations.com` need **no manual zone edits** — `custom_domain: true` in each web env block makes wrangler provision the DNS record + cert on deploy: `prod.` on the first prod deploy, `demo.` on the first demo deploy (the latter **reassigns** the hostname off the old production Worker, so deploy demo BEFORE re-deploying production). The apex (`aecintegrations.com`) + `www` stay on the landing Worker until the apex cutover.

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
- [ ] `DIRECT_URL_STAGING` (Supabase pooler `postgresql://…` for the legacy-Postgres gate; retained until AECI-257)
- [ ] `SUPABASE_ACCESS_TOKEN` (used by `supabase` CLI in CI)
- [ ] `SUPABASE_ANON_KEY` — the **single shared** publishable/anon key for the auth project `ktuhnlypztujpsseujzx` (un-suffixed; the SAME value drives staging, demo, production, and per-PR previews — ADR 0017). It must belong to the project named in `SUPABASE_URL`; a leftover per-project key (`…_STAGING` / `…_PRODUCTION` from before the consolidation) is what surfaces as `Invalid API key` at sign-in. Recommended (warn-and-skip) until 5.5.
- [ ] `SUPABASE_SERVICE_ROLE_KEY` — *optional*; operator-held for transient shell provisioning only. No workflow or Worker reads it, so it is **not** required for any deploy and **not** per-env (the live secret is the un-suffixed `SUPABASE_SERVICE_ROLE_KEY`). See the service-role row in §Secrets.

Prod-only secrets (`DIRECT_URL_PRODUCTION`, R2 keys) can wait until AECI-78. (There is no `DATABASE_URL_PRODUCTION` — the app DB is D1, ADR 0016 / AECI-253.)

### 6. Cloudflare Worker secrets (`wrangler secret put <KEY> --env staging`)

Run from `apps/api` and `apps/web` respectively:

```bash
cd apps/api
# No DATABASE_URL — the app DB is Cloudflare D1 (ADR 0016), reached via the `DB`
# binding; the Prisma Accelerate runtime path is retired (AECI-253).
wrangler secret put DIRECT_URL --env staging                # Supabase pooler postgresql://… (only used by `prisma db pull` locally; harmless on Worker)
# NOTE: do NOT push the Supabase service-role key to any Worker — it is never read at runtime (see the service-role row in §Secrets / AUTH_AND_RLS.md §3).
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

### 7. Flip the gate

- [ ] `gh variable set SUPABASE_PROJECT_REF --body "<legacy-postgres-ref>"` (consumed by `deploy.yml` db-migrate-dev + `refresh-staging.yml` — AECI-77; the single legacy-Postgres gate ref shared with `promote-to-prod.yml`).
- [ ] `gh variable set STAGING_ENABLED --body "true"` (or set in the UI).

The next push to `main` will trigger `deploy-staging`. The smoke test (`scripts/verify-version.sh`) will assert that **both** `staging.aecintegrations.com/api/version` (API Worker) and `/_version` (SSR Worker, AECI-92) report `sha: <merge commit>`.

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
  # No DATABASE_URL_PRODUCTION — the app DB is Cloudflare D1 (ADR 0016); the
  # Prisma Accelerate runtime path is retired (AECI-253).
  gh secret set DIRECT_URL_PRODUCTION   --body "<postgresql://... pooler URL>"   # legacy-Postgres gate, retained until AECI-257
  # The service-role key is NOT provisioned here — no workflow or Worker reads it
  # (see the service-role row in §Secrets). Keep it operator-held only.
  ```
- [ ] **Datadog deploy-marker secret.** `gh secret set DATADOG_API_KEY --body "<key>"` (already exists for Worker runtime intake; CI needs its own copy to POST to `/api/v1/events`).
- [ ] **Production Worker secrets.** Run the same `wrangler secret put …` list from §6 against `--env production` from `apps/api/` and `apps/web/`. There is **no** `DATABASE_URL` to push — the app DB is Cloudflare D1 (ADR 0016), reached via the `DB` binding. `REVIEW_APP_TOKEN` is pushed automatically by `promote-to-prod.yml` on every promote (the manual put is a bootstrap fallback). All the other secrets (`DIRECT_URL`, `DD_*`, `ADMIN_PURGE_TOKEN`, `CF_PURGE_API_TOKEN`, `CF_ZONE_ID`, …) are still manual. (`RESEND_API_KEY` is **not** manual — `promote-to-prod.yml` pushes it from the `RESEND_API_KEY_PRODUCTION` GH secret, graceful; AECI-240.) (The service-role key is **not** in this list — it is never pushed to a Worker; see the service-role row in §Secrets.)
- [ ] **Algolia production indexes + keys (AECI-134).** With the root creds exported (as in §6b), `node scripts/algolia/provision.mjs --env production`. Then:
  ```bash
  gh secret set ALGOLIA_SEARCH_KEY --body "<printed search key>"   # single shared key (covers production_* + the other envs' indexes)
  gh secret set ALGOLIA_ADMIN_KEY  --body "<printed management key>"  # single shared key, all envs
  # ALGOLIA_APP_ID is shared — already set in §6b.
  cd apps/web && wrangler secret put ALGOLIA_APP_ID --env production && wrangler secret put ALGOLIA_SEARCH_KEY --env production   # never the admin key on web
  cd ../api  && wrangler secret put ALGOLIA_APP_ID --env production && wrangler secret put ALGOLIA_ADMIN_KEY  --env production
  ```
- [ ] **PostHog production key (AECI-239).** `gh secret set POSTHOG_KEY_PRODUCTION --body "<prod project api key>"` — `promote-to-prod.yml` CI-pushes it to the prod web Worker (warn-and-skip; analytics no-ops if unset). `POSTHOG_HOST` is a public `var` (US Cloud). To unblock manually: `cd apps/web && wrangler secret put POSTHOG_KEY --env production`. **Never on the API Worker.**
- [ ] **Project ref repo variable.** `gh variable set SUPABASE_PROJECT_REF --body "<legacy-postgres-ref>"` (per §1) — single shared variable; `promote-to-prod.yml` and `deploy.yml`/`refresh-staging.yml` both link against it. ⚠️ Was two distinct DBs (dev `dmbygwupskttzsvfzluq` / prod `jgxebjufabtwkcgxjqvk`); confirm one ref is correct for both `db push` gates.
- [ ] **Verify GH Environment.** The `production` GH Environment (created in §4) must list `chrisw@thewbsproject.com` as a required reviewer. Without that, the workflow's `apply-prod-migrations` job will not pause for approval.

Once all boxes are ticked, dry-run the workflow with a deliberately wrong `commit_sha` to verify the negative path: `pre-promotion-checks` must fail at step 4 with `demo is not at <input> on both Workers (API + SSR), refusing to promote` and the run must stop before any downstream job.

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

> **Future — apex cutover (out of scope here).** When the directory launches, move `aecintegrations.com` + `www` off the landing Worker onto `aeci-web-production`, set the production web Worker's `ALLOW_INDEXING="true"`, and flip the API Worker's `PUBLIC_SITE_URL` to the apex.

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
