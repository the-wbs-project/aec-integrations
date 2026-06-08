#!/usr/bin/env bash
# Postflight gate: assert that a deployed Worker ACTUALLY carries its required
# runtime secrets.
#
# `require-secrets.sh` (preflight) proves the GH Actions *source* secret exists;
# this proves the secret actually landed on the Worker after the deploy +
# `wrangler secret put` steps. It is the literal enforcement of "the environment
# has the variables it needs" — it inspects the live Worker via
# `wrangler secret list` (which returns secret NAMES, never values), independent
# of how the secret got there. Catches a push that silently no-op'd, a removed
# push step, or a secret set on the wrong Worker/env.
#
# Run from the Worker's package directory (e.g. apps/api) so `wrangler` resolves
# the env→Worker-name mapping from that package's wrangler.jsonc. Needs
# CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment.
#
# `wrangler secret list` prints a JSON array `[{"name":…,"type":…}]` on stdout
# (its banner goes to stderr, hence `2>/dev/null`).
#
# Usage (env):
#   WRANGLER_ENV               wrangler env block to inspect, e.g. staging|production (required)
#   REQUIRED_WORKER_SECRETS    space-separated secret NAMES that must be present     (required)
#
# Exit codes:
#   0   every name in REQUIRED_WORKER_SECRETS is present on the Worker
#   1   the list call failed, or one or more required secrets are absent

set -euo pipefail

: "${WRANGLER_ENV:?WRANGLER_ENV is required (e.g. staging|production)}"
: "${REQUIRED_WORKER_SECRETS:?REQUIRED_WORKER_SECRETS is required (space-separated names)}"

present="$(pnpm exec wrangler secret list --env "$WRANGLER_ENV" 2>/dev/null | jq -r '.[].name')" || {
  echo "::error::[$WRANGLER_ENV] could not list Worker secrets (wrangler secret list failed — check CLOUDFLARE_API_TOKEN/ACCOUNT_ID and the working directory)."
  exit 1
}

missing=()
for name in $REQUIRED_WORKER_SECRETS; do
  if ! printf '%s\n' "$present" | grep -Fqx "$name"; then
    missing+=("$name")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::[$WRANGLER_ENV] Worker is MISSING required runtime secret(s): ${missing[*]}. CI pushes these from GH secrets right after the deploy — a failure here means the source GH secret was empty or the push didn't persist. Set the GH secret and re-run."
  exit 1
fi

echo "verify-worker-secrets ok [$WRANGLER_ENV]: ${REQUIRED_WORKER_SECRETS// /, } present"
