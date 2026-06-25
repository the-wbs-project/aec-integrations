#!/usr/bin/env bash
# Assert that the API Worker's database connection is healthy at a given HOST.
#
#   /api/health — proxied by the SSR Worker raw to the API Worker. The handler
#                 runs `SELECT 1` through Prisma Accelerate and returns
#                 {"ok":true,"db":"ok"} (HTTP 200) on success, or
#                 {"ok":false,"db":"error",…} (HTTP 500) when the DB is
#                 unreachable — including the case where the API Worker shipped
#                 WITHOUT its `DATABASE_URL` secret ("Environment variable not
#                 found: DATABASE_URL"). That exact gap silently turned
#                 demo /categories into a 404 (blocking SSR resolver → API 500 →
#                 NotFound) while /products and /vendors stayed 200 (their
#                 httpResource data layer fails client-side, so the shell still
#                 renders). The version gate (verify-version.sh) can't catch it —
#                 /api/version reads vars, not the DB — so deploys/promotes pair
#                 this script with verify-version.sh.
#
# Companion to scripts/verify-version.sh: identical Cloudflare Access handling
# and the same NO-RETRY contract. The caller (the workflow) owns polling/backoff
# so the timing budget stays visible at the workflow level, and emits the single
# `::error::` annotation after its budget is exhausted (this script prints a
# plain diagnostic and exits 1, never `::error::`, to avoid one annotation per
# retry).
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
#   CF_ACCESS_CLIENT_ID     service-token client id                (optional)
#   CF_ACCESS_CLIENT_SECRET service-token client secret            (optional)
#
# Exit codes:
#   0   /api/health returns {"ok":true,"db":"ok"}
#   1   endpoint unreachable, non-2xx (e.g. 500 db:error), or unexpected body

set -euo pipefail

: "${HOST:?HOST is required, e.g. https://staging.aecintegrations.com}"

# Attach Access service-token headers only when provided (every env is gated
# until launch; ADR 0017).
hdrs=()
if [ -n "${CF_ACCESS_CLIENT_ID:-}" ] && [ -n "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
  hdrs+=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID")
  hdrs+=(-H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
fi

# `${hdrs[@]+"${hdrs[@]}"}` expands to nothing for an empty array even under
# `set -u` (portable to bash 3.2 on macOS as well as bash 5 in CI). `curl -fsS`
# exits non-zero on the 500 that /api/health returns when the DB is unreachable,
# so on any failure (non-2xx, connection error) the body is captured empty and
# the match below fails.
body="$(curl -fsS ${hdrs[@]+"${hdrs[@]}"} "$HOST/api/health")" || body=""
ok="$(printf '%s' "$body" | jq -r '.ok // empty' 2>/dev/null || true)"
db="$(printf '%s' "$body" | jq -r '.db // empty' 2>/dev/null || true)"

if [ "$ok" = "true" ] && [ "$db" = "ok" ]; then
  echo "verify-health ok @ $HOST: ok=$ok db=$db"
  exit 0
fi

# Re-fetch WITHOUT -f so the 500 body (which carries the Prisma error, e.g.
# "Environment variable not found: DATABASE_URL") surfaces in the diagnostic.
detail="$(curl -sS ${hdrs[@]+"${hdrs[@]}"} "$HOST/api/health" 2>/dev/null || true)"
echo "verify-health FAILED @ $HOST: ok='$ok' db='$db'"
if [ -n "$detail" ]; then
  echo "  /api/health body: $detail"
fi
exit 1
