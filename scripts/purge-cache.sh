#!/usr/bin/env bash
# Purge cache tags on a deployed SSR Worker via `POST /admin/purge`
# (AECI-56 / docs/CACHE_STRATEGY.md §5).
#
# Used by the deploy workflows after the taxonomy reference-data seed
# (supabase/reference-data/taxonomy.sql) reconciles the `taxonomy_*` vocabulary
# directly in Postgres. That write bypasses the app's normal purge path, so the
# edge keeps serving the old vocabulary until TTL (≤5 min browse, ≤1 hr nav)
# unless we purge explicitly here. See docs/adr/0008-taxonomy-reference-data.md.
#
# Like smoke-test.sh: every environment hostname — staging, PR previews, AND
# web prod (demo.aecintegrations.com, gated by Cloudflare Access until launch
# per ADR 0017) — is reachable from CI only via the `aeci-gh-actions` service
# token, so we always attach the headers and never branch on host. At launch,
# dropping the prod Access app makes the headers a harmless no-op (they're
# ignored once the destination is public).
#
# Usage (env):
#   HOST                    https://demo.aecintegrations.com
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

: "${HOST:?HOST is required, e.g. https://demo.aecintegrations.com}"
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
  echo "::warning::purge-cache: POST $HOST/admin/purge returned HTTP $status (tags: $PURGE_TAGS). Cache will self-heal at TTL; not blocking the release."
  echo "--- response body ---"
  cat "$BODY_FILE"
  echo "--- end response body ---"
  exit 1
fi

echo "purge-cache ok: $HOST/admin/purge -> 200 (tags: $PURGE_TAGS)"
cat "$BODY_FILE"
echo
