#!/usr/bin/env bash
#
# PostHog source-map inject + upload (AECI-646 / docs/POSTHOG_MIGRATION_SPEC.md §AW5).
#
# Runs AFTER `pnpm --filter @aeci/web build` and BEFORE the SSR deploy, in that
# order, because `sourcemap inject` REWRITES the built JS — it appends a
# `//# chunkId=…` comment to each chunk. PostHog matches a minified stack frame
# to an uploaded map by that chunk id, so deploying the pre-inject bundle would
# upload maps that can never be matched to anything. Inject → upload → deploy.
#
# Angular is configured (apps/web/angular.json, `production` configuration) with
# HIDDEN source maps: the `.map` files are emitted but no `//# sourceMappingURL=`
# comment is written into the served JS. That is what keeps our source off the
# public internet while still giving PostHog something to symbolicate with.
#
# THE SKIP PATH STILL DELETES THE MAPS. This is the whole safety property and
# the easiest thing to get wrong: if `POSTHOG_CLI_API_KEY` is absent we cannot
# upload, but the `.map` files are sitting in `dist/browser`, and Worker assets
# are served verbatim — so a warn-and-return-early would publish the entire
# unminified source of the app at a guessable URL. Every exit path from this
# script deletes the maps. `--delete-after` handles the success path; the
# explicit sweep below handles every other one.
#
# Usage (env):
#   PH_SM_DIR            optional  asset directory        (default apps/web/dist/browser)
#   PH_SM_RELEASE_NAME   optional  release name           (default aeci-web)
#   PH_SM_RELEASE_VERSION required  commit SHA
#   POSTHOG_CLI_API_KEY  optional  personal key, scopes `error tracking write`
#                                  + `organization read`. Absent ⇒ warn-skip.
#   POSTHOG_CLI_PROJECT_ID required-with-key  numeric project id
#   POSTHOG_CLI_HOST     optional  MANAGEMENT host (default https://us.posthog.com)
#
# Note POSTHOG_CLI_HOST is the MANAGEMENT host (`us.posthog.com`), not the
# ingest host (`us.i.posthog.com`) the Workers post telemetry to. They are
# different hosts and swapping them produces a confusing 404.
#
# `POSTHOG_CLI_API_KEY` is CI-only and must NEVER become a Worker secret — it is
# a personal key with write scopes, a completely different security class from
# the publishable `phc_` project token the Workers use.
#
# VERIFYING THE HIDDEN-MAP CONTRACT: `grep -rl sourceMappingURL dist/browser`
# returns exactly ONE file, and that is expected. The posthog-js
# `module.full.no-external` bundle embeds the session-replay web-worker as a
# template literal whose text ends in a `//# sourceMappingURL=…` line. It sits
# ~14% into that chunk, points at a map that is not shipped, and is string
# content rather than a trailing comment on our output. Check the position, not
# just the count: a real leak would be at the END of a chunk and its `.map`
# would exist in `dist/`.

set -uo pipefail   # NOT -e: we must always reach the map sweep.

PH_SM_DIR="${PH_SM_DIR:-apps/web/dist/browser}"
PH_SM_RELEASE_NAME="${PH_SM_RELEASE_NAME:-aeci-web}"
PH_SM_RELEASE_VERSION="${PH_SM_RELEASE_VERSION:-}"
POSTHOG_CLI_HOST="${POSTHOG_CLI_HOST:-https://us.posthog.com}"
export POSTHOG_CLI_HOST

sweep_maps() {
  local count
  count="$(find "$PH_SM_DIR" -name '*.map' -type f 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${count:-0}" != "0" ]; then
    find "$PH_SM_DIR" -name '*.map' -type f -delete 2>/dev/null
    echo "posthog-sourcemaps: deleted ${count} .map file(s) from ${PH_SM_DIR} — they must never be deployed."
  fi
}

if [ ! -d "$PH_SM_DIR" ]; then
  echo "::warning::posthog-sourcemaps: ${PH_SM_DIR} does not exist — nothing to do. Did the build step run?"
  exit 0
fi

if [ -z "${POSTHOG_CLI_API_KEY:-}" ] || [ -z "${POSTHOG_CLI_PROJECT_ID:-}" ]; then
  echo "::warning::posthog-sourcemaps: POSTHOG_CLI_API_KEY and/or POSTHOG_CLI_PROJECT_ID unset — skipping inject+upload. Production stack traces in PostHog Error Tracking will stay MINIFIED until the operator provisions them (AECI-640). Deleting the maps anyway so they are never served."
  sweep_maps
  exit 0
fi

if [ -z "$PH_SM_RELEASE_VERSION" ]; then
  echo "::warning::posthog-sourcemaps: PH_SM_RELEASE_VERSION is empty — skipping inject+upload rather than uploading an unattributable release."
  sweep_maps
  exit 0
fi

# `--release-name` is passed EXPLICITLY on purpose. The CLI otherwise tries to
# derive it from git and warns "Could not create release - no project name
# provided, and one could not be derived via git" (PostHog/posthog#38012),
# which produces uploads that are not tied to a release — exactly the thing
# that makes "which deploy introduced this error" unanswerable.
echo "posthog-sourcemaps: injecting chunk ids into ${PH_SM_DIR}…"
if ! npx --yes @posthog/cli@latest sourcemap inject --directory "$PH_SM_DIR"; then
  echo "::warning::posthog-sourcemaps: inject failed — skipping upload. Stack traces stay minified for ${PH_SM_RELEASE_VERSION}. Non-fatal."
  sweep_maps
  exit 0
fi

echo "posthog-sourcemaps: uploading maps for ${PH_SM_RELEASE_NAME}@${PH_SM_RELEASE_VERSION}…"
if ! npx --yes @posthog/cli@latest sourcemap upload \
      --directory "$PH_SM_DIR" \
      --release-name "$PH_SM_RELEASE_NAME" \
      --release-version "$PH_SM_RELEASE_VERSION" \
      --delete-after; then
  echo "::warning::posthog-sourcemaps: upload failed — stack traces stay minified for ${PH_SM_RELEASE_VERSION}. Non-fatal."
fi

# Belt and braces: `--delete-after` should have removed them, but a partial
# upload or a CLI change must not leave a single map behind.
sweep_maps
exit 0
