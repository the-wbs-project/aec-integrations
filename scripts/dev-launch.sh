#!/usr/bin/env bash
#
# `pnpm dev:agent` — local dev launcher for Conductor *agent* workspaces.
#
# Boots the bound SSR + API Workers via `pnpm dev:bound`, automatically picking
# a free port pair so any number of agent workspaces can run in parallel without
# colliding. It deliberately starts scanning at SSR 8790 / API 8789 — the
# canonical 8788/8787 pair is reserved for the human's `pnpm dev:conductor`
# workspace, which must always launch on the same (button-linked) URL.
#
# So: `dev:conductor` is constant on 8788; every `dev:agent` lands on the next
# free pair above it (8790/8789, 8792/8791, …), no matter what's already up.
#
# Explicit pin still wins (skips the scan):
#   AECI_WEB_PORT=8900 AECI_API_PORT=8899 pnpm dev:agent
#
set -euo pipefail

cd "$(dirname "$0")/.."

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

if [ -n "${AECI_WEB_PORT:-}" ]; then
  # Caller pinned a port — respect it, don't scan.
  WEB="$AECI_WEB_PORT"
  API="${AECI_API_PORT:-$((WEB - 1))}"
else
  WEB=8790            # 8788/8787 reserved for `dev:conductor`
  MAX=8838            # 25 agent pairs of headroom
  while :; do
    API=$((WEB - 1))
    if ! port_busy "$WEB" && ! port_busy "$API"; then break; fi
    WEB=$((WEB + 2))
    if [ "$WEB" -gt "$MAX" ]; then
      echo "✘ dev:agent — no free SSR/API pair between 8790 and ${MAX}." >&2
      echo "  Check what's holding them: lsof -nP -iTCP -sTCP:LISTEN | grep workerd" >&2
      exit 1
    fi
  done
fi

echo "▶ dev:agent → SSR http://localhost:${WEB}  ·  API :${API} (proxied via http://localhost:${WEB}/api/*)"

export AECI_WEB_PORT="$WEB"
export AECI_API_PORT="$API"

# Rebuild the web bundle + clear the local SSR cache before booting. `dev:preview`
# (what `dev:bound` runs) serves a *prebuilt* `dist/`, and the content `.md` files
# are inlined into that bundle at build time — so a stale `dist/` silently serves
# old content on every launch. Rebuilding here makes the launch reflect current
# source; clearing `.wrangler/state/v3/cache` drops persisted SSR edge-cache
# entries (that dir is Cache-API only — no D1/KV lives there).
# Set DEV_SKIP_BUILD=1 for a fast restart when the bundle is already current.
if [ -z "${DEV_SKIP_BUILD:-}" ]; then
  echo "▶ dev:agent — rebuilding web bundle… (DEV_SKIP_BUILD=1 to skip)"
  pnpm --filter @aeci/web build
fi
rm -rf apps/web/.wrangler/state/v3/cache

exec pnpm dev:bound
