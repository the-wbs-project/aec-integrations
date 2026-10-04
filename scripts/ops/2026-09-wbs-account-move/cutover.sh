#!/usr/bin/env bash
# AECI-1166: the cutover, one step per invocation, so it can stop between steps.
#
# Each step names the account its token must belong to. Export the right
# CLOUDFLARE_API_TOKEN before each one; the account id is pinned per step, so a
# token for the wrong account fails with an auth error instead of writing anywhere.
#
#   cutover.sh stop-old-crons ENV   OLD  empty the cron triggers on the old aeci-api-ENV
#   cutover.sh export ENV           OLD  export aeci-app-ENV, run the 3 prep scripts, test it locally
#   cutover.sh reset ENV            WBS  restore the WBS aeci-app-ENV to empty (only if it has tables)
#   cutover.sh import ENV           WBS  import the prepared dump, then compare every table's row count
#   cutover.sh bind ENV             WBS  full deploy of api + web: crons back on, custom domains bound
#   cutover.sh verify                    public checks on www, apex, demo and staging
#
# ENV is staging, demo or production. Order on the day: stop-old-crons, export,
# reset, import for each ENV; then the zone move (dashboard); then bind and verify.
set -euo pipefail

OLD_ACCOUNT=e62ec9d8012c3e0c225f8e4dbab76b79
WBS_ACCOUNT=004dc1af737b22a8aa83b3550fa9b9d3
# The WBS aeci-app-production was empty before this moment; the rehearsal import
# came after it. Only production was rehearsed, so only production needs a reset.
EMPTY_BEFORE="${EMPTY_BEFORE:-2026-10-01T01:00:00Z}"

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WRANGLER="$ROOT/apps/api/node_modules/.bin/wrangler"
WORK="$ROOT/.context/d1"
mkdir -p "$WORK"

step="${1:?usage: cutover.sh STEP [ENV]}"
env_name="${2:-}"
need_env() {
  case "$env_name" in staging|demo|production) ;; *) echo "ENV must be staging, demo or production" >&2; exit 1 ;; esac
}
# Run wrangler from an empty directory so no wrangler.jsonc pins an account.
scratch() { local d; d="$(mktemp -d)"; (cd "$d" && "$WRANGLER" "$@"); }

case "$step" in
  stop-old-crons)
    need_env
    # Clear the schedules through the API, not `wrangler triggers deploy`. That
    # command also syncs queue consumers from today's wrangler.jsonc, which names
    # queues created only on WBS (aeci-vendor-snapshot-*, AECI-1210), so it fails
    # against the old account. This call touches the cron schedules and nothing else.
    : "${CLOUDFLARE_API_TOKEN:?export the old-account token}"
    url="https://api.cloudflare.com/client/v4/accounts/$OLD_ACCOUNT/workers/scripts/aeci-api-$env_name/schedules"
    curl -sf -X PUT -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' --data '[]' "$url" >/dev/null
    left="$(curl -sf -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$url" |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.schedules.length))')"
    echo "old aeci-api-$env_name now has $left cron schedules"
    [ "$left" = "0" ]
    ;;

  export)
    need_env
    raw="$WORK/cutover-$env_name.sql"
    rm -f "$raw"
    CLOUDFLARE_ACCOUNT_ID=$OLD_ACCOUNT scratch d1 export "aeci-app-$env_name" --remote --output "$raw"
    python3 "$HERE/order-d1-export.py" "$raw" "$WORK/cutover-$env_name.1.sql"
    python3 "$HERE/split-long-statements.py" "$WORK/cutover-$env_name.1.sql" "$WORK/cutover-$env_name.2.sql"
    python3 "$HERE/order-by-fk.py" "$WORK/cutover-$env_name.2.sql" "$WORK/cutover-$env_name.final.sql"
    # Prove the prepared file loads with foreign keys checked per statement (as D1
    # does) and holds exactly what a plain load of the raw export holds.
    rm -f "$WORK/check-raw.db" "$WORK/check-final.db"
    sqlite3 "$WORK/check-raw.db" < "$raw"
    { echo "PRAGMA foreign_keys=ON;"; sed '/^PRAGMA defer_foreign_keys/d' "$WORK/cutover-$env_name.final.sql"; } | sqlite3 -bail "$WORK/check-final.db"
    a="$(sqlite3 "$WORK/check-raw.db" .dump | sort | shasum)"
    b="$(sqlite3 "$WORK/check-final.db" .dump | sort | shasum)"
    [ "$a" = "$b" ] || { echo "prepared dump differs from the raw export" >&2; exit 1; }
    sqlite3 "$WORK/check-final.db" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name" |
      while read -r t; do echo "$t $(sqlite3 "$WORK/check-final.db" "SELECT count(*) FROM \"$t\"")"; done > "$WORK/cutover-$env_name.counts"
    echo "ready: $WORK/cutover-$env_name.final.sql ($(wc -l < "$WORK/cutover-$env_name.counts" | tr -d ' ') tables)"
    ;;

  reset)
    need_env
    tables="$(CLOUDFLARE_ACCOUNT_ID=$WBS_ACCOUNT scratch d1 execute "aeci-app-$env_name" --remote --json \
      --command "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'" |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].results[0].n))')"
    if [ "$tables" = "0" ]; then echo "aeci-app-$env_name on WBS is already empty"; exit 0; fi
    echo "aeci-app-$env_name on WBS has $tables tables; restoring to before $EMPTY_BEFORE"
    CLOUDFLARE_ACCOUNT_ID=$WBS_ACCOUNT scratch d1 time-travel restore "aeci-app-$env_name" --timestamp "$EMPTY_BEFORE"
    ;;

  import)
    need_env
    final="$WORK/cutover-$env_name.final.sql"
    counts="$WORK/cutover-$env_name.counts"
    [ -f "$final" ] && [ -f "$counts" ] || { echo "run: cutover.sh export $env_name" >&2; exit 1; }
    CLOUDFLARE_ACCOUNT_ID=$WBS_ACCOUNT scratch d1 execute "aeci-app-$env_name" --remote --yes --file "$final"
    query="SELECT $(awk '{printf "%s(SELECT count(*) FROM \"%s\") AS \"%s\"", (NR>1?", ":""), $1, $1}' "$counts")"
    CLOUDFLARE_ACCOUNT_ID=$WBS_ACCOUNT scratch d1 execute "aeci-app-$env_name" --remote --json --command "$query" |
      COUNTS="$counts" node -e '
        let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
          const remote=JSON.parse(s)[0].results[0];
          const lines=require("fs").readFileSync(process.env.COUNTS,"utf8").trim().split("\n");
          let bad=0;
          for (const l of lines) { const [t,n]=l.split(" ");
            if (String(remote[t])!==n) { bad++; console.log(`MISMATCH ${t}: expected ${n}, WBS has ${remote[t]}`); } }
          console.log(bad ? `${bad} tables differ` : `all ${lines.length} tables match`);
          process.exit(bad ? 1 : 0);
        });'
    ;;

  bind)
    need_env
    sha="$(git -C "$ROOT" rev-parse HEAD)"
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    pnpm -C "$ROOT" --filter @aeci/web build
    (cd "$ROOT/apps/api" && CLOUDFLARE_ACCOUNT_ID=$WBS_ACCOUNT pnpm exec wrangler deploy --env "$env_name" --var "COMMIT_SHA:$sha" --var "DEPLOYED_AT:$now")
    (cd "$ROOT/apps/web" && CLOUDFLARE_ACCOUNT_ID=$WBS_ACCOUNT pnpm exec wrangler deploy --env "$env_name" --var "COMMIT_SHA:$sha" --var "DEPLOYED_AT:$now")
    ;;

  verify)
    for url in https://www.aecintegrations.com/_version https://aecintegrations.com/ https://demo.aecintegrations.com/_version https://staging.aecintegrations.com/; do
      printf '%-48s %s\n' "$url" "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$url")"
    done
    curl -s https://www.aecintegrations.com/_version; echo
    echo "expect: www 200 with this branch's sha, apex 301 to www, demo 200, staging 302 to the-wbs-project.cloudflareaccess.com"
    ;;

  *) echo "unknown step: $step" >&2; exit 1 ;;
esac
