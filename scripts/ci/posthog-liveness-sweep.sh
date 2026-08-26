#!/usr/bin/env bash
#
# AECi cron liveness sweep (AECI-647 / PH-6, docs/POSTHOG_MIGRATION_SPEC.md §3.4 + §AW6).
#
# ── Why this exists at all ──────────────────────────────────────────────────────
#
# Datadog monitors carried `notify_no_data`. No PostHog tier does. Eight of the
# twenty-six live Datadog monitors were pure absence detectors ("the Algolia sync has
# not run in 48 h"), and absence is the failure mode that matters most for a cron: a
# job that dies emits nothing, and a threshold alert on "nothing" never fires.
#
# So absence moves HERE, and here is deliberately OUTSIDE the Worker. That is the whole
# point — it is the property that made "Datadog owns absence" true. A liveness check
# hosted in the API Worker cannot detect the API Worker being dead, unbound, undeployed,
# or throwing on boot; it just stops running, silently, which is indistinguishable from
# a healthy quiet system.
#
# ── The dependency this introduces (state it, do not discover it) ───────────────
#
# The sweep now depends on GitHub Actions availability, which Datadog's `notify_no_data`
# did not. If Actions is down or the schedule is throttled, absence goes undetected for
# as long as the outage lasts. GitHub does not guarantee scheduled-workflow punctuality
# and routinely defers `schedule:` runs under load. That is why every daily window in
# project-config.json is 26 h rather than 24 h, and why the 15-minute reconcile job
# gets 90 minutes rather than 60: the margin is for the SWEEP's lateness, not the job's.
# Second line of defence, unchanged and independent: the `job_runs` table, the
# /admin/system screen, and the two daily digest emails.
#
# ── It FAILS RED. On purpose. ───────────────────────────────────────────────────
#
# Every other telemetry step in this repo is best-effort and swallows its failures
# (scripts/ci/posthog-deploy-marker.sh always exits 0; the deploy workflows call it with
# continue-on-error). This one is the opposite, and a future reader will be tempted to
# "fix" it into `continue-on-error: true` for consistency. Do not. A liveness sweep that
# cannot fail is not a liveness sweep. The precedent to follow is
# .github/workflows/reconcile-counts.yml, which is also a scheduled correctness guard
# that fails red — not the deploy-marker convention.
#
# ── Usage ───────────────────────────────────────────────────────────────────────
#
#   POSTHOG_CLI_API_KEY=phx_...  ./scripts/ci/posthog-liveness-sweep.sh
#
#   POSTHOG_CLI_API_KEY / POSTHOG_PERSONAL_API_KEY  required — personal key, `query read`
#   PH_PROJECT_ID        optional — defaults to project-config.json's prod id (354071)
#   PH_APP_HOST          optional — management host; defaults to the config value.
#                                   us.posthog.com is MANAGEMENT; us.i.posthog.com is
#                                   INGEST and has no /query endpoint (confusing 404).
#   PH_LIVENESS_CONFIG   optional — path to the config JSON. Overridable so the failure
#                                   path can be DRILLED against a fixture instead of
#                                   waiting for a real cron to die.
#
# Exit codes: 0 every heartbeat fresh · 1 one or more stale/missing · 2 could not check.
#
# Note the asymmetry between 1 and 2: "the sweep could not run" is NOT "the crons are
# fine". Both are red, and the annotations say which is which.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CONFIG="${PH_LIVENESS_CONFIG:-$REPO_ROOT/observability/posthog/project-config.json}"

for tool in jq curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "::error::posthog-liveness-sweep: '$tool' is required and not on PATH."
    exit 2
  fi
done

if [ ! -f "$CONFIG" ]; then
  echo "::error::posthog-liveness-sweep: config not found at ${CONFIG}."
  exit 2
fi

API_KEY="${POSTHOG_CLI_API_KEY:-${POSTHOG_PERSONAL_API_KEY:-}}"
if [ -z "$API_KEY" ]; then
  echo "::error::posthog-liveness-sweep: no personal API key. Set the POSTHOG_CLI_API_KEY repo secret to a phx_ key with 'query read' on project 354071 (docs/POSTHOG_MIGRATION_SPEC.md §7 / §8.7). Cron liveness is UNCHECKED until then — this is not a pass."
  exit 2
fi

APP_HOST="${PH_APP_HOST:-$(jq -r '.hosts.management' "$CONFIG")}"
PROJECT_KEY="$(jq -r '.liveness.project' "$CONFIG")"
PROJECT_ID="${PH_PROJECT_ID:-$(jq -r --arg k "$PROJECT_KEY" '.projects[] | select(.key == $k) | .id' "$CONFIG")}"
LOOKBACK_HOURS="$(jq -r '.liveness.lookbackHours' "$CONFIG")"

if [ -z "${PROJECT_ID:-}" ] || [ "$PROJECT_ID" = "null" ]; then
  echo "::error::posthog-liveness-sweep: could not resolve a project id for liveness.project='${PROJECT_KEY}'."
  exit 2
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/aeci-liveness.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# ── Build the query ─────────────────────────────────────────────────────────────
#
# ONE query for all twelve crons rather than twelve queries: one round trip, one place
# to read the whole picture, and no chance of a partial sweep reporting a partial pass.
# `dateDiff` happens server-side so the shell only ever compares integers — no clock
# skew between the runner and PostHog, and no date parsing in bash.
#
# A cron whose metric has NO rows in the lookback window is ABSENT FROM THE RESULT SET
# entirely. That is the case that matters most, and it is handled below by iterating the
# EXPECTED list and looking each one up — never by iterating what came back.
# The SQL is assembled by jq, not by string-mashing in bash: jq quotes every metric
# name and then JSON-escapes the whole statement, so a name containing a quote is
# impossible to inject and the payload is valid by construction rather than by hope.
if ! jq -n \
  --argjson hours "$LOOKBACK_HOURS" \
  --slurpfile cfg "$CONFIG" \
  '
  ($cfg[0].liveness.crons | map("      '"'"'" + .metric + "'"'"'") | join(",\n")) as $metrics
  | {
      name: "aeci-cron-liveness-sweep",
      query: {
        kind: "HogQLQuery",
        query: (
          "SELECT\n" +
          "    m.metric_name                               AS heartbeat_metric,\n" +
          "    max(m.timestamp)                            AS last_seen,\n" +
          "    dateDiff('"'"'minute'"'"', max(m.timestamp), now()) AS age_minutes\n" +
          "FROM posthog.metrics AS m\n" +
          "WHERE m.timestamp >= now() - INTERVAL " + ($hours | tostring) + " HOUR\n" +
          "  AND m.metric_name IN (\n" + $metrics + "\n  )\n" +
          "GROUP BY heartbeat_metric"
        )
      }
    }' > "$TMP/query.json"
then
  echo "::error::posthog-liveness-sweep: could not build the query payload from ${CONFIG}."
  exit 2
fi

# ── Ask PostHog ─────────────────────────────────────────────────────────────────
STATUS="$(curl -sS -o "$TMP/response.json" -w '%{http_code}' \
  -X POST "${APP_HOST}/api/projects/${PROJECT_ID}/query/" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer ${API_KEY}" \
  --max-time 60 \
  --data-binary "@$TMP/query.json" 2>"$TMP/curl.err")" || STATUS='000'

if [ "$STATUS" != "200" ]; then
  echo "::error::posthog-liveness-sweep: query returned HTTP ${STATUS}. Cron liveness is UNCHECKED for this run — treat it as unknown, not as healthy."
  echo "  host:    ${APP_HOST}"
  echo "  project: ${PROJECT_ID}"
  echo "  body:    $(head -c 400 "$TMP/response.json" 2>/dev/null | tr '\n' ' ')"
  echo "  curl:    $(head -c 200 "$TMP/curl.err" 2>/dev/null | tr '\n' ' ')"
  exit 2
fi

# `.results` is the documented HogQLQuery response key; `.result` is what the insight
# read path returns. Accepting both costs one alternation and removes a whole class of
# "worked in the console, 0 rows in CI" confusion.
if ! jq -e '(.results // .result) | type == "array"' "$TMP/response.json" >/dev/null 2>&1; then
  echo "::error::posthog-liveness-sweep: response had no 'results' array. Cron liveness is UNCHECKED for this run."
  echo "  body: $(head -c 400 "$TMP/response.json" 2>/dev/null | tr '\n' ' ')"
  exit 2
fi

# `metric<TAB>last_seen<TAB>age_minutes`, one line per series that reported.
jq -r '(.results // .result)[] | [(.[0] // ""), (.[1] // ""), ((.[2] // 0) | tostring)] | @tsv' \
  "$TMP/response.json" > "$TMP/seen.tsv"

# ── Compare EXPECTED against SEEN ───────────────────────────────────────────────
STALE=0
FRESH=0
printf '%-24s %-34s %10s %10s   %s\n' "JOB" "HEARTBEAT METRIC" "AGE(min)" "MAX(min)" "STATE"
printf '%-24s %-34s %10s %10s   %s\n' "------------------------" "----------------------------------" "----------" "----------" "-----"

CRON_COUNT="$(jq -r '.liveness.crons | length' "$CONFIG")"
I=0
while [ "$I" -lt "$CRON_COUNT" ]; do
  JOB="$(jq -r --argjson i "$I" '.liveness.crons[$i].job' "$CONFIG")"
  METRIC="$(jq -r --argjson i "$I" '.liveness.crons[$i].metric' "$CONFIG")"
  MAX_AGE="$(jq -r --argjson i "$I" '.liveness.crons[$i].maxAgeMinutes' "$CONFIG")"
  SCHEDULE="$(jq -r --argjson i "$I" '.liveness.crons[$i].cron' "$CONFIG")"
  I=$((I + 1))

  AGE="$(awk -F'\t' -v m="$METRIC" '$1 == m { print $3; exit }' "$TMP/seen.tsv")"

  if [ -z "${AGE:-}" ]; then
    printf '%-24s %-34s %10s %10s   %s\n' "$JOB" "$METRIC" "none" "$MAX_AGE" "MISSING"
    echo "::error title=Cron heartbeat MISSING: ${JOB}::No '${METRIC}' data point in the last ${LOOKBACK_HOURS} h on PostHog project ${PROJECT_ID}. The cron '${SCHEDULE}' has not run, or the Worker is not emitting. Check /admin/system (job_runs) and the Cloudflare cron trigger for apps/api."
    STALE=$((STALE + 1))
    continue
  fi

  if [ "$AGE" -gt "$MAX_AGE" ]; then
    printf '%-24s %-34s %10s %10s   %s\n' "$JOB" "$METRIC" "$AGE" "$MAX_AGE" "STALE"
    echo "::error title=Cron heartbeat STALE: ${JOB}::'${METRIC}' last reported ${AGE} minutes ago; the '${SCHEDULE}' schedule allows ${MAX_AGE}. Check /admin/system (job_runs) and the Cloudflare cron trigger for apps/api."
    STALE=$((STALE + 1))
  else
    printf '%-24s %-34s %10s %10s   %s\n' "$JOB" "$METRIC" "$AGE" "$MAX_AGE" "ok"
    FRESH=$((FRESH + 1))
  fi
done

echo ""
if [ "$STALE" -gt 0 ]; then
  echo "::error::posthog-liveness-sweep: ${STALE} of $((STALE + FRESH)) cron heartbeats are stale or missing on PostHog project ${PROJECT_ID}."
  echo "This replaces the eight Datadog notify_no_data monitors. It is MEANT to be red here."
  echo "Runbook: docs/RUNBOOKS.md — 'Cron not running'; the schedules are"
  echo "apps/api/src/lib/cron-schedules.ts and the heartbeat metrics are"
  echo "observability/posthog/project-config.json -> liveness.crons[]."
  exit 1
fi

echo "posthog-liveness-sweep: all ${FRESH} cron heartbeats fresh on project ${PROJECT_ID}."
exit 0
