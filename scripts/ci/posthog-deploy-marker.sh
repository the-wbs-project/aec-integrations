#!/usr/bin/env bash
#
# PostHog deploy marker (AECI-640 / docs/POSTHOG_MIGRATION_SPEC.md §AW5).
#
# Records that a deploy happened, on TWO surfaces, because they answer two
# different questions and neither substitutes for the other:
#
#   1. A project **annotation** — the vertical line PostHog draws across every
#      insight and dashboard. This is what makes "the p95 stepped up at 14:02"
#      readable at a glance. Annotations are a management-API object, so this
#      leg needs a personal `phx_` key (POSTHOG_CLI_API_KEY) and a numeric
#      project id.
#   2. A queryable `deployment` **event** — the annotation is decoration; the
#      event is data. It is what a HogQL query joins against to answer "which
#      deploy introduced this error" or "how many deploys did we ship this
#      week". This leg authenticates with the publishable `phc_` project token,
#      which since AECI-640 is a committed wrangler var, so it is always
#      available — including on PR previews and forks.
#
# BOTH legs are best-effort and the script ALWAYS exits 0. A PostHog outage,
# a rotated key, or a missing repo variable must never fail or block a deploy;
# call the step with `continue-on-error: true` as a second layer. The failure
# mode we are protecting against is the AECI-326 one in reverse — there, a
# silent skip hid a real gap for weeks, so every skip here prints a GitHub
# `::warning::` that shows up on the job page rather than only in the log body.
#
# Usage (all values via env):
#
#   PH_EVENT_ENV        required  deployment tier: preview|staging|demo|production|stage2
#   PH_SERVICE          required  which Worker(s): aeci-web|aeci-api|both
#   PH_VERSION          required  the commit SHA being deployed
#   PH_DEPLOY_KIND      optional  deploy|promote|preview|auto_rollback   (default: deploy)
#   PH_PROJECT_KEY      required  publishable `phc_` token for the target project
#   PH_HOST             optional  ingest host        (default https://us.i.posthog.com)
#   PH_APP_HOST         optional  management host    (default https://us.posthog.com)
#   POSTHOG_CLI_API_KEY optional  personal `phx_` key — absent ⇒ annotation leg warn-skips
#   PH_PROJECT_ID       optional  numeric project id — absent ⇒ annotation leg warn-skips
#   PH_NOTE             optional  extra text appended to the annotation content
#
# `us.posthog.com` is the MANAGEMENT API (annotations); `us.i.posthog.com` is
# the INGEST host (events). Swapping them yields a confusing 404 — hence the two
# separate host variables rather than one.

set -uo pipefail   # deliberately NOT -e: every failure here is non-fatal.

PH_HOST="${PH_HOST:-https://us.i.posthog.com}"
PH_APP_HOST="${PH_APP_HOST:-https://us.posthog.com}"
PH_DEPLOY_KIND="${PH_DEPLOY_KIND:-deploy}"
PH_NOTE="${PH_NOTE:-}"

for required in PH_EVENT_ENV PH_SERVICE PH_VERSION; do
  if [ -z "${!required:-}" ]; then
    echo "::warning::posthog-deploy-marker: ${required} is empty — skipping both legs."
    exit 0
  fi
done

SHORT_SHA="$(printf '%s' "$PH_VERSION" | cut -c1-7)"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
CONTENT="${PH_DEPLOY_KIND} → ${PH_EVENT_ENV} (${PH_SERVICE}) @ ${SHORT_SHA}"
if [ -n "$PH_NOTE" ]; then
  CONTENT="${CONTENT} — ${PH_NOTE}"
fi

# An auto-rollback is an incident marker, not a release marker — give it the
# emoji that reads as one at a glance on a dashboard.
EMOJI='🚀'
if [ "$PH_DEPLOY_KIND" = "auto_rollback" ]; then
  EMOJI='🔥'
fi

# ── Leg 1: queryable `deployment` event (publishable phc_ token) ─────────────
#
# `$process_person_profile: false` keeps CI out of the person table entirely —
# a deploy is not a user, and minting a person per deploy would corrupt every
# person-linked view. `/capture/` is the correct single-event intake; note
# `/i/v1/e/` does NOT exist and returns a 404 that looks like a config error.
if [ -z "${PH_PROJECT_KEY:-}" ]; then
  echo "::warning::posthog-deploy-marker: PH_PROJECT_KEY is empty — skipping the deployment event. Deploy tracking will have a gap for ${PH_EVENT_ENV} @ ${SHORT_SHA}."
else
  event_payload="$(
    PH_PROJECT_KEY="$PH_PROJECT_KEY" \
    PH_EVENT_ENV="$PH_EVENT_ENV" \
    PH_SERVICE="$PH_SERVICE" \
    PH_VERSION="$PH_VERSION" \
    PH_DEPLOY_KIND="$PH_DEPLOY_KIND" \
    NOW="$NOW" \
    python3 -c '
import json, os
print(json.dumps({
    "api_key": os.environ["PH_PROJECT_KEY"],
    "event": "deployment",
    "distinct_id": "aeci-ci",
    "timestamp": os.environ["NOW"],
    "properties": {
        "env": os.environ["PH_EVENT_ENV"],
        "service": os.environ["PH_SERVICE"],
        "version": os.environ["PH_VERSION"],
        "deploy_kind": os.environ["PH_DEPLOY_KIND"],
        "app": "aeci",
        "workflow": os.environ.get("GITHUB_WORKFLOW", ""),
        "run_url": "%s/%s/actions/runs/%s" % (
            os.environ.get("GITHUB_SERVER_URL", ""),
            os.environ.get("GITHUB_REPOSITORY", ""),
            os.environ.get("GITHUB_RUN_ID", ""),
        ),
        "$process_person_profile": False,
    },
}))'
  )"
  status="$(curl -sS -o /tmp/ph-marker-event.txt -w '%{http_code}' -X POST "${PH_HOST}/capture/" \
    -H 'content-type: application/json' \
    --max-time 15 \
    -d "$event_payload" 2>/dev/null)" || status='000'
  if [ "$status" = "200" ]; then
    echo "posthog-deploy-marker: deployment event recorded (${CONTENT})."
  else
    echo "::warning::posthog-deploy-marker: deployment event POST returned ${status} — $(head -c 200 /tmp/ph-marker-event.txt 2>/dev/null). Non-fatal."
  fi
fi

# ── Leg 2: project annotation (personal phx_ key) ────────────────────────────
if [ -z "${POSTHOG_CLI_API_KEY:-}" ] || [ -z "${PH_PROJECT_ID:-}" ]; then
  echo "::warning::posthog-deploy-marker: POSTHOG_CLI_API_KEY and/or PH_PROJECT_ID unset — skipping the annotation. Insights will not show a deploy line for ${PH_EVENT_ENV} @ ${SHORT_SHA}. Provision the phx_ key + the POSTHOG_PROJECT_ID_* repo variables (AECI-640 operator steps)."
  exit 0
fi

annotation_payload="$(
  CONTENT="$CONTENT" NOW="$NOW" EMOJI="$EMOJI" python3 -c '
import json, os
print(json.dumps({
    "content": os.environ["CONTENT"],
    "date_marker": os.environ["NOW"],
    "scope": "project",
    "emoji": os.environ["EMOJI"],
}))'
)"
status="$(curl -sS -o /tmp/ph-marker-annotation.txt -w '%{http_code}' -X POST \
  "${PH_APP_HOST}/api/projects/${PH_PROJECT_ID}/annotations/" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer ${POSTHOG_CLI_API_KEY}" \
  --max-time 15 \
  -d "$annotation_payload" 2>/dev/null)" || status='000'
if [ "$status" = "201" ] || [ "$status" = "200" ]; then
  echo "posthog-deploy-marker: annotation created in project ${PH_PROJECT_ID}."
else
  echo "::warning::posthog-deploy-marker: annotation POST returned ${status} — $(head -c 200 /tmp/ph-marker-annotation.txt 2>/dev/null). Non-fatal."
fi

exit 0
