#!/usr/bin/env bash
#
# `pnpm dev:conductor` — the human's constant workspace. Always SSR 8788 / API 8787.
#
# Reclaims those two reserved ports if a stale or previous session is still
# holding them, then boots the bound dev stack pinned to them. Agents live on
# 8790+ (via `dev:agent`) with their own isolated wrangler registry, so the only
# thing ever found on 8788/8787 is a prior conductor session — safe to reclaim.
#
# Why reclaim: Conductor leaves orphaned `workerd` processes when a dev run is
# killed without a clean shutdown; without this they squat 8788/8787 and the
# next launch dies with "Address already in use". This makes the button "just work".
#
set -euo pipefail

cd "$(dirname "$0")/.."

for pp in "8788:SSR" "8787:API"; do
  port="${pp%%:*}"; label="${pp##*:}"
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "▶ dev:conductor — reclaiming ${label} :${port} (stale pids: $(echo "$pids" | tr '\n' ' '))"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
  fi
done
# brief pause so the OS releases the sockets before wrangler rebinds
sleep 1

export AECI_WEB_PORT=8788
export AECI_API_PORT=8787

# Rebuild the web bundle + clear the local SSR cache before booting. `dev:preview`
# (what `dev:bound` runs) serves a *prebuilt* `dist/`, and the legal/content `.md`
# files are inlined into that bundle at build time — so a stale `dist/` silently
# serves old content on every launch. Rebuilding here makes the launch reflect
# current source; clearing `.wrangler/state/v3/cache` drops any persisted SSR
# edge-cache entries (that dir is Cache-API only — no D1/KV lives there).
# Set DEV_SKIP_BUILD=1 for a fast restart when the bundle is already current.
if [ -z "${DEV_SKIP_BUILD:-}" ]; then
  echo "▶ dev:conductor — rebuilding web bundle… (DEV_SKIP_BUILD=1 to skip)"
  pnpm --filter @aeci/web build
fi
rm -rf apps/web/.wrangler/state/v3/cache

echo "▶ dev:conductor → http://localhost:8788  (API :8787)"
exec pnpm dev:bound
