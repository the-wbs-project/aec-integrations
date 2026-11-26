#!/usr/bin/env bash
# Manual deploy of the API Worker to one remote tier, migrations first (AECI-2069).
#
# CI is the normal deploy path (deploy.yml, refresh-staging.yml, promote-to-demo.yml,
# promote-to-prod.yml). This is the laptop fallback behind
# `pnpm --filter @aeci/api deploy:{staging,demo,production}`. It holds the same order CI
# holds: apply the tier's pending D1 migrations, prove none are left, then deploy. Code
# that pins an index with `INDEXED BY` (lib/seo-queue.ts) fails every query until the
# migration that creates the index has run. See docs/migrations.md §0 "Every path that
# deploys the API Worker".
#
# Three guards, each closing a way the old bare `wrangler deploy` script could go wrong:
#
#   1. Revision guard. The working tree must be clean and HEAD must already be merged
#      into origin/main. Migrations are forward-only, so applying a feature branch's
#      unmerged migration to a shared remote D1 cannot be undone by a Worker rollback
#      and can collide with the numbering `main` later lands. Clean also means the
#      COMMIT_SHA we report is the code we ship.
#   2. Migrate through scripts/d1-apply-migrations.sh, the helper CI uses.
#   3. Pending guard. `wrangler d1 migrations apply` exits 0 when the operator DECLINES
#      its confirmation prompt (wrangler 4.151: `if (!ok) return;`). So the exit code
#      cannot prove the schema is current. We re-read the remote ledger with
#      `wrangler d1 migrations list` and refuse to deploy unless it reports none pending.
#
# Usage (any cwd; the script moves to apps/api itself):
#   bash scripts/api-manual-deploy.sh <staging|demo|production>
#
# Exit codes: 0 deployed; 1 a guard refused or a command failed (nothing deployed).

set -euo pipefail

ENV_NAME="${1:-}"
case "$ENV_NAME" in
  staging) D1_DATABASE=aeci-app-staging ;;
  demo) D1_DATABASE=aeci-app-demo ;;
  production) D1_DATABASE=aeci-app-production ;;
  *)
    echo "error: usage: api-manual-deploy.sh <staging|demo|production> (got '${ENV_NAME}')" >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT/apps/api"

# 1. Revision guard.
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo "error: the working tree has uncommitted or untracked changes. Deploy only a committed revision that is merged into main." >&2
  exit 1
fi

if ! git fetch --quiet origin main; then
  echo "error: could not fetch origin/main, so the revision guard cannot run. Nothing deployed." >&2
  exit 1
fi

HEAD_SHA="$(git rev-parse HEAD)"
if ! git merge-base --is-ancestor "$HEAD_SHA" origin/main; then
  echo "error: HEAD ($HEAD_SHA) is not merged into origin/main. A manual deploy would apply its unmerged migrations to the shared ${D1_DATABASE}. Check out main (or a commit on it) and retry." >&2
  exit 1
fi

# 2. Migrate (+ reference seeds), with the CI helper's retry on transient D1 errors.
bash "$SCRIPT_DIR/d1-apply-migrations.sh" "$D1_DATABASE" "$ENV_NAME"

# 3. Pending guard. A declined prompt exits 0 above, so read the ledger back.
if ! LIST_OUT="$(pnpm exec wrangler d1 migrations list "$D1_DATABASE" --env "$ENV_NAME" --remote 2>&1)"; then
  printf '%s\n' "$LIST_OUT" >&2
  echo "error: could not read the migration ledger of ${D1_DATABASE}. Nothing deployed." >&2
  exit 1
fi
if ! printf '%s\n' "$LIST_OUT" | grep -q "No migrations to apply"; then
  printf '%s\n' "$LIST_OUT" >&2
  echo "error: ${D1_DATABASE} still has pending migrations (was the prompt declined?). Nothing deployed. Re-run and accept the prompt." >&2
  exit 1
fi

DEPLOYED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
pnpm exec wrangler deploy --env "$ENV_NAME" --var "COMMIT_SHA:${HEAD_SHA}" --var "DEPLOYED_AT:${DEPLOYED_AT}"
