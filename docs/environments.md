# Environments

> **Operator runbook.** Topology, promotion model, both manual buttons (`refresh-staging`, `promote-to-prod`), PR-preview lifecycle, PR-time drift gate, local seeding, secrets, and the one-time manual bootstrap checklist. If you only need to push a code change to staging or prod, the **Promote runbook** and **Refresh runbook** sections below are sufficient — everything above them is reference; everything below is reference + setup.
>
> Cross-references at the bottom point at companion docs that own narrower contracts (CI/CD plan, migrations, Prisma-as-query-builder, Cloudflare Access).

## Topology

AECi runs three tiers of environment plus local. Worker and Supabase project naming is rigid — workflows, smoke tests, and docs assume these exact names.

| Tier | Cloudflare Workers | Supabase | Public URL | Access control |
| --- | --- | --- | --- | --- |
| **Local** | `wrangler dev` / `pnpm dev:bound` | Local Postgres (`supabase start`, port 54322) | `http://localhost:8788` | None (loopback) |
| **PR preview** | `aeci-{api,web}-pr-<N>` (`*.aec-integrations.workers.dev`) | Dev project, ephemeral branch DB per PR (AECI-79) | `*.workers.dev` (PR-specific) | Cloudflare Access — service token for CI, OTP-to-email for humans |
| **Staging** | `aeci-{api,web}-staging` | Dev project, `main` branch | `https://staging.aecintegrations.com` | Cloudflare Access — same allowlist as previews |
| **Production** | `aeci-{api,web}-production` | Prod project | `https://demo.aecintegrations.com` | Public |

> Pre-launch, the web app serves `demo.aecintegrations.com` only. The apex (`aecintegrations.com`) and `www.aecintegrations.com` remain served by the **landing** Worker (`apps/landing`) — we are not promoting the app to `www` yet.

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
  "https://api.supabase.com/v1/projects/$SUPABASE_DEV_PROJECT_REF/branches" \
  | jq '.[] | {id, name, git_branch, status}'

# 2. Delete the orphan by its branch ID (NOT name).
curl -sS -X DELETE \
  -H "Authorization: Bearer $SUPABASE_MANAGEMENT_API_TOKEN" \
  "https://api.supabase.com/v1/branches/<branch-id>"

# 3. Confirm it's gone — re-run the list call and grep for the ID.
```

Cost note: branch DBs bill per active day. A forgotten branch is the silent budget leak `pr-preview.yml` close-handling was designed to prevent.

## Refresh-staging runbook

The [`refresh-staging.yml`](../.github/workflows/refresh-staging.yml) workflow (AECI-77) restores prod data into the dev project's `main` branch (= staging), scrubs credentials, seeds test accounts, and redeploys staging Workers. It's the "give me realistic data" button. Trigger it from the GitHub Actions UI:

1. Repo → Actions → **refresh-staging** → **Run workflow** → branch `main` → **Run workflow**.
2. No inputs, no approval gate. The `staging-refresh` GH Environment is configured with no reviewers because the workflow is idempotent.
3. Concurrency group `refresh-staging` queues overlapping clicks rather than cancelling — a second press while the first is still running just waits, it does not stomp.

What happens, in order (each numbered step matches a job step in the workflow):

1. Checkout `main`.
2. Install pnpm, Node, PostgreSQL 17 client, Supabase CLI, generate Prisma client.
3. `pg_dump` prod (DIRECT_URL_PRODUCTION) into three artifacts: full public schema, auth-data-only, and `supabase_migrations.schema_migrations` history.
4. Wipe staging (`DROP SCHEMA public CASCADE`, truncate `auth.users`/`sessions`/`refresh_tokens`, truncate migration history).
5. `pg_restore` the three dumps into staging.
6. `supabase db push --linked --include-all` — applies any migration committed under `supabase/migrations/` that isn't yet in the migration-history table just restored from prod. This is the **only** moment staging schema can be ahead of prod schema.
7. `psql -f scripts/scrub-auth-credentials.sql` — nulls passwords + tokens for every `auth.users` row carried over from prod. Real users remain enumerable (so RLS / FKs work for debugging) but cannot authenticate.
8. `psql -f scripts/seed-staging-users.sql` — idempotent seed of four test accounts (chrisw, billh, reviewer, admin) with known passwords. See the SQL file for the credentials.
9. **Drift check (HARD STOP).** `scripts/prisma-drift-check.sh $DIRECT_URL_STAGING`. If staging's actual schema doesn't match `apps/api/prisma/schema.prisma`, the workflow exits before deploying Workers. This is the spec's "do not let an inconsistent staging hide from operators" rule.
10. Deploy `aeci-api-staging` then `aeci-web-staging` via `wrangler-action`, passing `--var COMMIT_SHA:${{ github.sha }} --var DEPLOYED_AT:<shared timestamp>` per the CLAUDE.md non-negotiable.
11. Smoke test `https://staging.aecintegrations.com/api/health` with Cloudflare Access headers; then via `scripts/verify-version.sh` poll until **both** `/api/version` (API Worker) and `/_version` (SSR Worker, AECI-92) report the workflow's commit SHA (60-second budget). `/api/version` is proxied raw to the API Worker, so on its own it can't catch a stale SSR deploy.
12. Job summary table: migrations applied, auth.users count, seeded-account count, commit SHA, actor, status.

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
| Smoke test (step 11) times out at 60s | Step 11 | Worker deploy completed but propagation lagging, or the Cloudflare Access service token (CF_ACCESS_CLIENT_ID/SECRET) rotated. Check `docs/access.md` §2. |
| `auth.users` count after step 8 is lower than expected | Step 4 wiped too much | Verify `auth.users CASCADE` didn't take out something else. Re-run the workflow — it's idempotent. |

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

## Promote runbook

The [`promote-to-prod.yml`](../.github/workflows/promote-to-prod.yml) workflow (AECI-78) is the only way prod gets new code. Trigger it from the GitHub Actions UI:

1. Repo → Actions → **promote-to-prod** → **Run workflow**.
2. `commit_sha`: paste the full 40-char SHA you already verified on staging (matches what `https://staging.aecintegrations.com/api/version` reports).
3. `confirm`: type `PROMOTE` exactly.
4. Click **Run workflow**.

What happens, in order:

- **Pre-promotion checks (unattended, ~2 min)** — `pre-promotion-checks` job. Validates `confirm`, then via `scripts/verify-version.sh` asserts the staging SHA matches `inputs.commit_sha` on **both** `staging.aecintegrations.com/api/version` (API Worker) and `/_version` (SSR Worker, AECI-92) with Cloudflare Access headers, refusing to continue unless both match. `/api/version` is proxied raw to the API Worker, so on its own it can't catch a stale SSR deploy. Then prints `supabase migration list --linked` against prod into the run log **and** the job summary so you can read the pending SQL inline before approving the next job.
- **Approval pause** — the `apply-prod-migrations` job enters the `production` GH Environment and blocks. The GitHub Actions UI shows "Waiting for review". Read the migration list in the previous job's summary before clicking Approve.
- **After approval (~5–10 min)** — `pg_dump` of prod → R2 (`aeci-prod-snapshots/prod-pre-<short-sha>.dump` plus a companion `-auth.dump` for auth-schema data), `supabase db push --linked`, drift check via `scripts/prisma-drift-check.sh` against `DIRECT_URL_PRODUCTION`. **HARD STOP on drift** — Workers don't deploy if drift is detected.
- **Worker deploys** — API first (`aeci-api-production`), SSR second (`aeci-web-production`). Each `wrangler deploy` line passes `--var COMMIT_SHA:${{ inputs.commit_sha }} --var DEPLOYED_AT:<shared timestamp>` per the CLAUDE.md non-negotiable.
- **Deploy marker + smoke** — Datadog `/api/v1/events` marker (docs/CICD_PLAN.md §9.1) tagged `env:production`, `service:aeci-ssr`, `commit:<sha>`. Then via `scripts/verify-version.sh` polls until **both** `https://demo.aecintegrations.com/api/version` (API Worker) and `/_version` (SSR Worker, AECI-92) report `sha: "<input>"` — public, so no Access headers. `/api/version` is proxied raw to the API Worker, so on its own it can't catch a stale SSR deploy. Fails after a 60-second budget.

**Recovering from a bad promote.** The R2 snapshot is the rollback insurance. For DB:

```bash
aws --endpoint-url "$R2_ENDPOINT" s3 cp s3://aeci-prod-snapshots/prod-pre-<short-sha>.dump .
pg_restore --clean --no-owner --no-privileges --dbname "$DIRECT_URL_PRODUCTION" prod-pre-<short-sha>.dump
```

For Worker code: `wrangler rollback --env production` against `apps/api` and `apps/web` (docs/CICD_PLAN.md §6.1). Snapshots live 30 days per the bucket lifecycle rule — older incidents require a Supabase point-in-time restore.

**Common failure modes:**

| Failure | Where | What it means / what to do |
| --- | --- | --- |
| `staging is not at <sha> on both Workers (API + SSR), refusing to promote` | `pre-promotion-checks` | Staging's `/api/version` (API Worker) and/or `/_version` (SSR Worker) don't match `inputs.commit_sha`; `scripts/verify-version.sh` logs the actual per-Worker SHAs. Either re-deploy staging on the target SHA or change the input. |
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

## Secrets

Secrets are stored in three places:
- **GitHub Actions secrets** (repo-level, used by `.github/workflows/*.yml`).
- **Cloudflare Worker secrets** (per Worker `name`, set via `wrangler secret put <KEY> --env <env>`; not visible in source).
- **Local `.dev.vars`** (per app, gitignored; mirrors a subset of Worker secrets for local dev).

| Secret | Staging Worker | Prod Worker | GH Actions | Notes |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` (staging Prisma Accelerate `prisma://…`) | ✅ on `aeci-{api}-staging` | ❌ | ✅ as `DATABASE_URL_STAGING` (CI tooling that needs raw access uses `DIRECT_URL_STAGING` instead) | Worker runtime path only. Never the pooler URL. Also the value to put in local `apps/api/.dev.vars` to run the API Worker locally — see "Local dev: running the API Worker". |
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
- [ ] Add `demo.aecintegrations.com` as the custom domain on `aeci-web-production` (Wrangler reconciles it on first prod promote; `custom_domain: true` provisions the DNS record + cert on the zone). The apex + `www` stay on the landing Worker.

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
  gh secret set DATABASE_URL_PRODUCTION --body "<prisma:// Accelerate URL>"
  gh secret set DIRECT_URL_PRODUCTION   --body "<postgresql://... pooler URL>"
  gh secret set SUPABASE_SERVICE_ROLE_KEY_PRODUCTION --body "<service role key>"
  ```
- [ ] **Datadog deploy-marker secret.** `gh secret set DATADOG_API_KEY --body "<key>"` (already exists for Worker runtime intake; CI needs its own copy to POST to `/api/v1/events`).
- [ ] **Production Worker secrets.** Run the same `wrangler secret put …` list from §6 against `--env production` from `apps/api/` and `apps/web/`.
- [ ] **Production project ref repo variable.** `gh variable set SUPABASE_PROD_PROJECT_REF --body "jgxebjufabtwkcgxjqvk"` (per §1).
- [ ] **Verify GH Environment.** The `production` GH Environment (created in §4) must list `chrisw@thewbsproject.com` as a required reviewer. Without that, the workflow's `apply-prod-migrations` job will not pause for approval.

Once all boxes are ticked, dry-run the workflow with a deliberately wrong `commit_sha` to verify the negative path: `pre-promotion-checks` must fail at step 4 with `staging is not at <input> on both Workers (API + SSR), refusing to promote` and the run must stop before any downstream job (acceptance criterion #2).

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
