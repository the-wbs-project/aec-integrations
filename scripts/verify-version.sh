#!/usr/bin/env bash
# AECI-92: assert that BOTH Workers report EXPECTED_SHA at a given HOST.
#
#   /api/version  — proxied by the SSR Worker raw to the API Worker, so it only
#                   ever reports the *API* Worker's COMMIT_SHA.
#   /_version     — served by the SSR Worker itself; reports the *SSR* Worker's
#                   COMMIT_SHA.
#
# Polling /api/version alone (the old gate) passes even when the SSR
# `wrangler deploy` no-ops or ships a stale bundle. Checking both proves the
# whole site is at the commit being deployed/promoted.
#
# Like scripts/smoke-test.sh: this script does NOT retry. The caller (the
# workflow) owns any polling/backoff so the timing budget stays visible at the
# workflow level. A single mismatch prints a plain diagnostic and exits 1 (NOT
# a `::error::` annotation — that would spam one annotation per retry; the
# caller emits the single `::error::` after its budget is exhausted).
#
# Cloudflare Access (docs/access.md): every environment hostname — staging,
# PR-preview, AND production (gated until launch, ADR 0017) — sits behind Access
# and is reachable from CI only via the `aeci-gh-actions` service token. The
# service-token headers are attached only when both env vars are set; the caller
# now passes them for every environment (it is the presence of the vars, not the
# hostname, that decides). At launch, dropping the production Access app makes
# the prod vars a harmless no-op — no script change needed.
#
# Usage (env):
#   HOST                    https://staging.aecintegrations.com   (required)
#   EXPECTED_SHA            commit both Workers must report        (required)
#   CF_ACCESS_CLIENT_ID     service-token client id                (optional)
#   CF_ACCESS_CLIENT_SECRET service-token client secret            (optional)
#
# Exit codes:
#   0   both /api/version and /_version report EXPECTED_SHA
#   1   either endpoint is missing, unreachable, or reports a different SHA

set -euo pipefail

: "${HOST:?HOST is required, e.g. https://staging.aecintegrations.com}"
: "${EXPECTED_SHA:?EXPECTED_SHA is required (the commit both Workers must report)}"

# Attach Access service-token headers only when provided (every env is gated
# until launch; ADR 0017).
hdrs=()
if [ -n "${CF_ACCESS_CLIENT_ID:-}" ] && [ -n "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
  hdrs+=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID")
  hdrs+=(-H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
fi

# `${hdrs[@]+"${hdrs[@]}"}` expands to nothing for an empty array even under
# `set -u` (portable to bash 3.2 on macOS as well as bash 5 in CI). On any
# failure (non-2xx with -f, connection error, non-JSON body) the substitution
# returns non-zero and we record an empty SHA, which then fails the match.
api_sha="$(curl -fsS ${hdrs[@]+"${hdrs[@]}"} "$HOST/api/version" | jq -r '.sha // empty')" || api_sha=""
ssr_sha="$(curl -fsS ${hdrs[@]+"${hdrs[@]}"} "$HOST/_version" | jq -r '.sha // empty')" || ssr_sha=""

if [ "$api_sha" = "$EXPECTED_SHA" ] && [ "$ssr_sha" = "$EXPECTED_SHA" ]; then
  echo "verify-version ok @ $HOST: api=$api_sha ssr=$ssr_sha"
  exit 0
fi

echo "verify-version mismatch @ $HOST: expected=$EXPECTED_SHA api='$api_sha' ssr='$ssr_sha'"
exit 1
