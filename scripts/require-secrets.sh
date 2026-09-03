#!/usr/bin/env bash
# Preflight gate: refuse to deploy/promote to an environment when a REQUIRED
# secret is missing.
#
# THE RULE (do not promote to an environment if the variables it needs are
# missing): every deploy/promote job runs this BEFORE any mutating step
# (migration, pg_dump, Worker deploy). If a required secret is absent the job
# fails immediately — nothing is deployed, no DB is touched — so an environment
# can never be half-provisioned. Recommended-but-optional secrets only warn.
#
# It checks the VALUES of named environment variables, which the caller maps
# from `${{ secrets.* }}` in an `env:` block. The check is value-presence
# (non-empty), so it catches both "GH secret never created" and "created empty".
# It lists ALL missing required secrets at once (not fail-on-first) so an
# operator fixes them in one pass.
#
# Companion gates: scripts/verify-worker-secrets.sh (postflight — asserts the
# Worker actually carries its runtime secrets after deploy) and
# scripts/verify-health.sh (postflight — asserts the DB is reachable).
#
# Usage (env):
#   ENV_LABEL              human label for messages, e.g. staging|production  (required)
#   REQUIRED_SECRETS      space-separated env-var NAMES that must be non-empty (required)
#   RECOMMENDED_SECRETS   space-separated env-var NAMES that only warn         (optional)
# The named variables themselves must be present in the environment (mapped
# from GH Actions secrets by the calling step).
#
# Exit codes:
#   0   every REQUIRED_SECRETS var is non-empty (recommended misses only warn)
#   1   one or more REQUIRED_SECRETS vars are empty/unset

set -euo pipefail

: "${ENV_LABEL:?ENV_LABEL is required (e.g. staging|production)}"
: "${REQUIRED_SECRETS:?REQUIRED_SECRETS is required (space-separated env-var names)}"

# Warn on each missing recommended secret (deploy still proceeds).
for name in ${RECOMMENDED_SECRETS:-}; do
  if [ -z "${!name:-}" ]; then
    echo "::warning::[$ENV_LABEL] recommended secret '$name' is not set — the deploy proceeds, but the feature that secret powers is degraded. See its row in docs/environments.md §Secrets for what stops working."
  fi
done

# Collect ALL missing required secrets so they can be fixed in one pass.
missing=()
for name in $REQUIRED_SECRETS; do
  if [ -z "${!name:-}" ]; then
    missing+=("$name")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::[$ENV_LABEL] REFUSING to deploy — required secret(s) missing: ${missing[*]}. Set each via 'gh secret set <NAME>' (repo Settings → Secrets and variables → Actions) before deploying. See docs/environments.md §Secrets."
  exit 1
fi

echo "require-secrets ok [$ENV_LABEL]: all required present (${REQUIRED_SECRETS// /, })"
