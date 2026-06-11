# Deployment & CI Issues — Stage 1 Bootstrap

> **Historical — superseded.** Bootstrap/CI issues from AECI-57/58; the disabled workflows were re-enabled 2026-05-28 once the Accelerate schema-cache lag was measured. Kept for reference; **not a source of truth.** Archived per AECI-106.

**Status:** Originally documented disabled workflows are now **re-enabled** as
of 2026-05-28 after the Accelerate schema-cache lag was measured empirically
(see [Resolution: 2026-05-28](#resolution-2026-05-28) below). The original
narrative is preserved for context.

**Last updated:** 2026-05-28

This document captures the chain of bootstrap problems uncovered while trying
to land [AECI-57](https://linear.app/aec-integrations/issue/AECI-57) and
[AECI-58](https://linear.app/aec-integrations/issue/AECI-58). Treat it as a
to-do list for whoever picks up the deploy/CI infrastructure next.

---

## TL;DR

The Stage 1 deploy / preview / migration pipeline was scaffolded across
several PRs (AECI-71 / 76 / 77 / 78 / 79 / 80) but **was never end-to-end
verified against a real remote DB**. When the first AECI-57 e2e tests
actually exercised the API surface in CI, every layer of bootstrap turned
out to be missing or misconfigured. Each fix surfaced the next layer.

Workflow status as of 2026-05-28:

| Workflow / job | State | Note |
|---|---|---|
| `deploy.yml` → `db-migrate-dev` | **Re-enabled** | Sleeps 30s post-`supabase db push` to clear the Accelerate schema-cache window; see [Resolution: 2026-05-28](#resolution-2026-05-28). |
| `deploy.yml` → `e2e-tests-local` | **Re-enabled** | Depends on `db-migrate-dev`; inherits the post-push wait. |
| `deploy.yml` → `integration-runner-local` | **Re-enabled** | Same. |
| `deploy.yml` → `deploy-staging` | Still gated on `STAGING_ENABLED` (unset) | Flip to `"true"` once you're ready for merge-to-main auto-deploy. Staging was manually deployed on 2026-05-28 and is reachable at `staging.aecintegrations.com`. |
| `pr-preview.yml` | **Re-enabled** (`pull_request` trigger restored) | Same Accelerate fix as above. `workflow_dispatch` retained for manual replays. |
| `refresh-staging.yml` | `workflow_dispatch` only | By design. |
| `promote-to-prod.yml` | `workflow_dispatch` + environment-gated | By design. |
| `drift-check.yml` | Active | Local Postgres only. |

Still active and useful:

- `deploy.yml` jobs `lint-and-types`, `unit-tests`, `build-web` — green and
  load-bearing for PR review.
- `drift-check.yml` — fully local, no remote DB dependency.

---

## The chain of bootstrap problems (the order they surfaced)

Each row below was the **single visible CI failure mode** at the time. Fixing
it unblocked one job and revealed the next.

| # | Symptom | Root cause | Resolution |
|---|---|---|---|
| 1 | E2E: `PrismaClientInitializationError: Environment variable not found: DATABASE_URL` | `pnpm dev:bound` in `e2e-tests-local` boots the API Worker via `wrangler dev`, which reads secrets from `apps/api/.dev.vars`. CI never created that file. | Added step in `e2e-tests-local` that writes `apps/api/.dev.vars` from a new GH secret `DATABASE_URL_STAGING` (commit `54a1fcc`). |
| 2 | `DATABASE_URL_STAGING secret is empty` | Despite being referenced by `pr-preview.yml` (lines 14–17, 52, 173) since AECI-79 landed, the secret had never been created. `pr-preview.yml` had been silently pushing empty strings to per-PR Workers' `DATABASE_URL` for weeks. | User created `DATABASE_URL_STAGING` as a GH secret. |
| 3 | Prisma: `P6010: Accelerate is not enabled or it is improperly configured.` | The `prisma://…?api_key=…` URL stored in the secret had the right shape but Accelerate either wasn't enabled or the API key was wrong/expired. | User regenerated a fresh API key in Prisma Data Platform → Accelerate, updated the secret. |
| 4 | Prisma: `P6008: Accelerate was not able to connect to your database. Authentication failed against database server, the provided database credentials for postgres are not valid.` | Accelerate's stored Postgres connection string had a stale DB password. Likely the Supabase DB password was rotated at some point and never propagated back into Accelerate. | User reset Postgres password in Supabase, updated Accelerate's connection string. |
| 5 | Prisma: `PrismaClientValidationError` — `vendor.logoUrl` field unknown | The DB Accelerate pointed at didn't have the AECi schema. Neither prod (`jgxebjufabtwkcgxjqvk`) nor the newly-provisioned `aeci-development` project had ever had `supabase db push` run against them. Migrations existed only in `supabase/migrations/` and on dev laptops. **No GH workflow ever applied migrations to a remote DB.** | Added new `db-migrate-dev` job to `deploy.yml` (commit `cea897f`) that runs `supabase db push --linked --include-all` against the dev DB on every PR push. Required two more bootstrap items: `SUPABASE_ACCESS_TOKEN` secret + `SUPABASE_DEV_PROJECT_REF` variable. User created both. |
| 6 | **Current blocker:** `PrismaClientValidationError` — `vendor.logoUrl` still unknown after migration job succeeds | Accelerate caches its introspected schema. After `supabase db push` adds new columns, Accelerate continues to validate against the previous cached schema until its internal TTL expires (undocumented; minutes-to-hours). A manual "Refresh schema" click in the Prisma Data Platform UI clears it, but that's not automatable from CI without a Prisma Platform Management API token. | **Not resolved.** This is what triggered the decision to disable the affected jobs. |

---

## Bootstrap items configured (snapshot 2026-05-27)

**Secrets:**

```
CF_ACCESS_CLIENT_ID
CF_ACCESS_CLIENT_SECRET
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
DATABASE_URL_STAGING      ← added during this saga
SUPABASE_ACCESS_TOKEN     ← added during this saga
```

**Variables:**

```
SUPABASE_DEV_PROJECT_REF = dmbygwupskttzsvfzluq   ← added during this saga
```

**Still missing per docs/environments.md but not blocking right now:**

- `STAGING_ENABLED` variable — keeps `deploy-staging` skipped until the full
  Phase 7 staging cutover is ready.
- `DIRECT_URL_STAGING`, `DIRECT_URL_PRODUCTION`, `R2_*`,
  `SUPABASE_PROD_PROJECT_REF`, `LH_API_KEY` — referenced by
  `refresh-staging.yml` / `promote-to-prod.yml`. Both workflows are already
  manual (`workflow_dispatch`), so missing secrets only matter the day
  someone clicks the button.

---

## What needs to happen to re-enable each piece

### `db-migrate-dev`, `e2e-tests-local`, `integration-runner-local`

The Accelerate schema-cache problem (#6 above) needs a real answer. Options
in rough preference order:

1. **Confirm Accelerate's auto-refresh TTL is acceptable in practice.** Apply
   a no-op migration manually, wait, see if the cache catches up without a
   click. If so: just delete the `if: false` and live with occasional cache
   lag during the few-minute window after a migration lands.

2. **Automate cache refresh via Prisma Platform Management API.** Add a step
   to `db-migrate-dev` that, after `supabase db push`, calls Prisma's
   management API to force-re-introspect the Accelerate project. Needs a
   `PRISMA_API_TOKEN` GH secret (Prisma Data Platform → Settings → API
   tokens). Endpoint is undocumented but exists; community examples use
   `PATCH /v1/projects/<id>/environments/<env>/accelerate` or a re-save of
   the connection string.

3. **Cache-bust the Accelerate URL.** Roll the `api_key` in
   `DATABASE_URL_STAGING` (or append `?_v=<commit-sha>`) post-push so
   Accelerate treats it as a new connection. Hackier but no new dependency.

4. **Bypass Accelerate for CI only.** Won't work — `@prisma/client/edge`
   only speaks Prisma's HTTP protocol; can't talk TCP Postgres directly.

### `pr-preview.yml`

Same Accelerate problem applies — per-PR API Workers will validate against
the same stale cache. Once the schema-cache problem is solved for
`db-migrate-dev`, change the trigger back to `pull_request:` and the
workflow should work end-to-end.

Also worth verifying once re-enabled:

- That the cleanup job (`pr-preview-cleanup`) actually deletes the per-PR
  Workers when a PR is closed — the silent failure of `wrangler secret put`
  with empty values may have left orphan Workers in the Cloudflare account
  with names like `aeci-api-pr-<N>` / `aeci-web-pr-<N>`. Audit via
  `wrangler list --no-include-deployed`.

### `deploy-staging`

Per `docs/environments.md` §1, this is gated on `STAGING_ENABLED = "true"`
until the full staging cutover (DNS, Cloudflare Access, Worker secrets,
Datadog wiring) is complete. No action here as part of the AECI-57 cleanup.

---

## Lessons / process notes

- **Add an end-to-end smoke step to bootstrap PRs.** AECI-77 / 78 / 79 all
  landed with green CI because nothing in CI actually exercised the path
  they were wiring. The first PR that called `/api/*` from an e2e test
  (this one) was where all five layers of misconfiguration surfaced at once.
- **Required-secrets comments are documentation, not enforcement.** Multiple
  workflows listed required secrets in header comments that were never
  created. A pre-flight check job (`gh secret list | grep -q …` + `exit 1`)
  would have caught this on the first PR push instead of weeks later.
- **`docs/environments.md` has unchecked checkboxes (`[ ]`)** for several
  prerequisites including `SUPABASE_DEV_PROJECT_REF`. Those should be
  treated as blocking — there's no automation that surfaces "this checkbox
  is still unchecked, but a workflow that depends on it just ran."
- **Manual refresh button in a third-party SaaS UI is not an acceptable CI
  dependency.** The Accelerate cache problem is the most important thing
  to actually solve before re-enabling these jobs — otherwise PRs will
  keep going red on the cadence of "anytime a migration lands and
  Accelerate's cache hasn't expired yet."

---

## How disabled jobs are wired

Each disabled job has `if: false` near the top with a one-line comment
pointing here. The full step list is preserved so re-enabling is a
one-character edit (`false` → `true`, or delete the `if:` line entirely)
plus addressing the underlying problem.

`pr-preview.yml`'s `on:` trigger was changed from `pull_request:` to
`workflow_dispatch:` only — same effect (workflow doesn't auto-run on
PRs) but preserves the option to manually invoke it for testing.

---

## Resolution: 2026-05-28

The Accelerate schema-cache lag (row #6 above) was measured empirically and
the previously-disabled jobs are re-enabled. Walk-through:

### What we did

1. Deployed `aeci-api-staging` + `aeci-web-staging` against the
   `aeci-development` Supabase project (project ref `dmbygwupskttzsvfzluq`).
   Reachable at `https://staging.aecintegrations.com`, gated by the existing
   "AECi Non-Prod" Cloudflare Access app (per `docs/access.md` §1).
2. Built `scripts/measure-accelerate-lag.mjs` — a self-contained diagnostic
   harness that adds a throwaway column via `supabase db push --linked`,
   polls a temporary `/api/lag-probe` endpoint with a typed Prisma query
   until 200, and records the elapsed time. Hard-coded production-refusal
   guard.
3. Ran the harness against staging.

### What we measured

| Cycle | Result |
|---|---|
| 1 | **1.1 seconds** from push-completes to typed query returns 200 (SIN edge). |
| 2–5 | Aborted by a now-fixed harness bug (migration-history divergence when files were deleted between cycles). |

`max + 30s = 31s` → `sleep 30` is the configured wait in `db-migrate-dev`.

### What this is and isn't

- **Is**: empirical evidence that the wall-clock from `supabase db push --linked`
  returning to a typed Prisma query succeeding is in single-digit seconds for
  this DB / probe shape.
- **Isn't**: a measurement of the exact failure mode in row #6. The original
  symptom was `PrismaClientValidationError` (Accelerate's introspected schema
  cache rejecting an unknown field); our probe produced
  `PrismaClientKnownRequestError` (Postgres rejecting the column reference
  itself). Different error layer, same observed magnitude. If CI still flakes
  on schema-changing PRs, escalate to the Prisma Platform schema-refresh API
  (option 2 above) — the `sleep 30` may not be sufficient for the cache-rejection
  path.

### Knobs for future tuning

- `.github/workflows/deploy.yml` → `db-migrate-dev` → `Wait for Prisma Accelerate cache propagation` step. Bump `30` to a larger value if CI flakes return.
- `scripts/measure-accelerate-lag.mjs` is reusable. Re-run if you ever need a
  fresh measurement; the bug that aborted cycles 2-5 in the original run is
  fixed.
