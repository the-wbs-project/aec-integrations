#!/usr/bin/env bash
# AECI-80: pull staging into the local Supabase Postgres so local dev runs
# against realistic-shaped data without ever touching prod credentials.
#
# This mirrors refresh-staging.yml steps 3-8 (dump → wipe → restore → scrub
# → seed) but local-side. It is the "Local dev seeding" section of AECI-71.
#
# Usage:
#   export DIRECT_URL_STAGING='postgresql://postgres:<pw>@<host>:6543/postgres?pgbouncer=true&connection_limit=1'
#   pnpm db:start                      # boot local Supabase (port 54322)
#   pnpm db:seed-from-staging
#
# Optional overrides:
#   LOCAL_DATABASE_URL    Target local DB. Default: postgresql://postgres:postgres@127.0.0.1:54322/postgres
#
# Contract:
#   - READ-only against staging.
#   - Local public schema is dropped + recreated (idempotent re-runs are safe).
#   - Local auth.users / sessions / refresh_tokens / identities are truncated.
#   - The scrub script runs defensively after restore. Staging is already
#     scrubbed, but this script may also be pointed at a non-scrubbed source
#     in the future, so re-running it costs nothing and protects against
#     leaving live tokens on a laptop.
#   - Prod is NEVER touched. The only inbound URL is DIRECT_URL_STAGING.
#
# Exit codes:
#   0   restored + scrubbed + seeded successfully
#   1   precondition failure (missing env, local Postgres not reachable,
#       refusing to run against a non-localhost LOCAL_DATABASE_URL)
#   *   underlying pg_dump / pg_restore / psql failure

set -euo pipefail

# ── Preconditions ──────────────────────────────────────────────────────────

: "${DIRECT_URL_STAGING:?Set DIRECT_URL_STAGING to the staging Supabase pooler URL (postgresql://...). See docs/environments.md §'Local dev: seeding from staging'.}"

LOCAL_URL="${LOCAL_DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

# Refuse to run against anything that isn't loopback. Belt-and-suspenders
# guard against a typo / misset env pointing this destructive script at a
# remote DB.
case "$LOCAL_URL" in
  *@127.0.0.1:*|*@localhost:*)
    ;;
  *)
    echo "::error::LOCAL_DATABASE_URL must point at 127.0.0.1 or localhost. Got: $LOCAL_URL" >&2
    echo "This script DROPs the public schema. It will not run against a non-loopback target." >&2
    exit 1
    ;;
esac

# Tooling — fail fast with a useful message rather than partway through.
for cmd in pg_dump pg_restore psql pg_isready; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "::error::$cmd not found on PATH. Install PostgreSQL 17 client tools." >&2
    echo "  macOS:  brew install libpq && brew link --force libpq" >&2
    echo "  Linux:  see apt.postgresql.org for the postgresql-client-17 package" >&2
    exit 1
  fi
done

# Confirm the local Supabase Postgres is actually up. Without this, the
# rest of the script fails with a confusing libpq connection error.
if ! pg_isready -d "$LOCAL_URL" -q; then
  echo "::error::Local Postgres at $LOCAL_URL is not accepting connections." >&2
  echo "Run 'pnpm db:start' (which calls 'supabase start') and retry." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DUMP_DIR="$(mktemp -d -t seed-from-staging.XXXXXX)"
trap 'rm -rf "$DUMP_DIR"' EXIT

echo "→ Dumping staging into $DUMP_DIR/"

# ── 1. Dump staging ────────────────────────────────────────────────────────
#
# Three dumps, mirroring refresh-staging.yml step 3:
#   - public.dump            full public schema (data + ddl)
#   - auth-data.dump         data-only for the auth schema (Supabase owns ddl)
#   - migrations.sql         supabase_migrations.schema_migrations contents
#                            (plain SQL so it can be piped through psql)
pg_dump \
  --format=custom \
  --no-owner --no-privileges \
  --schema=public \
  --file="$DUMP_DIR/public.dump" \
  "$DIRECT_URL_STAGING"

pg_dump \
  --format=custom \
  --no-owner --no-privileges \
  --data-only --schema=auth \
  --file="$DUMP_DIR/auth-data.dump" \
  "$DIRECT_URL_STAGING"

pg_dump \
  --no-owner --no-privileges \
  --schema=supabase_migrations \
  --file="$DUMP_DIR/migrations.sql" \
  "$DIRECT_URL_STAGING"

ls -lh "$DUMP_DIR"

# ── 2. Wipe local ──────────────────────────────────────────────────────────
echo "→ Wiping local public schema + auth data + migration history"
psql -v ON_ERROR_STOP=1 "$LOCAL_URL" <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

TRUNCATE auth.refresh_tokens;
TRUNCATE auth.sessions CASCADE;
TRUNCATE auth.users CASCADE;

TRUNCATE supabase_migrations.schema_migrations;
SQL

# ── 3. Restore into local ──────────────────────────────────────────────────
echo "→ Restoring staging dumps into $LOCAL_URL"
pg_restore \
  --no-owner --no-privileges \
  --dbname="$LOCAL_URL" \
  "$DUMP_DIR/public.dump"

pg_restore \
  --no-owner --no-privileges \
  --dbname="$LOCAL_URL" \
  "$DUMP_DIR/auth-data.dump"

psql -v ON_ERROR_STOP=1 "$LOCAL_URL" -f "$DUMP_DIR/migrations.sql"

# ── 4. Defensive scrub + reseed ────────────────────────────────────────────
# Staging is already scrubbed by refresh-staging.yml step 7, so this should
# be a no-op. Running it anyway keeps the local-vs-staging shape identical
# and protects against ever pointing this script at a non-scrubbed source.
echo "→ Re-running auth credential scrub (defensive)"
psql -v ON_ERROR_STOP=1 "$LOCAL_URL" -f "$SCRIPT_DIR/scrub-auth-credentials.sql"

# `seed-staging-users.sql` is idempotent (adopt-or-mint per email). Running
# it locally gives developers the same four test accounts staging has, with
# known passwords — see scripts/seed-staging-users.sql for the credentials.
echo "→ Seeding test accounts"
psql -v ON_ERROR_STOP=1 "$LOCAL_URL" -f "$SCRIPT_DIR/seed-staging-users.sql"

echo
echo "✅ Local DB seeded from staging."
echo "   Inspect with 'pnpm db:studio' (http://localhost:54323)."
