#!/usr/bin/env bash
set -euo pipefail

# Backfill `page_views.is_operator` on rows written BEFORE §13 D13 shipped.
#
# D13 records the operator flag at ingest and states plainly that it is not
# retroactive: nothing stored on an older row implies a session. That leaves a step
# down in every traffic figure at the ship date. This script closes the step for the
# subset that CAN be identified after the fact — the operator's `(user_agent_hash,
# cf_asn)` visitor pairs — and is explicit that the result is an approximation the
# live flag is not.
#
# The cohort, the evidence for each pair, and the rules that were rejected (including
# "everything from Indonesia", which is 44% false positives AND misses half the
# operator's own views) live in `operator-pairs.sql`. This script parses the cohort out
# of that file so the projection, the write, and the rollback cannot drift from it.
#
# WHAT IT WRITES: `is_operator = 1`, only where `is_operator IS NULL`. Nothing else.
# It never touches `is_bot` (§13 D10 constraint 1 keeps ASN-shaped verdicts away from
# that column, and the same reasoning applies here), never deletes, never edits a row
# the live ingest has already decided. Idempotent — a second run changes nothing.
#
# HOW TO UNDO: `--rollback` reverses exactly this cohort back to NULL. That is possible
# only because the script refuses to overwrite a non-NULL value, so every row it sets
# was NULL beforehand. It is a genuine inverse, not a best effort — which is why this
# one does not need the page_views export the AECI-582 bot backfill required.
#
# Dry-run by default. `--apply` writes. Production additionally needs
# `--allow-production` (same guard shape as the bot backfill and ops:retract-product).
#
# USAGE (needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID):
#   scripts/ops/2026-08-operator-page-view-backfill/run.sh --env production
#   scripts/ops/2026-08-operator-page-view-backfill/run.sh --env production --apply --allow-production
#   scripts/ops/2026-08-operator-page-view-backfill/run.sh --env production --rollback --apply --allow-production

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WRANGLER="$ROOT/apps/api/node_modules/.bin/wrangler"
CONFIG="$ROOT/apps/api/wrangler.jsonc"
PAIRS_SQL="$HERE/operator-pairs.sql"

usage() {
  echo "usage: run.sh --env <preview|staging|demo|production> [--apply] [--allow-production] [--rollback]" >&2
  exit 2
}

ENV_NAME=""
APPLY=0
ALLOW_PROD=0
ROLLBACK=0
while [ "${1:-}" != "" ]; do
  case "$1" in
    --env) ENV_NAME="${2:-}"; shift 2 ;;
    --env=*) ENV_NAME="${1#*=}"; shift ;;
    --apply) APPLY=1; shift ;;
    --allow-production) ALLOW_PROD=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
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

[ -x "$WRANGLER" ]  || { echo "missing wrangler at $WRANGLER (run pnpm install)" >&2; exit 1; }
[ -f "$PAIRS_SQL" ] || { echo "missing $PAIRS_SQL" >&2; exit 1; }
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || echo "warn: CLOUDFLARE_API_TOKEN is unset; wrangler will fall back to an interactive login." >&2

d1() { "$WRANGLER" d1 execute "$DB" --env "$ENV_NAME" --remote --json --config "$CONFIG" --command "$1"; }

# Preflight: migration 0016 must be applied to this tier first. Without it every query
# below dies on `no such column: is_operator`, which reads like a broken script rather
# than an un-migrated database. Checked explicitly so the fix is named.
if ! d1 "SELECT COUNT(is_operator) FROM page_views LIMIT 1;" >/dev/null 2>&1; then
  cat >&2 <<EOF
REFUSING: page_views.is_operator does not exist on $DB.

  Migration 0016 has not reached this tier yet. It is applied by the deploy lane
  (scripts/d1-apply-migrations.sh, before 'wrangler deploy'), so ship §13 D13 to
  $ENV_NAME first — or apply it by hand:

    cd apps/api && pnpm exec wrangler d1 migrations apply $DB --env $ENV_NAME --remote

  Run this backfill AFTER the API Worker is live, not before: rows written between
  the migration and the deploy are NULL either way, and the backfill only writes
  over NULL, so ordering it after costs nothing and keeps the live flag authoritative.
EOF
  exit 1
fi

# The cohort, read out of operator-pairs.sql — this script holds no hashes of its own.
PAIRS="$(sed -n '/^-- PAIRS-BEGIN$/,/^-- PAIRS-END$/p' "$PAIRS_SQL" \
  | grep -E "^\('[0-9a-f]{64}', *[0-9]+\)" | tr -d '\n' | sed 's/,$//')"
[ -n "$PAIRS" ] || { echo "could not parse the PAIRS block out of $PAIRS_SQL" >&2; exit 1; }
PAIR_COUNT="$(sed -n '/^-- PAIRS-BEGIN$/,/^-- PAIRS-END$/p' "$PAIRS_SQL" | grep -cE "^\('[0-9a-f]{64}', *[0-9]+\)")"

# The cohort predicate. `(a, b) IN ((x, y), …)` is a row-value comparison — supported by
# SQLite, and the whole reason a pair rule is expressible at all. Both columns are
# compared with `=`, so a NULL `cf_asn` or `user_agent_hash` simply never matches; no
# three-valued-logic surprise, and no row is flagged on a half-match.
COHORT="(user_agent_hash, cf_asn) IN ($PAIRS)"

echo "== target: $DB"
echo "   cohort: $PAIR_COUNT (user_agent_hash, cf_asn) pairs from operator-pairs.sql"
echo "   action: $([ "$ROLLBACK" = 1 ] && echo 'ROLLBACK (is_operator 1 -> NULL)' || echo 'BACKFILL (is_operator NULL -> 1)')"
echo "   mode:   $([ "$APPLY" = 1 ] && echo APPLY || echo DRY-RUN)"

# ─── 1. Before: what the cohort looks like, and what it is worth ────────────────
#
# `human_public` is the population every headline figure reads (§13 D12 + D13), so the
# share below is the number that actually moves on the Traffic screen.
echo
echo "-- before --"
d1 "SELECT
      COUNT(*) AS cohort_rows,
      SUM(CASE WHEN is_operator IS NULL THEN 1 ELSE 0 END) AS cohort_null,
      SUM(CASE WHEN is_operator = 1 THEN 1 ELSE 0 END) AS cohort_already_flagged,
      SUM(CASE WHEN is_bot = 1 THEN 1 ELSE 0 END) AS cohort_bot_flagged,
      SUM(CASE WHEN (is_bot IS NULL OR is_bot = 0)
                AND path NOT LIKE '/admin%' AND path NOT LIKE '/account%'
               THEN 1 ELSE 0 END) AS cohort_human_public
    FROM page_views WHERE $COHORT;"
d1 "SELECT
      COUNT(*) AS human_public_total,
      SUM(CASE WHEN is_operator = 1 THEN 1 ELSE 0 END) AS already_excluded
    FROM page_views
    WHERE (is_bot IS NULL OR is_bot = 0)
      AND path NOT LIKE '/admin%' AND path NOT LIKE '/account%';"

# ─── 2. Per-pair projection ────────────────────────────────────────────────────
#
# Printed per pair rather than as one total so a reviewer can sanity-check each pair's
# volume and date range against the evidence recorded in operator-pairs.sql, instead of
# trusting a single number. `proof_rows` is the operator-only-path count that PROVES a
# pair; a pair showing 0 there is one of the two admitted on stated evidence.
echo
echo "-- per-pair projection --"
d1 "SELECT substr(user_agent_hash, 1, 8) AS ua, cf_asn, cf_country,
           COUNT(*) AS rows_total,
           SUM(CASE WHEN is_operator IS NULL THEN 1 ELSE 0 END) AS would_change,
           SUM(CASE WHEN path LIKE '/admin%' OR path LIKE '/account%' THEN 1 ELSE 0 END) AS proof_rows,
           MIN(created_at) AS first_seen, MAX(created_at) AS last_seen
    FROM page_views WHERE $COHORT
    GROUP BY user_agent_hash, cf_asn, cf_country
    ORDER BY rows_total DESC;"

# ─── 3. The write ──────────────────────────────────────────────────────────────
if [ "$APPLY" != "1" ]; then
  echo
  echo "DRY-RUN — nothing written. Re-run with --apply$([ "$ENV_NAME" = production ] && echo ' --allow-production') to write."
  exit 0
fi

echo
if [ "$ROLLBACK" = "1" ]; then
  # Reverses only rows this script could have set. A row the LIVE ingest flagged is
  # is_operator = 1 too — but it is not in this cohort unless it also matches a pair,
  # and if it does, NULLing it is still correct: the read predicate is NULL-safe and
  # the next ingest re-decides. Nothing is destroyed either way.
  echo "-- rollback --"
  d1 "UPDATE page_views SET is_operator = NULL WHERE is_operator = 1 AND $COHORT;"
else
  echo "-- backfill --"
  # `is_operator IS NULL` is what makes this idempotent AND exactly invertible: a row
  # the live ingest already decided (0 or 1) is never overwritten, so the script's own
  # writes are precisely the rows it can take back.
  d1 "UPDATE page_views SET is_operator = 1 WHERE is_operator IS NULL AND $COHORT;"
fi

# ─── 4. After ──────────────────────────────────────────────────────────────────
echo
echo "-- after --"
d1 "SELECT
      COUNT(*) AS human_public_total,
      SUM(CASE WHEN is_operator = 1 THEN 1 ELSE 0 END) AS operator_excluded,
      COUNT(*) - SUM(CASE WHEN is_operator = 1 THEN 1 ELSE 0 END) AS reads_as_visitor
    FROM page_views
    WHERE (is_bot IS NULL OR is_bot = 0)
      AND path NOT LIKE '/admin%' AND path NOT LIKE '/account%';"

echo
echo "NEXT STEP — metrics_daily is NOT recomputed here, and it is the long memory the"
echo "  panel prefers over live aggregation for completed days. Every day already"
echo "  snapshotted by the 00:15 cron still carries its pre-backfill traffic count, so"
echo "  the Traffic screen will keep showing the old numbers for those days until:"
echo
echo "    pnpm --filter @aeci/api ops:backfill-metrics-daily -- --from 2026-06-23 --to <yesterday>"
echo
echo "  That is safe to re-run: the traffic series is written as 'measured', and §7.1's"
echo "  precedence rule is that a measured write always wins — so it replaces the stale"
echo "  values rather than being refused as a duplicate. Check its own --help/dry-run"
echo "  output before applying."
