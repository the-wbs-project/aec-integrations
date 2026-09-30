#!/usr/bin/env bash
# AECI-1163: deploy the api + web Workers for one environment to the WBS account,
# with no cron triggers and no custom-domain routes (see strip-config.mjs).
#
# The web Worker is served on workers.dev with ALLOW_INDEXING forced to "false",
# so a production copy on thewbsproject.workers.dev can never be indexed.
# The Access app for aeci-*.thewbsproject.workers.dev must exist BEFORE this runs.
#
# Usage: deploy-rehearsal.sh preview|staging|demo|production
set -euo pipefail

ENV_NAME="${1:?usage: deploy-rehearsal.sh preview|staging|demo|production}"
case "$ENV_NAME" in preview|staging|demo|production) ;; *) echo "unknown env: $ENV_NAME" >&2; exit 1 ;; esac

export CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
SHA="$(git -C "$ROOT" rev-parse HEAD)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STRIPPED=wrangler.wbs-rehearsal.json

cleanup() { rm -f "$ROOT/apps/api/$STRIPPED" "$ROOT/apps/web/$STRIPPED"; }
trap cleanup EXIT

echo "== build web"
pnpm -C "$ROOT" --filter @aeci/web build

echo "== api ($ENV_NAME)"
node "$HERE/strip-config.mjs" "$ROOT/apps/api/wrangler.jsonc" "$ROOT/apps/api/$STRIPPED"
(cd "$ROOT/apps/api" && pnpm exec wrangler deploy -c "$STRIPPED" --env "$ENV_NAME" \
  --var "COMMIT_SHA:$SHA" --var "DEPLOYED_AT:$NOW")

echo "== web ($ENV_NAME)"
node "$HERE/strip-config.mjs" "$ROOT/apps/web/wrangler.jsonc" "$ROOT/apps/web/$STRIPPED" --workers-dev
(cd "$ROOT/apps/web" && pnpm exec wrangler deploy -c "$STRIPPED" --env "$ENV_NAME" \
  --var "COMMIT_SHA:$SHA" --var "DEPLOYED_AT:$NOW" --var "ALLOW_INDEXING:false")
