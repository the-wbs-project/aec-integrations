#!/usr/bin/env bash
# AECI-839: move the production D1 from APAC to ENAM.
#
# D1 cannot be relocated, so the data is copied into a second database that was
# created with --location=enam, and the production bindings are pointed at it.
# One step per invocation, so the operator can stop between steps.
#
#   move.sh export     read the live aeci-app-production, prepare an importable dump, prove it locally
#   move.sh import     reset aeci-app-production-us to empty, import the dump, compare row counts to the dump
#   move.sh verify     old vs new: every table's row count, d1_migrations, sqlite_sequence, schema, FK check
#   move.sh verify --strict   the same, but any old-vs-new row-count difference fails (writes must be frozen)
#   move.sh latency    time a representative read against both databases from this machine
#   move.sh region     today's D1 analytics (servedByRegion, queries) for both databases
#   move.sh pause-crons    CUTOVER ONLY: save, then empty, the cron schedules of aeci-api-production
#   move.sh resume-crons   put the saved schedules back (only needed if the cutover is abandoned;
#                          the promote-to-prod deploy restores them from wrangler.jsonc)
#   move.sh checklist  print the cutover order
#
# Every step pins the WBS account and runs wrangler from an empty directory, so
# no repo wrangler.jsonc can redirect it. It uses the wrangler OAuth login. The
# environment's CLOUDFLARE_API_TOKEN reaches only the old AEC account, so it is
# unset for every call.
#
# The only database this script ever writes is aeci-app-production-us, and only
# in `import`. `import` refuses to reset that database once it holds rows newer
# than the dump, because from then on it is the live production database.
# `pause-crons` and `resume-crons` change the production API Worker's cron
# schedules and nothing else. They are for the cutover window only.
set -euo pipefail

ACCOUNT=004dc1af737b22a8aa83b3550fa9b9d3
OLD_DB=aeci-app-production
OLD_ID=3bbbd4ca-4907-41c1-9f76-7d7241ca2b8f
NEW_DB=aeci-app-production-us
NEW_ID=1f4378db-dabb-4724-b5b8-d0a9ab6c6a3b
# Time-travel bookmark of NEW_DB right after `wrangler d1 create` (2026-10-05). Empty.
# D1 keeps 30 days of time travel, so this bookmark stops working around 2026-11-04.
# After that, reset by dropping the tables instead, or create a fresh database.
EMPTY_BOOKMARK=00000001-00000000-000050fb-b04f29e2520df14726bfe056c40231e1

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
PREP="$ROOT/scripts/ops/2026-09-wbs-account-move"
WRANGLER="$ROOT/apps/api/node_modules/.bin/wrangler"
WORK="$ROOT/.context/d1-us-move"
mkdir -p "$WORK"

RAW="$WORK/prod.sql"
FINAL="$WORK/prod.final.sql"
COUNTS="$WORK/prod.counts"
CHECK_DB="$WORK/check-final.db"

W() {
  local d; d="$(mktemp -d)"
  (cd "$d" && CLOUDFLARE_ACCOUNT_ID=$ACCOUNT env -u CLOUDFLARE_API_TOKEN "$WRANGLER" "$@")
  rm -rf "$d"
}
# Run one read query; print the first result set as JSON.
q() {
  W d1 execute "$1" --remote --json --command "$2" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s)[0].results)))'
}
stamp() { date -u +%H:%M:%S; }
timed() {
  local label="$1"; shift
  local t0; t0=$(date +%s)
  "$@"
  echo "TIMING $label $(( $(date +%s) - t0 ))s" | tee -a "$WORK/timings.log"
}
# Refuse to run if a name resolves to an unexpected id.
check_ids() {
  local got
  got="$(W d1 info "$OLD_DB" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.uuid+" "+j.running_in_region)})')"
  [ "${got%% *}" = "$OLD_ID" ] || { echo "$OLD_DB resolved to ${got%% *}, expected $OLD_ID" >&2; exit 1; }
  echo "old $OLD_DB $got"
  got="$(W d1 info "$NEW_DB" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.uuid+" "+j.running_in_region)})')"
  [ "${got%% *}" = "$NEW_ID" ] || { echo "$NEW_DB resolved to ${got%% *}, expected $NEW_ID" >&2; exit 1; }
  echo "new $NEW_DB $got"
}

do_export() {
  rm -f "$RAW" "$FINAL" "$COUNTS" "$CHECK_DB" "$WORK/check-raw.db"
  echo "$(stamp) exporting $OLD_DB"
  timed export-remote W d1 export "$OLD_DB" --remote --output "$RAW"
  # The three prep scripts from the account move (AECI-1166). Each is explained in its header.
  python3 "$PREP/order-d1-export.py" "$RAW" "$WORK/prod.1.sql"
  python3 "$PREP/split-long-statements.py" "$WORK/prod.1.sql" "$WORK/prod.2.sql"
  python3 "$PREP/order-by-fk.py" "$WORK/prod.2.sql" "$FINAL"
  # The dump must hold only tables and indexes. A view, trigger or virtual table
  # would need its own handling, so stop and look if one appears.
  if grep -qE '^CREATE (VIEW|TRIGGER|VIRTUAL TABLE)' "$FINAL"; then
    echo "the dump contains a view, trigger or virtual table; handle it before importing" >&2; exit 1
  fi
  if grep -qE '^(INSERT INTO|CREATE TABLE) "?_cf_' "$FINAL"; then
    echo "the dump contains a _cf_ internal table; D1 rejects writes to it" >&2; exit 1
  fi
  # Prove the prepared file loads with foreign keys checked per statement (as D1
  # does) and holds exactly what a plain load of the raw export holds.
  sqlite3 "$WORK/check-raw.db" < "$RAW"
  { echo "PRAGMA foreign_keys=ON;"; sed '/^PRAGMA defer_foreign_keys/d' "$FINAL"; } | sqlite3 -bail "$CHECK_DB"
  a="$(sqlite3 "$WORK/check-raw.db" .dump | sort | shasum)"
  b="$(sqlite3 "$CHECK_DB" .dump | sort | shasum)"
  [ "$a" = "$b" ] || { echo "prepared dump differs from the raw export" >&2; exit 1; }
  sqlite3 "$CHECK_DB" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name" |
    while read -r t; do echo "$t $(sqlite3 "$CHECK_DB" "SELECT count(*) FROM \"$t\"")"; done > "$COUNTS"
  echo "migrations in dump: $(sqlite3 "$CHECK_DB" 'SELECT count(*) || " rows, last " || max(name) FROM d1_migrations')"
  echo "ready: $FINAL ($(wc -l < "$COUNTS" | tr -d ' ') tables, $(du -h "$FINAL" | cut -f1))"
}

# One SELECT with a scalar subquery per table. Not a compound SELECT, so D1's
# five-term cap does not apply.
count_query() {
  echo "SELECT $(awk '{printf "%s(SELECT count(*) FROM \"%s\") AS \"%s\"", (NR>1?", ":""), $1, $1}' "$COUNTS")"
}

do_import() {
  [ -f "$FINAL" ] && [ -f "$COUNTS" ] || { echo "run: move.sh export" >&2; exit 1; }
  check_ids
  local tables
  tables="$(q "$NEW_DB" "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].n))')"
  if [ "$tables" != "0" ]; then
    # Live guard. Crons write job_runs and visitors write page_views. If the new
    # database holds a higher id in either than the dump, it has taken live writes
    # and is production. Never reset it then.
    local dump_max new_max have
    # A database without both tables (a failed partial import) cannot be live.
    have="$(q "$NEW_DB" "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('job_runs','page_views')" |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].n))')"
    dump_max="$(sqlite3 "$CHECK_DB" "SELECT coalesce((SELECT max(id) FROM job_runs),0) || ' ' || coalesce((SELECT max(id) FROM page_views),0)")"
    new_max="0 0"
    [ "$have" = "2" ] && new_max="$(q "$NEW_DB" "SELECT coalesce((SELECT max(id) FROM job_runs),0) AS j, coalesce((SELECT max(id) FROM page_views),0) AS p" |
      node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s)[0];console.log(r.j+" "+r.p)})')"
    if [ "${new_max% *}" -gt "${dump_max% *}" ] || [ "${new_max#* }" -gt "${dump_max#* }" ]; then
      echo "REFUSING: $NEW_DB has job_runs/page_views ids ($new_max) above the dump ($dump_max). It is live." >&2
      exit 1
    fi
    echo "$(stamp) $NEW_DB has $tables tables (rehearsal copy); restoring to the empty bookmark"
    timed reset W d1 time-travel restore "$NEW_DB" --bookmark "$EMPTY_BOOKMARK"
  fi
  echo "$(stamp) importing into $NEW_DB"
  timed import-remote W d1 execute "$NEW_DB" --remote --yes --file "$FINAL"
  W d1 execute "$NEW_DB" --remote --json --command "$(count_query)" |
    COUNTS="$COUNTS" node -e '
      let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
        const remote=JSON.parse(s)[0].results[0];
        const lines=require("fs").readFileSync(process.env.COUNTS,"utf8").trim().split("\n");
        let bad=0;
        for (const l of lines) { const [t,n]=l.split(" ");
          if (String(remote[t])!==n) { bad++; console.log(`MISMATCH ${t}: dump ${n}, new ${remote[t]}`); } }
        console.log(bad ? `${bad} tables differ from the dump` : `all ${lines.length} tables match the dump`);
        process.exit(bad ? 1 : 0);
      });'
}

do_verify() {
  local strict="${1:-}"
  [ -f "$COUNTS" ] || { echo "run: move.sh export" >&2; exit 1; }
  check_ids
  local cq tq mq sq fq
  cq="$(count_query)"
  tq="SELECT group_concat(type || ' ' || name || ' ' || coalesce(sql,''), char(10)) AS s FROM (SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name)"
  mq="SELECT count(*) AS n, group_concat(id || ':' || name, ',') AS s FROM (SELECT id, name FROM d1_migrations ORDER BY id)"
  sq="SELECT group_concat(name || '=' || seq, ',') AS s FROM (SELECT name, seq FROM sqlite_sequence ORDER BY name)"
  fq="PRAGMA foreign_key_check"
  local t0; t0=$(date +%s)
  q "$OLD_DB" "$cq" > "$WORK/old.counts.json"
  q "$NEW_DB" "$cq" > "$WORK/new.counts.json"
  q "$OLD_DB" "$tq" > "$WORK/old.schema.json"
  q "$NEW_DB" "$tq" > "$WORK/new.schema.json"
  q "$OLD_DB" "$mq" > "$WORK/old.migrations.json"
  q "$NEW_DB" "$mq" > "$WORK/new.migrations.json"
  q "$OLD_DB" "$sq" > "$WORK/old.sequence.json"
  q "$NEW_DB" "$sq" > "$WORK/new.sequence.json"
  q "$NEW_DB" "$fq" > "$WORK/new.fkcheck.json"
  echo "TIMING verify-queries $(( $(date +%s) - t0 ))s" | tee -a "$WORK/timings.log"
  STRICT="$strict" WORK="$WORK" COUNTS="$COUNTS" node -e '
    const fs=require("fs"), w=process.env.WORK, rd=f=>JSON.parse(fs.readFileSync(`${w}/${f}`,"utf8"));
    const strict=process.env.STRICT==="--strict";
    let fail=0;
    const dump=Object.fromEntries(fs.readFileSync(process.env.COUNTS,"utf8").trim().split("\n").map(l=>l.split(" ")));
    const oc=rd("old.counts.json")[0], nc=rd("new.counts.json")[0];
    // Visitor log tables keep taking writes during a freeze (anonymous page views). Losing the
    // rows written between export and deploy is accepted (README "Writes lost"), so strict mode
    // reports old-side growth in these tables without failing on it.
    const VISITOR=new Set(["page_views","user_activity_daily"]);
    let newVsDump=0, drift=[], visitorDrift=[];
    for (const t of Object.keys(dump).sort()) {
      if (String(nc[t])!==dump[t]) { newVsDump++; console.log(`NEW != DUMP  ${t}: dump ${dump[t]}, new ${nc[t]}`); }
      if (oc[t]!==nc[t]) {
        const line=`${t}: old ${oc[t]}, new ${nc[t]} (${oc[t]-nc[t]>0?"+":""}${oc[t]-nc[t]} on old)`;
        (VISITOR.has(t) && oc[t]>nc[t] ? visitorDrift : drift).push(line);
      }
    }
    if (visitorDrift.length) {
      console.log(`info ${visitorDrift.length} visitor log tables grew on old since the export (accepted loss):`);
      for (const d of visitorDrift) console.log(`       ${d}`);
    }
    console.log(newVsDump ? `FAIL ${newVsDump} tables differ from the dump` : `ok   all ${Object.keys(dump).length} tables match the dump`);
    fail+=newVsDump;
    if (drift.length) {
      console.log(`${strict?"FAIL":"info"} ${drift.length} tables differ old vs new (rows written to old since the export):`);
      for (const d of drift) console.log(`       ${d}`);
      if (strict) fail+=drift.length;
    } else console.log("ok   every table has the same row count old and new");
    const same=(f,label)=>{ const a=rd(`old.${f}.json`)[0], b=rd(`new.${f}.json`)[0];
      const okk=JSON.stringify(a)===JSON.stringify(b);
      console.log(`${okk?"ok  ":"FAIL"} ${label}${a.n!==undefined?` (${a.n} rows)`:""}`);
      if (!okk) { fail++; console.log("       old: "+String(a.s).slice(0,300)); console.log("       new: "+String(b.s).slice(0,300)); } };
    same("migrations","d1_migrations identical");
    same("schema","schema (tables + indexes, sqlite_master sql) identical");
    // sqlite_sequence moves with every insert on the old side; compare strictly only when frozen.
    { const a=rd("old.sequence.json")[0].s, b=rd("new.sequence.json")[0].s;
      if (a===b) console.log("ok   sqlite_sequence identical");
      else if (strict && drift.length===0) console.log("info sqlite_sequence differs, and only visitor log tables drifted (accepted)");
      else { console.log(`${strict?"FAIL":"info"} sqlite_sequence differs (expected while old takes writes)`); if (strict) fail++; } }
    const fk=rd("new.fkcheck.json");
    console.log(fk.length ? `FAIL foreign_key_check: ${fk.length} violations` : "ok   PRAGMA foreign_key_check is clean on new");
    fail+=fk.length;
    console.log(fail ? `VERIFY FAILED (${fail})` : "VERIFY CLEAN");
    process.exit(fail?1:0);'
}

do_latency() {
  local tok n="${1:-5}"
  tok="$(oauth_token)"
  # A representative detail read: one product by slug plus its vendors.
  local sql='SELECT p.id, p.name, (SELECT count(*) FROM product_vendors pv WHERE pv.product_id = p.id) AS v FROM products p ORDER BY p.slug LIMIT 1 OFFSET 40'
  for pair in "$OLD_DB:$OLD_ID" "$NEW_DB:$NEW_ID"; do
    local name="${pair%%:*}" id="${pair#*:}"
    for i in $(seq 1 "$n"); do
      curl -s -o "$WORK/lat.json" -w '%{time_total}\n' -X POST \
        -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' \
        --data "$(node -e 'console.log(JSON.stringify({sql:process.argv[1]}))' "$sql")" \
        "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/d1/database/$id/query" |
        { read -r total; printf '%-24s run %s  http %5.0f ms  sql %s ms  served_by %s\n' "$name" "$i" "$(echo "$total*1000" | bc)" \
            "$(node -e 'const j=require(process.argv[1]);console.log(j.result[0].meta.duration.toFixed(2))' "$WORK/lat.json")" \
            "$(node -e 'const j=require(process.argv[1]);console.log(j.result[0].meta.served_by_region||j.result[0].meta.served_by||"?")' "$WORK/lat.json")"; }
    done
  done
}

oauth_token() {
  (cd "$(mktemp -d)" && env -u CLOUDFLARE_API_TOKEN "$WRANGLER" auth token --json 2>/dev/null) |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))'
}
SCHEDULES_URL="https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/scripts/aeci-api-production/schedules"
SAVED_SCHEDULES="$WORK/aeci-api-production.schedules.json"

pause_crons() {
  local tok; tok="$(oauth_token)"
  # Clear the schedules through the Workers API, as cutover.sh stop-old-crons did.
  # `wrangler triggers deploy` would also sync queue consumers. The next
  # `wrangler deploy --env production` (the promote) writes them back.
  curl -sf -H "Authorization: Bearer $tok" "$SCHEDULES_URL" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s).result.schedules.map(x=>({cron:x.cron})))))' > "$SAVED_SCHEDULES.tmp"
  [ "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)' "$SAVED_SCHEDULES.tmp")" -gt 0 ] ||
    { echo "aeci-api-production already has no schedules; keeping the earlier saved copy" >&2; rm -f "$SAVED_SCHEDULES.tmp"; exit 1; }
  mv "$SAVED_SCHEDULES.tmp" "$SAVED_SCHEDULES"
  curl -sf -X PUT -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' --data '[]' "$SCHEDULES_URL" >/dev/null
  echo "saved $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)' "$SAVED_SCHEDULES") schedules to $SAVED_SCHEDULES; aeci-api-production now has none"
}

resume_crons() {
  [ -f "$SAVED_SCHEDULES" ] || { echo "no saved schedules at $SAVED_SCHEDULES" >&2; exit 1; }
  local tok; tok="$(oauth_token)"
  curl -sf -X PUT -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' --data @"$SAVED_SCHEDULES" "$SCHEDULES_URL" >/dev/null
  echo "aeci-api-production schedules restored: $(curl -sf -H "Authorization: Bearer $tok" "$SCHEDULES_URL" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).result.schedules.length))')"
}

do_region() {
  local tok day; tok="$(oauth_token)"; day="$(date -u +%Y-%m-%d)"
  curl -s https://api.cloudflare.com/client/v4/graphql -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' \
    --data "{\"query\":\"{viewer{accounts(filter:{accountTag:\\\"$ACCOUNT\\\"}){d1AnalyticsAdaptiveGroups(limit:50,filter:{date_geq:\\\"$day\\\"}){sum{readQueries writeQueries} dimensions{databaseId servedByRegion}}}}}\"}" |
    OLD_ID=$OLD_ID NEW_ID=$NEW_ID node -e '
      let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
        const j=JSON.parse(s); if (j.errors) { console.log(JSON.stringify(j.errors)); process.exit(1); }
        const name={[process.env.OLD_ID]:"old aeci-app-production",[process.env.NEW_ID]:"new aeci-app-production-us"};
        for (const g of j.data.viewer.accounts[0].d1AnalyticsAdaptiveGroups)
          if (name[g.dimensions.databaseId]) console.log(`${name[g.dimensions.databaseId].padEnd(28)} ${g.dimensions.servedByRegion}  reads ${g.sum.readQueries}  writes ${g.sum.writeQueries}  (UTC today)`);
      });'
}

checklist() {
  cat <<EOF
Cutover order (README.md "Cutover plan" has the detail):
  Before the day:
  1. Promote main to production the normal way, so pending migrations land on $OLD_DB first.
  On the day, inside 00:35 to 01:55 UTC (README cron table):
  2. Merge the rebind PR to main; wait for staging (staging is not affected by the rebind).
  3. Run promote-to-demo on the merge SHA. Do NOT run promote-to-prod yet.
  4. Freeze: no review-app promotes, no admin edits, no datatool.
  5. move.sh pause-crons            right after a :00/:15/:30/:45 tick
  6. move.sh export                 (old, read-only; blocks $OLD_DB for ~30 s)
     move.sh import                 (new only)
     move.sh verify --strict        must print VERIFY CLEAN; else resume-crons and unfreeze
  7. Run promote-to-prod on the merge SHA. Its deploy restores the crons.
     If it fails before its deploy step, run move.sh resume-crons.
  8. Confirm: /api/version sha, a product page, move.sh region shows ENAM reads on $NEW_DB.
  9. Redeploy apps/datatool (and apps/agent if deployed).
 10. Unfreeze. Keep $OLD_DB untouched for 7 days as the rollback source.
EOF
}

case "${1:-}" in
  export) timed export-total do_export ;;
  import) timed import-total do_import ;;
  verify) do_verify "${2:-}" ;;
  latency) do_latency "${2:-5}" ;;
  region) do_region ;;
  pause-crons) pause_crons ;;
  resume-crons) resume_crons ;;
  checklist) checklist ;;
  ids) check_ids ;;
  *) sed -n '2,28p' "$0"; exit 1 ;;
esac
