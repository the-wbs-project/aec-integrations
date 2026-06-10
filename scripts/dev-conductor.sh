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
echo "▶ dev:conductor → http://localhost:8788  (API :8787)"
exec pnpm dev:bound
