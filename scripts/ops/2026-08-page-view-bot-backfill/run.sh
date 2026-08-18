#!/usr/bin/env bash
set -euo pipefail

# AECI-582 — classify the historical page_views rows that read as human.
#
# Rows captured before the traffic classifier shipped have `is_bot IS NULL`, and every
# read predicate in the app is `is_bot IS NOT 1` (`HUMAN`, apps/api/src/lib/analytics-digest.ts),
# so an unclassified row counts as a HUMAN. This applies, in order:
#
#   1. recover-ua-names.sql          — UA-hash → true crawler name (Applebot, Bingbot, …)
#   2. ../backfill-page-view-bots.sql — the ASN rule, then the "rest is human" sweep
#
# Both files are idempotent (`WHERE is_bot IS NULL`), so a second run changes nothing.
#
# Dry-run by default. `--apply` performs the writes. Production additionally requires
# `--allow-production` (same guard shape as `ops:retract-product` and the orphan cleanup).
#
# ALWAYS exports page_views + records a Time Travel bookmark BEFORE writing, even on
# --apply. D1 has no undo; the export is the undo. Note that the second statement of
# the ASN file hard-sets every remaining row to is_bot = 0, which destroys the
# "never classified" signal — the export is the only way back to it.
#
# USAGE (from anywhere; needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID):
#   scripts/ops/2026-08-page-view-bot-backfill/run.sh --env preview
#   scripts/ops/2026-08-page-view-bot-backfill/run.sh --env production --apply --allow-production

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WRANGLER="$ROOT/apps/api/node_modules/.bin/wrangler"
CONFIG="$ROOT/apps/api/wrangler.jsonc"
UA_SQL="$HERE/recover-ua-names.sql"
ASN_SQL="$HERE/../backfill-page-view-bots.sql"

usage() {
  echo "usage: run.sh --env <preview|staging|demo|production> [--apply] [--allow-production]" >&2
  exit 2
}

ENV_NAME=""
APPLY=0
ALLOW_PROD=0
while [ "${1:-}" != "" ]; do
  case "$1" in
    --env) ENV_NAME="${2:-}"; shift 2 ;;
    --env=*) ENV_NAME="${1#*=}"; shift ;;
    --apply) APPLY=1; shift ;;
    --allow-production) ALLOW_PROD=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

case "$ENV_NAME" in
  preview|staging|demo|production) ;;
  *) usage ;;
esac
DB="aeci-app-$ENV_NAME"

if [ "$ENV_NAME" = "production" ] && [ "$APPLY" = "1" ] && [ "$ALLOW_PROD" != "1" ]; then
  echo "REFUSING: production writes need --allow-production." >&2
  exit 1
fi

[ -x "$WRANGLER" ] || { echo "missing wrangler at $WRANGLER (run pnpm install)" >&2; exit 1; }
[ -f "$UA_SQL" ]   || { echo "missing $UA_SQL" >&2; exit 1; }
[ -f "$ASN_SQL" ]  || { echo "missing $ASN_SQL" >&2; exit 1; }
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || echo "warn: CLOUDFLARE_API_TOKEN is unset; wrangler will fall back to an interactive login." >&2

d1() { "$WRANGLER" d1 execute "$DB" --env "$ENV_NAME" --remote --json --config "$CONFIG" --command "$1"; }

# The ASN list, read out of the ASN file so this script can never drift from it.
ASNS="$(perl -0777 -ne 'print $1 if /WHERE is_bot IS NULL\s+AND cf_asn IN \(([\s\S]*?)\)/' "$ASN_SQL" | tr -cd '0-9,\n' | tr -d '\n' | sed 's/,$//')"
[ -n "$ASNS" ] || { echo "could not parse the ASN list out of $ASN_SQL" >&2; exit 1; }

census() {
  d1 "SELECT strftime('%Y-%m', created_at) AS month,
             COUNT(*) AS rows_total,
             SUM(CASE WHEN is_bot IS NULL THEN 1 ELSE 0 END) AS unclassified,
             SUM(CASE WHEN is_bot = 1 THEN 1 ELSE 0 END) AS bot,
             SUM(CASE WHEN is_bot = 0 THEN 1 ELSE 0 END) AS human,
             SUM(CASE WHEN is_bot IS NOT 1 THEN 1 ELSE 0 END) AS reads_as_human
      FROM page_views GROUP BY 1 ORDER BY 1;"
}

show_census() {
  python3 -c "
import json,sys
rows = json.load(sys.stdin)[0]['results']
print(f\"   {'month':9} {'rows':>7} {'unclassified':>13} {'bot':>7} {'human':>7} {'reads as human':>15}\")
t=[0]*5
for r in rows:
    print(f\"   {r['month']:9} {r['rows_total']:>7} {r['unclassified']:>13} {r['bot']:>7} {r['human']:>7} {r['reads_as_human']:>15}\")
    for i,k in enumerate(['rows_total','unclassified','bot','human','reads_as_human']): t[i]+=r[k]
print(f\"   {'TOTAL':9} {t[0]:>7} {t[1]:>13} {t[2]:>7} {t[3]:>7} {t[4]:>15}\")
" < "$1"
}

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$HERE/backups/$STAMP-$ENV_NAME"
mkdir -p "$OUT"

echo "== target: $DB   mode: $([ "$APPLY" = 1 ] && echo APPLY || echo DRY-RUN)   artifacts: $OUT"

# ─── 1. before-state census ─────────────────────────────────────────────────
echo
echo "-- before --"
census > "$OUT/report-before.json"
show_census "$OUT/report-before.json"

# ─── 2. projection: what the two files WOULD do ─────────────────────────────
echo
echo "-- projection --"
UA_HASHES="$(perl -0777 -ne 'print $1 if /AND user_agent_hash IN \(([\s\S]*?)\);/' "$UA_SQL" | tr -d " \n")"
COHORT="$(perl -0777 -ne 'print $1 if /AND user_agent_hash = (\x27[0-9a-f]+\x27);/' "$UA_SQL")"
# A single CASE chain, evaluated in the same priority order the files apply, so the
# four buckets are mutually exclusive and always sum to the unclassified total. (A
# plain NOT IN would silently drop rows whose user_agent_hash is NULL — NULL NOT IN
# (...) is NULL, not true — and the buckets would not reconcile.)
d1 "SELECT
      SUM(CASE WHEN bucket = 'a'  THEN 1 ELSE 0 END) AS rule_a_ua_name,
      SUM(CASE WHEN bucket = 'a2' THEN 1 ELSE 0 END) AS rule_a2_cohort,
      SUM(CASE WHEN bucket = 'b'  THEN 1 ELSE 0 END) AS rule_b_asn,
      SUM(CASE WHEN bucket = 'c'  THEN 1 ELSE 0 END) AS rule_c_human,
      COUNT(*) AS total
    FROM (
      SELECT CASE
               WHEN user_agent_hash IN ($UA_HASHES) THEN 'a'
               WHEN user_agent_hash = $COHORT       THEN 'a2'
               WHEN cf_asn IN ($ASNS)               THEN 'b'
               ELSE 'c'
             END AS bucket
      FROM page_views WHERE is_bot IS NULL
    );" > "$OUT/projection.json"
python3 -c "
import json,sys
r = json.load(sys.stdin)[0]['results'][0]
for k,label in [('rule_a_ua_name','A  → bot, true crawler name (UA hash)'),
                ('rule_a2_cohort','A2 → bot, unnamed crawler cohort'),
                ('rule_b_asn','B  → bot, datacenter label (ASN)'),
                ('rule_c_human','C  → human (sweep)'),
                ('total','   unclassified rows in total')]:
    print(f'   {label:44} {r[k] or 0:>7}')
" < "$OUT/projection.json"

# ─── 3. backup — always, before any write ───────────────────────────────────
echo
echo "-- backup --"
"$WRANGLER" d1 time-travel info "$DB" --env "$ENV_NAME" --config "$CONFIG" > "$OUT/time-travel.txt" 2>&1 || true
echo "   time-travel bookmark → $OUT/time-travel.txt"
"$WRANGLER" d1 export "$DB" --env "$ENV_NAME" --remote --config "$CONFIG" \
  --table page_views --no-schema --output "$OUT/page_views.sql" >/dev/null
echo "   page_views export    → $OUT/page_views.sql ($(wc -l < "$OUT/page_views.sql" | tr -d ' ') lines)"

if [ "$APPLY" != "1" ]; then
  echo
  echo "DRY-RUN complete. Nothing was written."
  echo "Re-run with --apply$([ "$ENV_NAME" = production ] && echo ' --allow-production') when the projection above looks right."
  exit 0
fi

# ─── 4. apply — UA names first, then the ASN rule + sweep ───────────────────
echo
echo "-- applying --"
"$WRANGLER" d1 execute "$DB" --env "$ENV_NAME" --remote --config "$CONFIG" --file="$UA_SQL"  >/dev/null
echo "   1/2 recover-ua-names.sql"
"$WRANGLER" d1 execute "$DB" --env "$ENV_NAME" --remote --config "$CONFIG" --file="$ASN_SQL" >/dev/null
echo "   2/2 backfill-page-view-bots.sql"

# ─── 5. verify ──────────────────────────────────────────────────────────────
echo
echo "-- after --"
census > "$OUT/report-after.json"
show_census "$OUT/report-after.json"

LEFT="$(d1 "SELECT COUNT(*) AS n FROM page_views WHERE is_bot IS NULL;" | grep -oE '"n": [0-9]+' | grep -oE '[0-9]+$')"
echo
echo "   unclassified rows remaining (want 0): $LEFT"
[ "${LEFT:-1}" = "0" ] || { echo "WARNING: rows are still unclassified. Investigate before recording the run." >&2; exit 1; }

d1 "SELECT bot_name, COUNT(*) AS n FROM page_views WHERE is_bot = 1 GROUP BY 1 ORDER BY n DESC LIMIT 12;" > "$OUT/bot-names-after.json"
echo
echo "-- top crawlers after --"
python3 -c "
import json,sys
for r in json.load(sys.stdin)[0]['results']:
    print(f\"   {str(r['bot_name']):34} {r['n']:>6}\")
" < "$OUT/bot-names-after.json"

cat <<EOF

DONE ($DB). Artifacts in $OUT.
Rollback (whole table): $WRANGLER d1 execute $DB --env $ENV_NAME --remote --file=$OUT/page_views.sql
  (that file is INSERTs; restoring means deleting the rows first — prefer Time Travel, see time-travel.txt)
EOF
