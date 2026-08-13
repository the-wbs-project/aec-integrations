# Environments

> **Operator runbook.** Topology, promotion model, both manual buttons (`refresh-staging`, `promote-to-prod`), PR-preview lifecycle, PR-time drift gate, local seeding, secrets, and the one-time manual bootstrap checklist. If you only need to push a code change to staging or prod, the **Promote runbook** and **Refresh runbook** sections below are sufficient — everything above them is reference; everything below is reference + setup.
>
> Cross-references at the bottom point at companion docs that own narrower contracts (CI/CD plan, migrations, Cloudflare Access).

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

> The **production** tier serves the apex `aecintegrations.com` + `www.aecintegrations.com` (the public home, `ALLOW_INDEXING="true"`, indexable) and `prod.aecintegrations.com` (the Access-gated internal host per ADR 0017, crawler-free); the **demo** tier serves `demo.aecintegrations.com` (the public showcase, still **no-index** `ALLOW_INDEXING="false"`). The **apex cutover** (AECI-247/277) binds `aecintegrations.com` + `www.` to `aeci-web-production` in the web wrangler config and folds the bare apex→`www.` with a 301 in the SSR Worker (`www.` is the canonical served host — ADR 0011 amendment 2026-07-05, reversing the original www→apex direction); the retired `apps/landing` Worker no longer serves them. The DNS reassignment (off the old landing Worker onto the app) executes on the next `promote-to-prod` deploy after the cutover PR merges — see `docs/launch-cutover-runbook.md`.
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

**Common failure modes:**

| Failure | Where | What it means / what to do |
| --- | --- | --- |
| `[production] REFUSING to deploy — required secret(s) missing: …` | `pre-promotion-checks` | A required prod GH Actions secret is unset/empty; `scripts/require-secrets.sh` lists every missing one at once. Set them (Settings → Secrets and variables → Actions) and re-run — nothing was deployed and no DB was touched. |
| `demo is not at <sha> on both Workers (API + SSR), refusing to promote` | `pre-promotion-checks` | Demo's `/api/version` (API Worker) and/or `/_version` (SSR Worker) don't match `inputs.commit_sha`; `scripts/verify-version.sh` logs the actual per-Worker SHAs. Promote the SHA to demo first (`promote-to-demo`), or change the input. |
| `wrangler d1 migrations apply` exits non-zero | `deploy-prod-workers` | The D1 migration failed (commonly `CLOUDFLARE_API_TOKEN` lacking Account → D1 → Edit). Runs after approval but **before** the Worker deploys, so nothing shipped — fix the token/migration and re-run. |
| Deployed but `/api/version` or `/_version` doesn't return the new SHA within 60s | `deploy-prod-workers` | Wrangler deploy completed but propagation hasn't caught up, or the SSR deploy failed half-way (a stale `/_version` with a current `/api/version` is exactly the AECI-92 case the dual check catches). The smoke failure auto-rolls-back both Workers; inspect the deploy step logs. |

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
2. **Show both numbers, never substitute.**
3. **Ship it unset. Do not hardcode an ASN.** Prefer the precise instruments
   first — AECI-575 (exclude `/admin/*` from `PageViewTracker`) and AECI-585
   (`cf_as_organization` at ingest, so the filter can label itself).

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
| **Recommended (warn)** | `ADMIN_PURGE_TOKEN`, `DATADOG_API_KEY` | `ADMIN_PURGE_TOKEN`, `DATADOG_API_KEY`, `CF_PURGE_API_TOKEN`, `CF_ZONE_ID` | Degraded only (observability / cache-purge); deploy proceeds |

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

### 2b. Promote Workflow + `PROMOTE_KV` (AECI-563 / ADR 0021)

`POST /api/promote` returns `202 { jobId }` and commits inside a Cloudflare **Workflow**, one per environment (`aeci-promote-{preview,staging,demo,production}`, binding `PROMOTE_WORKFLOW`, class `PromoteWorkflow`).

- [ ] **No provisioning step needed for the Workflow itself** — unlike Queues, `wrangler deploy` creates/updates it from the `workflows` block in `apps/api/wrangler.jsonc`. It does require the **Workers Paid plan** (already satisfied for Queues) and the CI `CLOUDFLARE_API_TOKEN`'s existing **Workers Scripts: Edit** permission.
- [x] **`PROMOTE_KV` — all four namespaces provisioned 2026-08-12** and their ids are in `apps/api/wrangler.jsonc`, in the base block **and in each of the four env blocks**. The per-env entries are load-bearing: wrangler **replaces** (does not merge) the top-level `kv_namespaces` for an env, so an env block without its own `PROMOTE_KV` entry simply has no such binding. Two key spaces (see `apps/api/src/lib/promote-jobs.ts`): `promote:payload:{jobId}` (24h) stages a bundle too large for the 1 MiB Workflow event-params cap, and `promote:result:{jobId}` (90d) mirrors the committed ID map so it outlives the 30-day instance retention.

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
- [ ] **Release ordering:** the deployed review app still expects the old synchronous `200`. Staging auto-tracks `main`, but **do not run `promote-to-prod` until the review app's AECI-567 is deployed**, or every production promote breaks.

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
- [ ] `SUPABASE_SERVICE_ROLE_KEY` — *optional*; operator-held for transient shell provisioning only. No workflow or Worker reads it, so it is **not** required for any deploy and **not** per-env (the live secret is the un-suffixed `SUPABASE_SERVICE_ROLE_KEY`). See the service-role row in §Secrets.

`DIRECT_URL_PRODUCTION` is now **orphaned** — `refresh-staging.yml` was gutted (no more `pg_dump`) and the prod promote touches no Postgres (AECI-278). The R2 snapshot keys are likewise orphaned. There is no `DATABASE_URL_PRODUCTION` — the app DB is D1 (ADR 0016 / AECI-253).

### 6. Cloudflare Worker secrets (`wrangler secret put <KEY> --env staging`)

Run from `apps/api` and `apps/web` respectively:

```bash
cd apps/api
# No DATABASE_URL / DIRECT_URL — the app DB is Cloudflare D1 (ADR 0016), reached
# via the `DB` binding; the Prisma Accelerate runtime path is retired (AECI-253)
# and Prisma is fully removed (AECI-278).
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
- [ ] **`DIRECT_URL_PRODUCTION` — orphaned (AECI-278).** The prod promote touches no Postgres, and `refresh-staging.yml` was gutted (no more `pg_dump`), so no workflow consumes it. Skip it. (The service-role key is also **not** provisioned here — no workflow or Worker reads it; keep it operator-held only.)
- [ ] **Datadog deploy-marker secret.** `gh secret set DATADOG_API_KEY --body "<key>"` (already exists for Worker runtime intake; CI needs its own copy to POST to `/api/v1/events`).
- [ ] **Production Worker secrets.** Run the same `wrangler secret put …` list from §6 against `--env production` from `apps/api/` and `apps/web/`. There is **no** `DATABASE_URL` / `DIRECT_URL` to push — the app DB is Cloudflare D1 (ADR 0016), reached via the `DB` binding (Prisma fully removed, AECI-278). `REVIEW_APP_TOKEN` is pushed automatically by `promote-to-prod.yml` on every promote (the manual put is a bootstrap fallback). The other secrets (`DD_*`, `ADMIN_PURGE_TOKEN`, `CF_PURGE_API_TOKEN`, `CF_ZONE_ID`, …) are still manual. (`RESEND_API_KEY` is **not** manual — `promote-to-prod.yml` pushes it from the shared, un-suffixed `RESEND_API_KEY` GH secret, graceful; AECI-240.) (The service-role key is **not** in this list — it is never pushed to a Worker; see the service-role row in §Secrets.)
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
