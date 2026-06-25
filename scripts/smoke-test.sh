#!/usr/bin/env bash
# AECI-77: pluggable-HOST /api/health smoke test with Cloudflare Access
# service-token headers. Reused by sub-issue (c) promote-to-prod.yml.
#
# Per docs/access.md §1 and §5, every environment hostname — staging, PR
# previews, AND web prod (demo.aecintegrations.com, gated by Cloudflare Access
# until launch per ADR 0017) — is reachable from CI only via the
# `aeci-gh-actions` service token, so this script always attaches the headers
# and does NOT branch on host. At launch, dropping the prod Access app makes the
# headers a harmless no-op (they're ignored once the destination is public).
#
# Usage (env):
#   HOST                    https://staging.aecintegrations.com
#   CF_ACCESS_CLIENT_ID     service-token client id
#   CF_ACCESS_CLIENT_SECRET service-token client secret
#
# Exit codes:
#   0   /api/health returned 200
#   1   any other status (or connection failure)
#
# The script intentionally does not retry. Caller (the workflow) controls any
# polling/backoff so the timing budget is visible at the workflow level rather
# than buried in the script.

set -euo pipefail

: "${HOST:?HOST is required, e.g. https://staging.aecintegrations.com}"
: "${CF_ACCESS_CLIENT_ID:?CF_ACCESS_CLIENT_ID is required (Cloudflare Access service token)}"
: "${CF_ACCESS_CLIENT_SECRET:?CF_ACCESS_CLIENT_SECRET is required (Cloudflare Access service token)}"

BODY_FILE="$(mktemp -t smoke-test.XXXXXX)"
trap 'rm -f "$BODY_FILE"' EXIT

status=$(curl -sS \
  -o "$BODY_FILE" \
  -w '%{http_code}' \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  "$HOST/api/health")

if [ "$status" != "200" ]; then
  echo "::error::smoke-test: GET $HOST/api/health returned HTTP $status"
  echo "--- response body ---"
  cat "$BODY_FILE"
  echo "--- end response body ---"
  exit 1
fi

echo "smoke-test ok: $HOST/api/health -> 200"
cat "$BODY_FILE"
echo
