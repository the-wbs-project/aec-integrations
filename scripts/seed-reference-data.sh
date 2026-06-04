#!/usr/bin/env bash
# Apply the code-owned taxonomy reference data (supabase/reference-data/taxonomy.sql)
# to a target database. Idempotent upserts — safe to re-run.
#
# Usage:
#   scripts/seed-reference-data.sh                # local Supabase (default URL)
#   scripts/seed-reference-data.sh "$DIRECT_URL_STAGING"   # any remote env
#
# The same SQL is applied automatically on `pnpm db:reset` (via
# supabase/config.toml [db.seed].sql_paths) and by the deploy workflows after
# `supabase db push`. This wrapper is for manual / bootstrap application — e.g.
# seeding a remote env before the CI step lands, or re-seeding without a reset.
set -euo pipefail

# Default to the local Supabase Postgres (same URL as `prisma:pull`).
PGURL="${1:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SQL_FILE="${SCRIPT_DIR}/../supabase/reference-data/taxonomy.sql"

echo "Applying taxonomy reference data → ${PGURL%%\?*}"
psql -v ON_ERROR_STOP=1 "$PGURL" -f "$SQL_FILE"
echo "Done."
