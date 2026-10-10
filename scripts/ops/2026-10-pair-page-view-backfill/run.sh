#!/usr/bin/env bash
set -euo pipefail

# Backfill `page_views.pair_product_a_id` / `pair_product_b_id` on integration
# pair-page rows written BEFORE migration 0067 (AECI-929 / ADMIN_PANEL_SPEC.md §7.3,
# §13 D25).
#
# Since 0067 ingest derives both endpoint products from the concrete path. Older rows
# carry the same concrete path (AECI-585 has stored it since 2026-08), so the two
# slugs are recoverable after the fact. Rows older than AECI-585 have no
# `concrete_path` and stay unattributed. A slug that no longer resolves to a product
# stays NULL on that side, never a guess.
#
# WHAT IT WRITES: the two pair columns, only where BOTH are NULL. Nothing else. It
# never touches `product_id`, never deletes, never edits a row ingest already
# attributed. Idempotent: a second run changes nothing. The SQL lives in
# `backfill.sql`; `projection.sql` is its dry-run twin with the identical parse.
#
# HOW TO UNDO: there is no rollback flag. Every row it writes had both columns NULL,
# and ingest writes the same values for a new row, so the backfilled rows cannot be
# told apart from live ones afterwards. If a rollback is ever needed, bound it by the
# `created_at` window this script prints: every row it wrote predates the 0067 deploy.
#
# NOT RUN ON PRODUCTION in AECI-929. Production data work waits for the standing
# post-go-live rule. Dry-run by default; `--apply` writes; production additionally
# needs `--allow-production` (same guard shape as the operator backfill).
#
# USAGE (remote tiers need CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID):
#   scripts/ops/2026-10-pair-page-view-backfill/run.sh --env local
#   scripts/ops/2026-10-pair-page-view-backfill/run.sh --env staging --apply
#   scripts/ops/2026-10-pair-page-view-backfill/run.sh --env production --apply --allow-production

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WRANGLER="$ROOT/apps/api/node_modules/.bin/wrangler"
CONFIG="$ROOT/apps/api/wrangler.jsonc"
BACKFILL_SQL="$HERE/backfill.sql"
PROJECTION_SQL="$HERE/projection.sql"

usage() {
  echo "usage: run.sh --env <local|preview|staging|demo|production> [--apply] [--allow-production]" >&2
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
  local|preview|staging|demo|production) ;;
  *) usage ;;
esac

if [ "$ENV_NAME" = "production" ] && [ "$APPLY" = "1" ] && [ "$ALLOW_PROD" != "1" ]; then
  echo "REFUSING: production writes need --allow-production." >&2
  exit 1
fi

[ -x "$WRANGLER" ] || { echo "missing wrangler at $WRANGLER (run pnpm install)" >&2; exit 1; }
[ -f "$BACKFILL_SQL" ] || { echo "missing $BACKFILL_SQL" >&2; exit 1; }
[ -f "$PROJECTION_SQL" ] || { echo "missing $PROJECTION_SQL" >&2; exit 1; }

# `local` is the miniflare D1 that `pnpm db:migrate:local` writes (no --env, --local).
# Every other tier goes through its wrangler env block, by binding, so the database id
# comes from the repo config rather than from a name that may point at a retired copy.
if [ "$ENV_NAME" = "local" ]; then
  d1() { (cd "$ROOT/apps/api" && "$WRANGLER" d1 execute DB --local --json --command "$1"); }
  TARGET="local D1 (aeci-app-preview, --local)"
else
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || echo "warn: CLOUDFLARE_API_TOKEN is unset; wrangler will fall back to an interactive login." >&2
  d1() { "$WRANGLER" d1 execute DB --env "$ENV_NAME" --remote --json --config "$CONFIG" --command "$1"; }
  TARGET="DB binding, env $ENV_NAME (remote)"
fi

# `--command` takes one string; drop the `--` comment lines so the statement is all
# that is sent. `--file` is not used: it is wrangler's bulk-import path and returns
# no rows, so the projection would read as empty.
sql_of() { grep -v '^--' "$1"; }

# Preflight: migration 0067 must be applied to this tier first. Without it every query
# below dies on `no such column: pair_product_a_id`, which reads like a broken script
# rather than an un-migrated database. Checked explicitly so the fix is named.
if ! d1 "SELECT COUNT(pair_product_a_id), COUNT(pair_product_b_id) FROM page_views LIMIT 1;" >/dev/null 2>&1; then
  cat >&2 <<MSG
REFUSING: page_views.pair_product_a_id does not exist on $TARGET.

  Apply migration 0067 first. It is applied by the deploy lane
  (scripts/d1-apply-migrations.sh, before 'wrangler deploy'); locally run
  'pnpm --filter @aeci/api db:migrate:local'.

  Run this backfill AFTER the API Worker that writes the columns is live: rows
  written between the migration and the deploy are NULL either way, and the
  backfill only writes over NULL, so ordering it after costs nothing.
MSG
  exit 1
fi

echo "== target: $TARGET"
echo "   mode:   $([ "$APPLY" = 1 ] && echo APPLY || echo DRY-RUN)"

counts() {
  d1 "SELECT
        COUNT(*) AS pair_page_rows,
        SUM(CASE WHEN pair_product_a_id IS NOT NULL AND pair_product_b_id IS NOT NULL THEN 1 ELSE 0 END) AS attributed_both,
        SUM(CASE WHEN pair_product_a_id IS NOT NULL AND pair_product_b_id IS NULL THEN 1 ELSE 0 END) AS attributed_one,
        SUM(CASE WHEN pair_product_a_id IS NULL AND pair_product_b_id IS NULL THEN 1 ELSE 0 END) AS attributed_none
      FROM page_views
      WHERE concrete_path GLOB '/products/*/integrations/*';"
}

# ─── 1. Before ─────────────────────────────────────────────────────────────────
echo
echo "-- before (every pair-shaped concrete_path) --"
counts

# ─── 2. Projection ─────────────────────────────────────────────────────────────
#
# `resolved_both` + `resolved_one` is what --apply writes. `unresolved` rows parse as a
# pair page but neither slug names a product today; they stay NULL. The created_at
# range is the backfill window recorded in ADMIN_PANEL_SPEC.md §7.3.
echo
echo "-- projection (rows backfill.sql would consider) --"
d1 "$(sql_of "$PROJECTION_SQL")"

# ─── 3. The write ──────────────────────────────────────────────────────────────
if [ "$APPLY" != "1" ]; then
  echo
  echo "DRY-RUN — nothing written. Re-run with --apply$([ "$ENV_NAME" = production ] && echo ' --allow-production') to write."
  exit 0
fi

echo
echo "-- backfill --"
d1 "$(sql_of "$BACKFILL_SQL")"

# ─── 4. After ──────────────────────────────────────────────────────────────────
echo
echo "-- after --"
counts
echo
echo "-- projection after (resolved_both + resolved_one must be 0) --"
d1 "$(sql_of "$PROJECTION_SQL")"

echo
echo "NEXT STEP — record the window and counts above in ADMIN_PANEL_SPEC.md §7.3 and"
echo "  on AECI-929. metrics_daily needs no recompute: it stores no per-product figure."
