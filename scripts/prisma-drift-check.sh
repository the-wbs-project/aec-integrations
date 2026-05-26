#!/usr/bin/env bash
# AECI-77: mechanical drift check between apps/api/prisma/schema.prisma and a
# live Postgres database, reused by sub-issue (c) promote-to-prod.yml and
# sub-issue (e) drift-check.yml.
#
# Implements AECI-71 "Drift detection (three layers)" snippet verbatim:
#
#   prisma db pull --schema=./prisma/schema.prisma --print > /tmp/db-actual.prisma
#   prisma migrate diff \
#     --from-schema-datamodel ./prisma/schema.prisma \
#     --to-schema-datamodel /tmp/db-actual.prisma \
#     --exit-code
#
# Usage:
#   scripts/prisma-drift-check.sh <DATABASE_URL>
#
# Exit codes:
#   0   schemas match
#   1   non-empty diff (drift detected) — caller MUST treat as hard stop
#   2   misuse (missing URL argument)
#   *   `prisma db pull` or `prisma migrate diff` failure (e.g. connection
#       refused, P4002 introspection error)
#
# KNOWN ISSUE — P4002 on cross-schema FK:
#   `prisma db pull` against any DB containing the FK
#   `public.profiles.id -> auth.users(id)` fails with Prisma error P4002
#   ("Cross schema references are only allowed when the target schema is
#   listed in the schemas property of your datasource"). See docs/prisma.md §7.
#   Until that FK is resolved by the issue that owns it, refresh-staging
#   step 9 will hard-stop here on every run. That is the spec-mandated
#   behavior (HARD STOP on drift), so the workflow correctly skips the
#   Worker deploys in step 10. Run this script locally against the local
#   Supabase container to verify it works end-to-end once the FK is fixed.

set -euo pipefail

if [ -z "${1-}" ]; then
  echo "usage: $(basename "$0") <DATABASE_URL>" >&2
  exit 2
fi

DB_URL="$1"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_DIR="$REPO_ROOT/apps/api"

cd "$API_DIR"

# `apps/api/prisma/schema.prisma` declares both `url = env("DATABASE_URL")`
# and `directUrl = env("DIRECT_URL")`. Prisma's `get-config` validates both
# env vars whenever it loads the schema (regardless of which connection it
# would actually use), so we set them to the same value here. Against the
# DB URLs this script is called with (local Postgres in drift-check.yml,
# `DIRECT_URL_STAGING`/`DIRECT_URL_PRODUCTION` in the refresh/promote
# workflows) there is no Accelerate intermediary — directUrl == url.
export DATABASE_URL="$DB_URL"
export DIRECT_URL="$DB_URL"

# --print writes the introspected datamodel to stdout instead of overwriting
# schema.prisma — so we can diff schema.prisma (expected) against actual.
pnpm exec prisma db pull \
  --schema=./prisma/schema.prisma \
  --print > /tmp/db-actual.prisma

pnpm exec prisma migrate diff \
  --from-schema-datamodel ./prisma/schema.prisma \
  --to-schema-datamodel /tmp/db-actual.prisma \
  --exit-code
