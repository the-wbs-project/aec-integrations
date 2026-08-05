#!/usr/bin/env bash
#
# cleanup.sh — remove the 22 orphaned `integrations` rows from a deployed D1.
#
# An orphan here is an integration row that **no Airtable record points at**: no
# `Integrations.supabase_integration_id` in the AEC Integrations base holds its
# id. They are the residue of a promote whose id write-back never landed, so the
# retry inserted fresh rows and Airtable kept only the retry's ids. See README.md
# for the full diagnosis and evidence.
#
# Dry-run by default. `--apply` performs the writes. Production additionally
# requires `--allow-production` (same guard shape as `ops:retract-product`).
#
# ALWAYS captures a full backup + a generated rollback.sql BEFORE deleting, even
# on --apply. D1 has no undo; the backup is the undo.
#
# USAGE (from anywhere; needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID):
#   scripts/ops/2026-08-orphan-integration-cleanup/cleanup.sh --env production
#   scripts/ops/2026-08-orphan-integration-cleanup/cleanup.sh --env production --apply --allow-production
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WRANGLER="$ROOT/apps/api/node_modules/.bin/wrangler"
IDS_FILE="$HERE/orphan-ids.txt"

usage() {
  echo "usage: cleanup.sh --env <preview|staging|demo|production> [--apply] [--allow-production]" >&2
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

[ -f "$IDS_FILE" ] || { echo "missing $IDS_FILE" >&2; exit 1; }
[ -x "$WRANGLER" ] || { echo "missing wrangler at $WRANGLER (run pnpm install)" >&2; exit 1; }

IDS_SQL="$(sed "s/^/'/; s/$/'/" "$IDS_FILE" | paste -sd, -)"
N_IDS="$(grep -c . "$IDS_FILE")"

d1() { "$WRANGLER" d1 execute "$DB" --remote --json --command "$1"; }
num() { grep -oE "\"$1\": [0-9]+" | grep -oE '[0-9]+$'; }

echo "== target: $DB   ids: $N_IDS   mode: $([ "$APPLY" = 1 ] && echo APPLY || echo DRY-RUN)"

# ─── 1. re-verify the orphan invariant BEFORE touching anything ──────────────
# The id list was computed from a point-in-time Airtable snapshot. If a promote
# has since claimed one of these ids, it is no longer an orphan. And if a claim
# exists ONLY on an orphan (not on its surviving twin), deleting would cascade
# away curation. Both are hard stops.
echo
echo "-- footprint --"
FOOTPRINT="$(d1 "
SELECT
 (SELECT COUNT(*) FROM integrations WHERE id IN ($IDS_SQL)) AS integrations,
 (SELECT COUNT(*) FROM claims WHERE integration_id IN ($IDS_SQL)) AS claims,
 (SELECT COUNT(*) FROM attestations WHERE claim_id IN (SELECT id FROM claims WHERE integration_id IN ($IDS_SQL))) AS attestations,
 (SELECT COUNT(*) FROM claims oc JOIN integrations o ON o.id = oc.integration_id
   WHERE o.id IN ($IDS_SQL)
     AND NOT EXISTS (
       SELECT 1 FROM integrations s JOIN claims sc ON sc.integration_id = s.id
       WHERE s.id NOT IN ($IDS_SQL)
         AND s.source_product_id = o.source_product_id
         AND s.target_product_id = o.target_product_id
         AND IFNULL(s.mechanism_name,'') = IFNULL(o.mechanism_name,'')
         AND sc.data_object_id = oc.data_object_id
         AND sc.direction = oc.direction
     )) AS claims_unique_to_orphans,
 (SELECT COUNT(*) FROM integrations o WHERE o.id IN ($IDS_SQL)
   AND NOT EXISTS (
     SELECT 1 FROM integrations s WHERE s.id NOT IN ($IDS_SQL)
       AND s.source_product_id = o.source_product_id
       AND s.target_product_id = o.target_product_id
       AND IFNULL(s.mechanism_name,'') = IFNULL(o.mechanism_name,'')
   )) AS orphans_without_a_twin,
 (SELECT COUNT(*) FROM integrations o
   JOIN integrations s ON s.id NOT IN ($IDS_SQL)
     AND s.source_product_id = o.source_product_id
     AND s.target_product_id = o.target_product_id
     AND IFNULL(s.mechanism_name,'') = IFNULL(o.mechanism_name,'')
   WHERE o.id IN ($IDS_SQL)
     AND (LENGTH(IFNULL(o.description,'')) > LENGTH(IFNULL(s.description,''))
       OR LENGTH(IFNULL(o.notes,'')) > LENGTH(IFNULL(s.notes,'')))) AS orphans_richer_than_twin;")"

INTEGRATIONS="$(echo "$FOOTPRINT" | num integrations)"
CLAIMS="$(echo "$FOOTPRINT" | num claims)"
ATTESTATIONS="$(echo "$FOOTPRINT" | num attestations)"
UNIQUE_CLAIMS="$(echo "$FOOTPRINT" | num claims_unique_to_orphans)"
NO_TWIN="$(echo "$FOOTPRINT" | num orphans_without_a_twin)"
RICHER="$(echo "$FOOTPRINT" | num orphans_richer_than_twin)"
echo "   integrations: $INTEGRATIONS   claims: $CLAIMS   attestations: $ATTESTATIONS"
echo "   [guard] claims unique to orphans (must be 0):   $UNIQUE_CLAIMS"
echo "   [guard] orphans without a surviving twin (0):   $NO_TWIN"
echo "   [guard] orphans richer than their twin (0):     $RICHER"

# Three hard stops. Each one means "deleting this row loses something the
# surviving row does not already have" — i.e. it is not a duplicate after all.
fail=0
[ "${UNIQUE_CLAIMS:-1}" = "0" ] || { echo "REFUSING: $UNIQUE_CLAIMS claim(s) exist ONLY on orphan rows; the cascade would destroy curation. Merge first." >&2; fail=1; }
[ "${NO_TWIN:-1}" = "0" ]       || { echo "REFUSING: $NO_TWIN orphan(s) have NO surviving twin — they are not duplicates, they are the only copy." >&2; fail=1; }
[ "${RICHER:-1}" = "0" ]        || { echo "REFUSING: $RICHER orphan(s) carry more description/notes than their twin; content would be lost." >&2; fail=1; }
[ "$fail" = "0" ] || exit 1

# ─── 2. affected products (targets for the counts + cache follow-ups) ────────
echo
echo "-- affected products (Cache-Tag + count-recompute targets) --"
d1 "SELECT DISTINCT p.slug AS slug FROM integrations i
    JOIN products p ON p.id IN (i.source_product_id, i.target_product_id)
    WHERE i.id IN ($IDS_SQL) ORDER BY p.slug;" \
  | grep -oE '"slug": "[^"]+"' | sed 's/.*: "//; s/"//' > "$HERE/affected-slugs.txt"
sed 's/^/   product:/' "$HERE/affected-slugs.txt"

# ─── 3. BACKUP + generated rollback (always, before any write) ───────────────
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$HERE/backups/$STAMP-$ENV_NAME"
mkdir -p "$BACKUP_DIR"
echo
echo "-- backup → $BACKUP_DIR --"
d1 "SELECT * FROM integrations WHERE id IN ($IDS_SQL);" > "$BACKUP_DIR/integrations.json"
d1 "SELECT * FROM claims WHERE integration_id IN ($IDS_SQL);" > "$BACKUP_DIR/claims.json"
d1 "SELECT * FROM attestations WHERE claim_id IN (SELECT id FROM claims WHERE integration_id IN ($IDS_SQL));" \
  > "$BACKUP_DIR/attestations.json"

node "$HERE/build-rollback.mjs" "$BACKUP_DIR" > "$BACKUP_DIR/rollback.sql"
echo "   backed up; rollback.sql has $(grep -c '^INSERT' "$BACKUP_DIR/rollback.sql") INSERT statements"

# ─── 4. delete (child → parent; explicit, not relying on ON DELETE CASCADE) ──
if [ "$APPLY" != "1" ]; then
  echo
  echo "DRY-RUN complete. Nothing was written."
  echo "Re-run with --apply$([ "$ENV_NAME" = production ] && echo ' --allow-production') when the footprint above looks right."
  exit 0
fi

echo
echo "-- deleting --"
d1 "DELETE FROM attestations WHERE claim_id IN (SELECT id FROM claims WHERE integration_id IN ($IDS_SQL));" > /dev/null
d1 "DELETE FROM claims WHERE integration_id IN ($IDS_SQL);" > /dev/null
d1 "DELETE FROM integrations WHERE id IN ($IDS_SQL);" > /dev/null

# ─── 5. verify ───────────────────────────────────────────────────────────────
echo
echo "-- post-delete verification --"
VERIFY="$(d1 "SELECT
 (SELECT COUNT(*) FROM integrations WHERE id IN ($IDS_SQL)) AS integrations_left,
 (SELECT COUNT(*) FROM claims WHERE integration_id IN ($IDS_SQL)) AS claims_left,
 (SELECT COUNT(*) FROM integrations) AS integrations_total;")"
echo "   integrations left (want 0): $(echo "$VERIFY" | num integrations_left)"
echo "   claims left (want 0):       $(echo "$VERIFY" | num claims_left)"
echo "   integrations total:         $(echo "$VERIFY" | num integrations_total)"

cat <<EOF

DONE. Follow-ups (this script does NOT run them):
  1. counts    RECONCILE_ENV=$ENV_NAME pnpm --filter @aeci/api db:reconcile-counts -- --fix
  2. algolia   pnpm --filter @aeci/api ops:purge-algolia-orphans -- --env $ENV_NAME --apply
  3. cache     POST /admin/purge with product:<slug> tags from affected-slugs.txt

Rollback:
  $WRANGLER d1 execute $DB --remote --file=$BACKUP_DIR/rollback.sql
EOF
