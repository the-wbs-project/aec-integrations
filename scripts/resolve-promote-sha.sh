#!/usr/bin/env bash
# Pick the commit a promote ships (promote-to-demo.yml, promote-to-prod.yml).
#
# `commit_sha` is optional on both promote buttons. Left blank, the promote
# ships whatever the immediate upstream tier is running: staging for a demo
# promote, demo for a prod promote. That is the commit the operator would have
# pasted, so a phone dispatch needs no SHA lookup.
#
#   INPUT_SHA set   → must be a full 40-char lowercase hex SHA. Used as given.
#                     The caller's verify-version.sh step then asserts the
#                     upstream tier is at it, exactly as before.
#   INPUT_SHA blank → read HOST/api/version (API Worker) and HOST/_version (SSR
#                     Worker). Both must report the same 40-char SHA. A split
#                     tier (mid-deploy, or a stale SSR bundle) is refused, never
#                     guessed between.
#
# Writes `sha=<sha>` to $GITHUB_OUTPUT and a line to $GITHUB_STEP_SUMMARY when
# those are set. Like verify-version.sh it does not retry.
#
# Usage (env):
#   HOST                    upstream tier, e.g. https://staging.aecintegrations.com (required)
#   INPUT_SHA               the workflow's commit_sha input, may be empty
#   CF_ACCESS_CLIENT_ID     service-token client id     (optional; staging is Access-gated)
#   CF_ACCESS_CLIENT_SECRET service-token client secret (optional)
#
# Exit codes:
#   0   a SHA was chosen
#   1   bad input shape, upstream unreachable, or the two Workers disagree

set -euo pipefail

: "${HOST:?HOST is required, e.g. https://staging.aecintegrations.com}"
INPUT_SHA="$(printf '%s' "${INPUT_SHA:-}" | tr -d '[:space:]')"

sha_re='^[0-9a-f]{40}$'

emit() {
  local sha="$1" source="$2"
  echo "Promoting $sha ($source)"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "sha=$sha" >> "$GITHUB_OUTPUT"
  fi
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "### Promoting \`$sha\` ($source)" >> "$GITHUB_STEP_SUMMARY"
  fi
}

if [ -n "$INPUT_SHA" ]; then
  if ! printf '%s' "$INPUT_SHA" | grep -Eq "$sha_re"; then
    echo "::error::commit_sha must be a full 40-char lowercase hex SHA, or blank to use what $HOST is running (received: '$INPUT_SHA')"
    exit 1
  fi
  emit "$INPUT_SHA" "commit_sha input"
  exit 0
fi

hdrs=()
if [ -n "${CF_ACCESS_CLIENT_ID:-}" ] && [ -n "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
  hdrs+=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID")
  hdrs+=(-H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
fi

api_sha="$(curl -fsS ${hdrs[@]+"${hdrs[@]}"} "$HOST/api/version" | jq -r '.sha // empty')" || api_sha=""
ssr_sha="$(curl -fsS ${hdrs[@]+"${hdrs[@]}"} "$HOST/_version" | jq -r '.sha // empty')" || ssr_sha=""

if [ "$api_sha" != "$ssr_sha" ] || ! printf '%s' "$api_sha" | grep -Eq "$sha_re"; then
  echo "::error::commit_sha was blank, and $HOST does not report one SHA on both Workers (api='$api_sha' ssr='$ssr_sha'). Wait for its deploy to finish, or pass commit_sha."
  exit 1
fi

emit "$api_sha" "running on $HOST"
