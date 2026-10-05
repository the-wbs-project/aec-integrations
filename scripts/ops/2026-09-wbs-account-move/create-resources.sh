#!/usr/bin/env bash
# AECI-1163: create every account-scoped AECi resource on The WBS Project account,
# then write the resulting ids to ids.json next to this script.
#
# Safe to re-run. Each resource is created only if it does not already exist.
# It never touches the old AEC Integrations account: the account id is pinned below.
# Needs a wrangler login (or CLOUDFLARE_API_TOKEN) with access to the WBS account.
set -euo pipefail

export CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
# Run wrangler from an empty directory. Inside apps/api the wrangler.jsonc pins the OLD
# account_id, so a stray config read could create resources on the wrong account.
WRANGLER="$ROOT/apps/api/node_modules/.bin/wrangler"
SCRATCH="$(mktemp -d)"; trap 'rm -rf "$SCRATCH"' EXIT
W() { (cd "$SCRATCH" && "$WRANGLER" "$@"); }

ENVS=(preview staging demo production)
QUEUE_ENVS=(staging demo production)
QUEUES=(algolia-sync algolia-drift stats reconcile data-quality attestation-notify cache-purge)

echo "== D1"
# Always pass a location. Without one, D1 picks a region near the caller, and the
# 2026-09-30 run put production in APAC (AECI-839). Production serves mostly US
# traffic, so it is enam. Demo, staging and preview stay apac on purpose
# (Chris, 2026-10-05).
# Production's live database is now aeci-app-production-us; see
# scripts/ops/2026-10-prod-d1-us-move. This loop would only re-create the old name.
d1_location() { case "$1" in production) echo enam ;; *) echo apac ;; esac; }
existing_d1="$(W d1 list --json)"
for e in "${ENVS[@]}"; do
  n="aeci-app-$e"
  if grep -q "\"$n\"" <<<"$existing_d1"; then echo "exists  $n"; else W d1 create "$n" --location="$(d1_location "$e")" >/dev/null && echo "created $n"; fi
done

echo "== KV"
existing_kv="$(W kv namespace list)"
for e in "${ENVS[@]}"; do
  for kind in taxonomy promote; do
    n="aeci-api-$kind-$e"
    if grep -q "\"$n\"" <<<"$existing_kv"; then echo "exists  $n"; else W kv namespace create "$n" >/dev/null && echo "created $n"; fi
  done
done

echo "== R2"
existing_r2="$(W r2 bucket list)"
for e in "${ENVS[@]}"; do
  n="aeci-uploads-$e"
  if grep -qE "name:[[:space:]]+$n\$" <<<"$existing_r2"; then echo "exists  $n"; else W r2 bucket create "$n" >/dev/null && echo "created $n"; fi
done

echo "== Queues"
existing_q="$(W queues list)"
for e in "${QUEUE_ENVS[@]}"; do
  for q in "${QUEUES[@]}"; do
    n="aeci-$q-$e"
    if grep -qE "(^|[^a-z-])$n([^a-z-]|\$)" <<<"$existing_q"; then echo "exists  $n"; else W queues create "$n" >/dev/null && echo "created $n"; fi
  done
done

echo "== ids.json"
D1_JSON="$(W d1 list --json)" KV_JSON="$(W kv namespace list)" node -e '
  const d1 = JSON.parse(process.env.D1_JSON);
  const kv = JSON.parse(process.env.KV_JSON);
  const out = { account_id: process.env.CLOUDFLARE_ACCOUNT_ID, d1: {}, kv: {} };
  for (const db of d1) if (db.name.startsWith("aeci-app-")) out.d1[db.name] = db.uuid;
  for (const ns of kv) if (ns.title.startsWith("aeci-api-")) out.kv[ns.title] = ns.id;
  console.log(JSON.stringify(out, null, 2));
' > "$HERE/ids.json"
cat "$HERE/ids.json"
