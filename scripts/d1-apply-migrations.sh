#!/usr/bin/env bash
# Apply the app DB's D1 migrations + reconcile the reference-data seeds to a
# REMOTE D1 database, retrying on transient Cloudflare D1 API failures.
#
# WHY THIS EXISTS. The remote D1 query API intermittently returns a server-side
# "internal error" (`[code: 7500]`, e.g. `reference = e_...`) that has nothing to
# do with the SQL being applied. A single such blip on any one of the three
# commands below otherwise aborts the whole deploy with the D1 schema step never
# reaching the Worker deploy — observed on promote-to-demo run 28671935011, where
# `wrangler d1 migrations apply aeci-app-demo --remote` failed with
# `internal error; reference = e_PVSMDp_... [code: 7500]` on migrations that had
# already applied cleanly to staging. Retrying transparently absorbs the blip.
#
# WHY BLANKET RETRY IS SAFE. Every command here is idempotent:
#   - `wrangler d1 migrations apply` is a tracked no-op once a migration is
#     applied (it consults the d1_migrations bookkeeping table), so re-running
#     only applies what is still pending.
#   - Both seeds are idempotent UPSERTs keyed on deterministic UUIDv5(slug) ids
#     (apps/api/seed/taxonomy.sql, apps/api/seed/data-objects.sql), so re-running
#     converges to the same rows and never duplicates or deletes.
# So we retry on ANY non-zero exit rather than pattern-matching Cloudflare's
# error strings (which drift across wrangler versions). A genuinely broken
# migration still fails — just after exhausting the (small) attempt budget.
#
# Companion to the other CI shell gates in this dir (require-secrets.sh,
# verify-version.sh, verify-health.sh). Used by the "Apply D1 migrations" step of
# deploy.yml (staging), promote-to-demo.yml (demo), and promote-to-prod.yml
# (production). See docs/migrations.md §0 and docs/CICD_PLAN.md.
#
# Usage (must run with cwd = apps/api, where wrangler.jsonc + migrations/ + seed/
# resolve — the CI steps set `working-directory: apps/api`):
#   bash "$GITHUB_WORKSPACE/scripts/d1-apply-migrations.sh" <d1-database> <env>
#   D1_DATABASE=aeci-app-demo D1_ENV=demo bash scripts/d1-apply-migrations.sh
#
# Tunables (env, optional):
#   D1_MAX_ATTEMPTS        total attempts per command (default 5)
#   D1_RETRY_BASE_SECONDS  linear backoff base; sleep = base * attempt (default 5)
#
# Exit codes:
#   0   every command succeeded (possibly after retries)
#   1   a command still failed after D1_MAX_ATTEMPTS, or bad arguments

set -euo pipefail

D1_DATABASE="${1:-${D1_DATABASE:-}}"
D1_ENV="${2:-${D1_ENV:-}}"

if [ -z "$D1_DATABASE" ] || [ -z "$D1_ENV" ]; then
  echo "::error::usage: d1-apply-migrations.sh <d1-database> <env> (or set D1_DATABASE / D1_ENV)" >&2
  exit 1
fi

D1_MAX_ATTEMPTS="${D1_MAX_ATTEMPTS:-5}"
D1_RETRY_BASE_SECONDS="${D1_RETRY_BASE_SECONDS:-5}"

# Run a wrangler d1 invocation, retrying on any failure (idempotent — see header).
run_with_retry() {
  local attempt=1
  while true; do
    if "$@"; then
      return 0
    fi
    if [ "$attempt" -ge "$D1_MAX_ATTEMPTS" ]; then
      echo "::error::\`$*\` still failing after ${D1_MAX_ATTEMPTS} attempts — giving up." >&2
      return 1
    fi
    local sleep_for=$(( D1_RETRY_BASE_SECONDS * attempt ))
    echo "::warning::attempt ${attempt}/${D1_MAX_ATTEMPTS} of \`$*\` failed (often a transient Cloudflare D1 [code: 7500] internal error). Retrying in ${sleep_for}s..." >&2
    sleep "$sleep_for"
    attempt=$(( attempt + 1 ))
  done
}

run_with_retry pnpm exec wrangler d1 migrations apply "$D1_DATABASE" --env "$D1_ENV" --remote
run_with_retry pnpm exec wrangler d1 execute "$D1_DATABASE" --env "$D1_ENV" --remote --file=seed/taxonomy.sql
run_with_retry pnpm exec wrangler d1 execute "$D1_DATABASE" --env "$D1_ENV" --remote --file=seed/data-objects.sql
