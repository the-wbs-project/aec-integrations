#!/usr/bin/env bash
# Purge cache tags on a deployed SSR Worker via `POST /admin/purge`
# (AECI-56 / docs/CACHE_STRATEGY.md §5).
#
# Used by the deploy workflows after the taxonomy reference-data seed
# (apps/api/seed/taxonomy.sql, applied via `wrangler d1 execute`) reconciles the
# `taxonomy_*` vocabulary directly in D1. That write bypasses the app's normal purge path, so the
# edge keeps serving the old vocabulary until TTL (≤5 min browse, ≤1 hr nav)
# unless we purge explicitly here. See docs/adr/0008-taxonomy-reference-data.md.
#
# Like smoke-test.sh: staging, PR previews, AND prod (prod.aecintegrations.com,
# gated by Cloudflare Access until launch per ADR 0017) are reachable from CI only
# via the `aeci-gh-actions` service token, so we always attach the headers and
# never branch on host. The public demo tier (demo.aecintegrations.com) ignores
# them; at the prod launch, dropping the prod Access app makes the headers a
# harmless no-op there too (they're ignored once the destination is public).
#
# Usage (env):
#   HOST                    https://prod.aecintegrations.com
#   PURGE_TAGS              space-separated tag list, e.g. "taxonomy route:browse"
#   ADMIN_PURGE_TOKEN       Bearer token (SSR Worker `ADMIN_PURGE_TOKEN` secret)
#   CF_ACCESS_CLIENT_ID     service-token client id
#   CF_ACCESS_CLIENT_SECRET service-token client secret
#
# Exit codes:
#   0   /admin/purge returned 200 (all tags purged)
#   1   any other status (or connection failure)
#
# Callers should treat a non-zero exit as non-fatal for a release: a failed
# purge falls back to TTL-bounded self-healing, not stale-forever. Wire the
# workflow step with `continue-on-error: true`.

set -euo pipefail

: "${HOST:?HOST is required, e.g. https://prod.aecintegrations.com}"
: "${PURGE_TAGS:?PURGE_TAGS is required, e.g. \"taxonomy route:browse\"}"
: "${ADMIN_PURGE_TOKEN:?ADMIN_PURGE_TOKEN is required (SSR Worker bearer secret)}"
: "${CF_ACCESS_CLIENT_ID:?CF_ACCESS_CLIENT_ID is required (Cloudflare Access service token)}"
: "${CF_ACCESS_CLIENT_SECRET:?CF_ACCESS_CLIENT_SECRET is required (Cloudflare Access service token)}"

# Build `{ "tags": [...] }` from the whitespace-separated list. Unquoted $PURGE_TAGS
# word-splits on IFS; `jq -R . | jq -cs '{tags: .}'` turns each line into a JSON
# string and slurps them into the array.
# shellcheck disable=SC2086
BODY="$(printf '%s\n' $PURGE_TAGS | jq -R . | jq -cs '{tags: .}')"

BODY_FILE="$(mktemp -t purge-cache.XXXXXX)"
trap 'rm -f "$BODY_FILE"' EXIT

status=$(curl -sS \
  -o "$BODY_FILE" \
  -w '%{http_code}' \
  -X POST \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  -H "Authorization: Bearer $ADMIN_PURGE_TOKEN" \
  -H 'content-type: application/json' \
  --data "$BODY" \
  "$HOST/admin/purge?source=ci-taxonomy-seed")

if [ "$status" != "200" ]; then
  hint=''
  case "$status" in
    401) hint=" The Worker's ADMIN_PURGE_TOKEN secret is missing or differs from the GH secret this script presented — check 'wrangler secret list --env <env>' from apps/web and confirm the 'Push cache-purge credentials to web Worker' step ran BEFORE this one (docs/CACHE_STRATEGY.md §5a)." ;;
    502) hint=" Auth passed but the Cloudflare purge call failed — usually a missing/mis-scoped CF_PURGE_API_TOKEN or CF_ZONE_ID on the Worker (token must be Zone.Cache Purge on aecintegrations.com)." ;;
    403) hint=" Cloudflare Access rejected the request — the CF_ACCESS_* service token may be expired or removed from the app's policy (docs/access.md)." ;;
  esac
  echo "::warning::purge-cache: POST $HOST/admin/purge returned HTTP $status (tags: $PURGE_TAGS). Cache will self-heal at TTL; not blocking the release.${hint}"
  echo "--- response body ---"
  cat "$BODY_FILE"
  echo "--- end response body ---"
  exit 1
fi

echo "purge-cache ok: $HOST/admin/purge -> 200 (tags: $PURGE_TAGS)"
cat "$BODY_FILE"
echo
