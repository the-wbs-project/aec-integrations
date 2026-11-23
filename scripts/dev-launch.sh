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
# Retry on a lost race (AECI-2014): the API runs its local migrations for about a
# minute before wrangler binds, so a sibling workspace can take the chosen port in
# that gap. When wrangler then fails with "Address already in use", this script
# re-scans from the next pair up and relaunches, at most AECI_DEV_RETRIES times
# in total (default 3). The last "▶ dev:agent →" line printed is the live pair.
#
# Explicit pin still wins (skips the scan, never retries):
#   AECI_WEB_PORT=8900 AECI_API_PORT=8899 pnpm dev:agent
#
# Bash 3.2 compatible (macOS /bin/bash).
set -euo pipefail

cd "$(dirname "$0")/.."

MIN_WEB=8790 # 8788/8787 reserved for `dev:conductor`
MAX_WEB=8838 # 25 agent pairs of headroom
MAX_ATTEMPTS="${AECI_DEV_RETRIES:-3}"
LOG=".wrangler/dev-launch.log"

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# pick_pair START — set WEB/API to the first free pair with WEB >= START.
pick_pair() {
  WEB="$1"
  [ "$WEB" -lt "$MIN_WEB" ] && WEB="$MIN_WEB"
  while :; do
    API=$((WEB - 1))
    if ! port_busy "$WEB" && ! port_busy "$API"; then return 0; fi
    WEB=$((WEB + 2))
    if [ "$WEB" -gt "$MAX_WEB" ]; then
      echo "✘ dev:agent — no free SSR/API pair between ${MIN_WEB} and ${MAX_WEB}." >&2
      echo "  Check what's holding them: lsof -nP -iTCP -sTCP:LISTEN | grep workerd" >&2
      exit 1
    fi
  done
}

# Supabase's redirect allow-list holds only http://localhost:8788/** and
# http://localhost:8790/**. On any other port BOTH sign-in paths still *start*
# correctly and then land the browser on the Site URL (demo.aecintegrations.com)
# instead of back here — so the failure looks like "sign-in did nothing" with
# nothing logged locally and no error on screen. Warn at the one moment the port
# is chosen, rather than leaving it to be rediscovered.
warn_allowlist() {
  case "$WEB" in
    8788 | 8790) ;;
    *)
      echo "⚠ dev:agent — port ${WEB} is NOT in Supabase's redirect allow-list (only 8788 and 8790 are)." >&2
      echo "  Sign-in will complete and then redirect to demo.aecintegrations.com instead of localhost." >&2
      echo "  Free 8790, or add http://localhost:${WEB}/** in Supabase → Authentication → URL Configuration." >&2
      ;;
  esac
}

PINNED=""
if [ -n "${AECI_WEB_PORT:-}" ]; then
  # Caller pinned a port — respect it, don't scan, don't retry.
  PINNED=1
  WEB="$AECI_WEB_PORT"
  API="${AECI_API_PORT:-$((WEB - 1))}"
else
  pick_pair "$MIN_WEB"
fi

# Rebuild the web bundle + clear the local SSR cache before booting. `dev:preview`
# (what `dev:bound` runs) serves a *prebuilt* `dist/`, and the content `.md` files
# are inlined into that bundle at build time — so a stale `dist/` silently serves
# old content on every launch. Rebuilding here makes the launch reflect current
# source; clearing `.wrangler/state/v3/cache` drops persisted SSR edge-cache
# entries (that dir is Cache-API only — no D1/KV lives there).
# Set DEV_SKIP_BUILD=1 for a fast restart when the bundle is already current.
# Neither step depends on the port, so it runs once, not once per attempt.
if [ -z "${DEV_SKIP_BUILD:-}" ]; then
  echo "▶ dev:agent — rebuilding web bundle… (DEV_SKIP_BUILD=1 to skip)"
  pnpm --filter @aeci/web build
fi
rm -rf apps/web/.wrangler/state/v3/cache
mkdir -p "$(dirname "$LOG")"

# The stack runs as a background job in its own process group (`set -m`), so we
# can tell a bind failure apart and relaunch. That replaces the old `exec`, so
# forward termination signals to the whole group: otherwise Ctrl-C or Conductor's
# stop button would leave orphaned `workerd` processes squatting the pair.
CHILD=""
stop_child() {
  trap - INT TERM HUP
  if [ -n "$CHILD" ]; then
    kill -TERM -- "-$CHILD" 2>/dev/null || kill -TERM "$CHILD" 2>/dev/null || true
    wait "$CHILD" 2>/dev/null || true
  fi
  exit 130
}
trap stop_child INT TERM HUP
set -m

attempt=1
while :; do
  suffix=""
  [ "$attempt" -gt 1 ] && suffix="  (attempt ${attempt}/${MAX_ATTEMPTS})"
  echo "▶ dev:agent → SSR http://localhost:${WEB}  ·  API :${API} (proxied via http://localhost:${WEB}/api/*)${suffix}"
  warn_allowlist

  export AECI_WEB_PORT="$WEB"
  export AECI_API_PORT="$API"

  : >"$LOG"
  pnpm dev:bound > >(tee -a "$LOG") 2>&1 &
  CHILD=$!
  status=0
  wait "$CHILD" || status=$?
  CHILD=""
  sleep 0.2 # let tee flush the last lines into the log

  if [ "$status" -eq 0 ]; then exit 0; fi

  # Wrangler prints "Address already in use." (sometimes with "(host:port)").
  taken=$(grep -Eo 'Address already in use( \([^)]*\))?|EADDRINUSE' "$LOG" | head -n 1 || true)
  if [ -z "$taken" ]; then exit "$status"; fi

  if [ -n "$PINNED" ]; then
    echo "✘ dev:agent — pinned port is taken (${taken}). Unset AECI_WEB_PORT to auto-scan." >&2
    exit "$status"
  fi
  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    echo "✘ dev:agent — ${taken} on SSR :${WEB} / API :${API}; gave up after ${attempt} attempt(s)." >&2
    echo "  Check what's holding them: lsof -nP -iTCP -sTCP:LISTEN | grep workerd" >&2
    exit "$status"
  fi

  attempt=$((attempt + 1))
  echo "↻ dev:agent — ${taken} on SSR :${WEB} / API :${API} during boot; retrying from the next pair (attempt ${attempt}/${MAX_ATTEMPTS})" >&2
  pick_pair $((WEB + 2))
done
