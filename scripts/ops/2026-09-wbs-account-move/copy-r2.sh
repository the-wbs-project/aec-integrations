#!/usr/bin/env bash
# AECI-1166: copy every object in aeci-uploads-ENV from the old account to WBS.
#
#   copy-r2.sh ENV [--dry-run]
#
# Reads the old bucket with the old-account token in CLOUDFLARE_API_TOKEN (the
# Conductor default). Writes to WBS with your wrangler OAuth login, so the token
# is unset for the put. Idempotent: an object already on WBS with the same size
# is skipped, so it can run once before the freeze and again during it.
set -euo pipefail

OLD_ACCOUNT=e62ec9d8012c3e0c225f8e4dbab76b79
WBS_ACCOUNT=004dc1af737b22a8aa83b3550fa9b9d3
env_name="${1:?usage: copy-r2.sh ENV [--dry-run]}"
dry="${2:-}"
case "$env_name" in preview|staging|demo|production) ;; *) echo "ENV must be preview, staging, demo or production" >&2; exit 1 ;; esac
bucket="aeci-uploads-$env_name"
: "${CLOUDFLARE_API_TOKEN:?export the old-account token first}"

HERE="$(cd "$(dirname "$0")" && pwd)"
WRANGLER="$HERE/../../../apps/api/node_modules/.bin/wrangler"
OAUTH="$(grep '^oauth_token' "$HOME/Library/Preferences/.wrangler/config/default.toml" | cut -d'"' -f2)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# key<TAB>size<TAB>content-type, every page.
list() { # account token
  local cursor="" url
  while :; do
    url="https://api.cloudflare.com/client/v4/accounts/$1/r2/buckets/$bucket/objects?per_page=1000${cursor:+&cursor=$cursor}"
    curl -sf -H "Authorization: Bearer $2" "$url" > "$work/page.json"
    python3 - "$work/page.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for o in d["result"]:
    print(f'{o["key"]}\t{o["size"]}\t{(o.get("http_metadata") or {}).get("contentType", "")}')
PY
    cursor="$(python3 -c 'import json,sys; i=json.load(open(sys.argv[1])).get("result_info") or {}; print(i.get("cursor","") if i.get("is_truncated") else "")' "$work/page.json")"
    [ -n "$cursor" ] || break
  done
}

list "$OLD_ACCOUNT" "$CLOUDFLARE_API_TOKEN" > "$work/old.tsv"
list "$WBS_ACCOUNT" "$OAUTH" > "$work/wbs.tsv"
echo "$bucket: old has $(wc -l < "$work/old.tsv" | tr -d ' '), WBS has $(wc -l < "$work/wbs.tsv" | tr -d ' ')"

copied=0
while IFS=$'\t' read -r key size ctype; do
  if grep -qxF "$key"$'\t'"$size" <(cut -f1,2 "$work/wbs.tsv"); then continue; fi
  echo "copy $key ($size bytes${ctype:+, $ctype})"
  [ "$dry" = "--dry-run" ] && continue
  (cd "$work" && CLOUDFLARE_ACCOUNT_ID=$OLD_ACCOUNT "$WRANGLER" r2 object get "$bucket/$key" --remote --file obj >/dev/null)
  (cd "$work" && env -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=$WBS_ACCOUNT "$WRANGLER" r2 object put "$bucket/$key" --remote --file obj ${ctype:+--content-type "$ctype"} >/dev/null)
  copied=$((copied + 1))
done < "$work/old.tsv"

[ "$dry" = "--dry-run" ] && exit 0
list "$WBS_ACCOUNT" "$OAUTH" | cut -f1,2 | sort > "$work/wbs-after.tsv"
cut -f1,2 "$work/old.tsv" | sort > "$work/old-sorted.tsv"
missing="$(comm -23 "$work/old-sorted.tsv" "$work/wbs-after.tsv" | wc -l | tr -d ' ')"
echo "copied $copied; missing on WBS after copy: $missing"
[ "$missing" = "0" ]
