#!/usr/bin/env bash
#
# dedup.sh — collapse the duplicate `Reality Capture` category into the seeded row.
#
# `resolveTaxonomy` (apps/api/src/routes/promote.ts) resolves a category
# find-or-CREATE by `slugify(name)`. The upstream term was named
# `Reality Capture (Scan-to-BIM)`, which slugifies to `reality-capture-scan-to-bim`
# and so never matched the seeded `reality-capture`. Every promote re-missed and
# minted the same duplicate. See README.md for the full diagnosis.
#
# THE UPSTREAM RENAME MUST LAND FIRST. If the review-app term is still named
# `Reality Capture (Scan-to-BIM)` when this runs, the next promote re-mints the
# duplicate and undoes the whole operation. There is no way for this script to
# check that from here, so it asks.
#
# Dry-run by default. `--apply` performs the writes. Production additionally
# requires `--allow-production` (same guard shape as `ops:retract-product`).
#
# ALWAYS captures a full backup BEFORE writing, even on --apply. D1 has no undo.
#
# USAGE (from anywhere; needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID):
#   scripts/ops/2026-09-reality-capture-dedup/dedup.sh --env demo
#   scripts/ops/2026-09-reality-capture-dedup/dedup.sh --env demo --apply
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WRANGLER="$ROOT/apps/api/node_modules/.bin/wrangler"

WINNER_SLUG='reality-capture'
LOSER_SLUG='reality-capture-scan-to-bim'

usage() {
  echo "usage: dedup.sh --env <preview|staging|demo|production> [--apply] [--allow-production]" >&2
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

d1() { "$WRANGLER" d1 execute "$DB" --remote --json --command "$1"; }
# Both swallow a no-match and return empty. Under `set -euo pipefail` a failing grep
# inside `VAR="$(...)"` aborts the whole script with no message, which would take out
# the "already clean" exit below before it could print anything.
num() { grep -oE "\"$1\": [0-9]+" | grep -oE '[0-9]+$' || true; }
str() { grep -oE "\"$1\": \"[^\"]*\"" | sed 's/.*: "//; s/"$//' || true; }

echo "== target: $DB   mode: $([ "$APPLY" = 1 ] && echo APPLY || echo DRY-RUN)"

# ─── 1. resolve both rows, and prove the shape before touching anything ──────
echo
echo "-- footprint --"
FOOTPRINT="$(d1 "
SELECT
 IFNULL((SELECT id FROM taxonomy_categories WHERE slug='$WINNER_SLUG'),'') AS winner_id,
 IFNULL((SELECT id FROM taxonomy_categories WHERE slug='$LOSER_SLUG'),'')  AS loser_id,
 (SELECT COUNT(*) FROM product_categories WHERE category_id=(SELECT id FROM taxonomy_categories WHERE slug='$WINNER_SLUG')) AS winner_products,
 (SELECT COUNT(*) FROM product_categories WHERE category_id=(SELECT id FROM taxonomy_categories WHERE slug='$LOSER_SLUG'))  AS loser_products,
 (SELECT COUNT(*) FROM product_categories a
    JOIN product_categories b ON b.product_id = a.product_id
   WHERE a.category_id=(SELECT id FROM taxonomy_categories WHERE slug='$LOSER_SLUG')
     AND b.category_id=(SELECT id FROM taxonomy_categories WHERE slug='$WINNER_SLUG')) AS both,
 (SELECT COUNT(*) FROM taxonomy_categories WHERE slug='$LOSER_SLUG' AND (description IS NOT NULL AND trim(description)<>'')) AS loser_has_description;")"

WINNER_ID="$(echo "$FOOTPRINT" | str winner_id)"
LOSER_ID="$(echo "$FOOTPRINT" | str loser_id)"
WINNER_PRODUCTS="$(echo "$FOOTPRINT" | num winner_products)"
LOSER_PRODUCTS="$(echo "$FOOTPRINT" | num loser_products)"
BOTH="$(echo "$FOOTPRINT" | num both)"
LOSER_DESC="$(echo "$FOOTPRINT" | num loser_has_description)"

echo "   winner $WINNER_SLUG      id=${WINNER_ID:-<none>}  products=$WINNER_PRODUCTS"
echo "   loser  $LOSER_SLUG  id=${LOSER_ID:-<none>}  products=$LOSER_PRODUCTS"
echo "   [guard] products joined to BOTH (must be 0):        $BOTH"
echo "   [guard] loser carries curated copy (must be 0):     $LOSER_DESC"

if [ -z "$LOSER_ID" ]; then
  echo
  echo "Nothing to do: $DB has no '$LOSER_SLUG' row. This environment is already clean."
  exit 0
fi
[ -n "$WINNER_ID" ] || { echo "REFUSING: no '$WINNER_SLUG' row to merge into. Re-seed taxonomy first." >&2; exit 1; }

fail=0
# A product joined to both rows would trip product_categories' composite PK on
# the UPDATE. Today the winner holds 0 products so the intersection is empty,
# but that is a fact about this moment, not an invariant.
[ "${BOTH:-1}" = "0" ] || { echo "REFUSING: $BOTH product(s) join BOTH categories; the UPDATE would violate the composite PK. De-duplicate those joins first." >&2; fail=1; }
# If someone curated the minted row instead of the seeded one, this merge would
# throw that copy away. Move it by hand and re-run.
[ "${LOSER_DESC:-1}" = "0" ] || { echo "REFUSING: the loser row carries a description. Someone curated the minted row; merge the copy by hand first." >&2; fail=1; }
[ "$fail" = "0" ] || exit 1

# ─── 2. backup (always, before any write) ────────────────────────────────────
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$HERE/backups/$STAMP-$ENV_NAME"
mkdir -p "$BACKUP_DIR"
echo
echo "-- backup → $BACKUP_DIR --"
d1 "SELECT * FROM taxonomy_categories WHERE slug IN ('$WINNER_SLUG','$LOSER_SLUG');" > "$BACKUP_DIR/categories.json"
d1 "SELECT * FROM product_categories WHERE category_id IN ('$WINNER_ID','$LOSER_ID');" > "$BACKUP_DIR/product-categories.json"
d1 "SELECT p.slug AS slug FROM product_categories pc JOIN products p ON p.id=pc.product_id WHERE pc.category_id='$LOSER_ID' ORDER BY p.slug;" \
  | grep -oE '"slug": "[^"]+"' | sed 's/.*: "//; s/"//' > "$BACKUP_DIR/affected-slugs.txt"
echo "   affected products ($(grep -c . "$BACKUP_DIR/affected-slugs.txt")):"
sed 's/^/     product:/' "$BACKUP_DIR/affected-slugs.txt"

if [ "$APPLY" != "1" ]; then
  echo
  echo "DRY-RUN complete. Nothing was written."
  echo "Confirm the upstream term is renamed to 'Reality Capture' BEFORE applying,"
  echo "or the next promote re-mints the duplicate."
  echo "Re-run with --apply$([ "$ENV_NAME" = production ] && echo ' --allow-production')."
  exit 0
fi

# ─── 3. re-point, THEN delete. Order is the data-loss control. ───────────────
# product_categories.category_id is ON DELETE CASCADE (apps/api/src/db/schema.ts).
# Deleting the loser first does not error — it silently strips those products of
# their category, and nothing self-heals because promote replaces join sets
# wholesale rather than reconciling them.
echo
echo "-- re-pointing $LOSER_PRODUCTS join row(s) --"
d1 "UPDATE product_categories SET category_id='$WINNER_ID' WHERE category_id='$LOSER_ID';" > /dev/null

MOVED="$(d1 "SELECT COUNT(*) AS n FROM product_categories WHERE category_id='$WINNER_ID';" | num n)"
LEFT="$(d1 "SELECT COUNT(*) AS n FROM product_categories WHERE category_id='$LOSER_ID';" | num n)"
echo "   winner now holds: $MOVED (want $((WINNER_PRODUCTS + LOSER_PRODUCTS)))"
echo "   loser still holds: $LEFT (want 0)"
[ "$LEFT" = "0" ] || { echo "ABORTING before the delete: joins did not move. The loser row is untouched; nothing lost." >&2; exit 1; }

# Bump updated_at so the Algolia watermark sync picks these products up. The
# facet value is the category NAME (lib/algolia-transforms.ts), which just
# changed, and neither the join re-point nor the rename touches updated_at on
# its own — so without this the 10 records keep the old facet indefinitely.
echo
echo "-- bumping products.updated_at for the Algolia watermark --"
d1 "UPDATE products SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (SELECT product_id FROM product_categories WHERE category_id='$WINNER_ID');" > /dev/null

echo
echo "-- deleting the emptied duplicate --"
d1 "DELETE FROM taxonomy_categories WHERE id='$LOSER_ID';" > /dev/null

# ─── 4. verify ───────────────────────────────────────────────────────────────
echo
echo "-- post-op verification --"
d1 "SELECT slug, name, display_order, (description IS NULL OR trim(description)='') AS no_description,
      (SELECT COUNT(*) FROM product_categories pc WHERE pc.category_id=c.id) AS products
    FROM taxonomy_categories c WHERE c.slug LIKE 'reality%';"

cat <<EOF

DONE on $DB. Three follow-ups this script deliberately does NOT do:

  1. TAXONOMY_KV — GET /api/taxonomy read-through caches on key 'taxonomy:v1' with a
     300s TTL and NO active invalidation (apps/api/src/routes/taxonomy.ts). It sits
     UPSTREAM of every Cache-Tag, so a tag purge alone repaints from the stale payload:

       $WRANGLER kv key delete --binding TAXONOMY_KV --env $ENV_NAME --remote taxonomy:v1

  2. Cache-Tag purge — category:$WINNER_SLUG, category:$LOSER_SLUG,
     index:categories, index:products, taxonomy, sitemap, and route:browse.

  3. Algolia — updated_at was bumped above, so the next watermark sync reindexes the
     affected products. Check the Reality Capture facet after that sync. Do NOT use
     db:reconcile-algolia-drift: it compares record membership, not facet values,
     and it rejects --env demo.

Do NOT run reconcile-counts. Category product counts are computed live per request
(toTaxonomyTermWithCount); there is no denormalised category counter to drift.

This went through raw SQL rather than the API's db.batch + audit builders, so it left
NO audit_log row — same as every prior ops script here.
EOF
