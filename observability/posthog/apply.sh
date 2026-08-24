#!/usr/bin/env bash
#
# AECi PostHog observability applier (AECI-647 / PH-6, docs/POSTHOG_MIGRATION_SPEC.md §AW6).
#
# A THIN applier over the committed JSON in this directory. It invents nothing: every
# dashboard, insight, alert, name, query and threshold comes from insights.json /
# alerts.json / project-config.json. If something is wrong on the live project, fix the
# JSON and re-run — do not fix it in the UI, because the next run will not know.
#
# ── What it does ────────────────────────────────────────────────────────────────
#   dashboards  → BOTH projects (prod 354071 + non-prod 525793)
#   insights    → BOTH projects, attached to their dashboard
#   alerts      → PROD ONLY. A preview deploy failing a cron is not an incident, and the
#                 same alert firing from two projects trains the operator to ignore it.
#
# ── Design rules this file is held to (spec §4, verbatim from the EV migration) ──
#   * Fails LOUDLY with a per-project failure summary, while still COMPLETING the run.
#     A half-applied plane that stops at the first 400 is worse than a full run plus an
#     accurate list of what broke — you cannot plan a fix from a truncated report.
#   * Idempotent BY NAME. Re-running is the normal case (a new insight lands, a threshold
#     moves); it must not mint duplicates.
#   * Preflight probes EVERY optional scope up front and reports ALL misses at once.
#     One-at-a-time scope discovery means N runs to find N missing scopes.
#   * --dry-run and --verify.
#   * Prints a RECREATE RECIPE instead of an API call for anything it cannot express.
#   * Stock macOS bash 3.2. See the portability note below.
#   * Reads the personal key from POSTHOG_PERSONAL_API_KEY *or* POSTHOG_CLI_API_KEY.
#     It is a local/operator tool — it CANNOT read the GitHub secret of the same name.
#
# ── bash 3.2 portability (macOS ships 3.2.57 from 2007 and always will) ──────────
#   NO `declare -A` (associative arrays)   — 4.0+
#   NO namerefs (`local -n`, `${!var}`)    — 4.3+ / awkward in 3.2
#   NO `mapfile` / `readarray`             — 4.0+
#   `:-` guard on EVERY array expansion    — `set -u` + an empty array is an unbound error
#   NEVER `((${#ARR[@]})) && cmd`          — arithmetic returning 0 exits 1, and under
#                                            `set -e` that KILLS THE SCRIPT on an empty
#                                            array. Use `if [ ${#ARR[@]} -gt 0 ]`.
#   The `key<TAB>value` flat-file idiom below replaces the associative arrays.
#
# ── Usage ───────────────────────────────────────────────────────────────────────
#   export POSTHOG_PERSONAL_API_KEY=phx_...       # or POSTHOG_CLI_API_KEY
#   ./observability/posthog/apply.sh --dry-run    # plan only, no writes, no key needed
#   ./observability/posthog/apply.sh              # apply
#   ./observability/posthog/apply.sh --verify     # read-only drift report
#   ./observability/posthog/apply.sh --only prod  # restrict to one project key
#
# Exit codes: 0 clean · 1 one or more operations failed · 2 bad usage / missing tooling.

set -uo pipefail
# NOT `set -e`: this script's whole contract is "complete the run, then report every
# failure". `set -e` would abort on the first non-zero curl and produce exactly the
# truncated report the contract forbids. Every fallible call is checked explicitly.

HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$HERE/project-config.json"
INSIGHTS="$HERE/insights.json"
ALERTS="$HERE/alerts.json"

MODE="apply"
ONLY_PROJECT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --verify)  MODE="verify" ;;
    --only)    shift; ONLY_PROJECT="${1:-}" ;;
    -h|--help)
      sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "apply.sh: unknown argument '$1' (try --help)" >&2
      exit 2
      ;;
  esac
  shift
done

# ── Tooling ─────────────────────────────────────────────────────────────────────
for tool in jq curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "apply.sh: '$tool' is required and not on PATH." >&2
    exit 2
  fi
done
for f in "$CONFIG" "$INSIGHTS" "$ALERTS"; do
  if [ ! -f "$f" ]; then
    echo "apply.sh: missing $f" >&2
    exit 2
  fi
  if ! jq empty "$f" >/dev/null 2>&1; then
    echo "apply.sh: $f is not valid JSON." >&2
    exit 2
  fi
done

API_KEY="${POSTHOG_PERSONAL_API_KEY:-${POSTHOG_CLI_API_KEY:-}}"
APP_HOST="$(jq -r '.hosts.management' "$CONFIG")"

TMPDIR_APPLY="$(mktemp -d "${TMPDIR:-/tmp}/aeci-posthog-apply.XXXXXX")"
trap 'rm -rf "$TMPDIR_APPLY"' EXIT

# ── Failure ledger ──────────────────────────────────────────────────────────────
# One `project<TAB>kind<TAB>name<TAB>detail` line per failure. A flat file rather than
# an associative array because bash 3.2 has none, and because a file survives subshells
# (which command substitution creates) where a shell array would not.
FAILURES="$TMPDIR_APPLY/failures.tsv"
: > "$FAILURES"
RECIPES="$TMPDIR_APPLY/recipes.txt"
: > "$RECIPES"

record_failure() {
  # $1 project key · $2 kind · $3 name · $4 detail
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >> "$FAILURES"
  echo "    FAIL  [$1] $2 '$3' — $4"
}

record_recipe() {
  printf '%s\n' "$1" >> "$RECIPES"
}

# ── HTTP ────────────────────────────────────────────────────────────────────────
# Writes the body to $TMPDIR_APPLY/body and echoes the status code. Never returns
# non-zero — callers branch on the status, so a transport error must not abort the run.
api() {
  # $1 method · $2 path (project-relative or absolute) · $3 optional JSON body file
  local method="$1" path="$2" body_file="${3:-}"
  local url="${APP_HOST}${path}"
  local status
  if [ -n "$body_file" ]; then
    status="$(curl -sS -o "$TMPDIR_APPLY/body" -w '%{http_code}' \
      -X "$method" "$url" \
      -H 'content-type: application/json' \
      -H "Authorization: Bearer ${API_KEY}" \
      --max-time 45 \
      --data-binary "@${body_file}" 2>"$TMPDIR_APPLY/curlerr")" || status='000'
  else
    status="$(curl -sS -o "$TMPDIR_APPLY/body" -w '%{http_code}' \
      -X "$method" "$url" \
      -H "Authorization: Bearer ${API_KEY}" \
      --max-time 45 2>"$TMPDIR_APPLY/curlerr")" || status='000'
  fi
  printf '%s' "$status"
}

body_snippet() {
  head -c 300 "$TMPDIR_APPLY/body" 2>/dev/null | tr '\n' ' '
}

# ── Preflight: probe EVERY scope up front, report ALL misses at once ────────────
#
# The whole point is that a key missing three scopes produces ONE report naming three,
# not three consecutive failed runs. Each probe is a cheap GET against the endpoint the
# applier will later write to — which also validates the PATH, not just the scope, and
# path drift is at least as likely as scope drift.
preflight() {
  local project_id="$1" project_key="$2"
  local missing="" probe path status label

  echo "  preflight [$project_key / $project_id]"

  # `path|label|required`
  for probe in \
    "/api/projects/${project_id}/|project read|required" \
    "/api/projects/${project_id}/dashboards/?limit=1|dashboard read+write|required" \
    "/api/projects/${project_id}/insights/?limit=1|insight read+write|required" \
    "/api/projects/${project_id}/alerts/?limit=1|alert read+write|optional" \
    "/api/projects/${project_id}/annotations/?limit=1|annotation write (deploy markers)|optional" \
    "/api/projects/${project_id}/logs/alerts/?limit=1|log-alert read+write (future §5 re-home)|optional"
  do
    path="${probe%%|*}"
    label="$(printf '%s' "$probe" | cut -d'|' -f2)"
    status="$(api GET "$path")"
    case "$status" in
      200|201) echo "    ok    ${label}" ;;
      401|403) missing="${missing}      - ${label}  (HTTP ${status} on ${path})
" ;;
      404)     missing="${missing}      - ${label}  (HTTP 404 — endpoint moved or product not enabled: ${path})
" ;;
      *)       missing="${missing}      - ${label}  (HTTP ${status} on ${path})
" ;;
    esac
  done

  if [ -n "$missing" ]; then
    echo "    ---- SCOPE / ENDPOINT PROBLEMS (all of them, in one list) ----"
    printf '%s' "$missing"
    echo "    Fix the personal key at ${APP_HOST}/settings/user-api-keys, then re-run."
    echo "    Required scope union (spec §7 + §8.3): insight write, dashboard write,"
    echo "    alert write, project read — plus error tracking write + organization read"
    echo "    if the SAME key is also used for source-map upload (§AW5)."
    return 1
  fi
  return 0
}

# ── Idempotency helpers: find an existing object by exact name ──────────────────
#
# PostHog list endpoints paginate at 100 by default; ?limit=500 covers a plane this size
# with room to spare. If this ever grows past 500 objects the lookup silently starts
# missing them and the applier starts creating duplicates — assert rather than hope.
find_by_name() {
  # $1 project_id · $2 collection (dashboards|insights|alerts) · $3 name
  # echoes the id, or empty. Echoes "__OVERFLOW__" if the page filled up.
  local project_id="$1" collection="$2" name="$3" status count id
  status="$(api GET "/api/projects/${project_id}/${collection}/?limit=500")"
  if [ "$status" != "200" ]; then
    printf '__ERROR__%s' "$status"
    return 0
  fi
  count="$(jq -r '(.results // []) | length' "$TMPDIR_APPLY/body")"
  if [ "$count" = "500" ]; then
    printf '__OVERFLOW__'
    return 0
  fi
  id="$(jq -r --arg n "$name" '((.results // []) | map(select((.name // "") == $n)) | .[0].id) // ""' "$TMPDIR_APPLY/body")"
  printf '%s' "$id"
}

# ── Apply one project ───────────────────────────────────────────────────────────
apply_project() {
  local project_key="$1" project_id="$2" wants_alerts="$3"
  local created=0 skipped=0

  echo ""
  echo "── project ${project_key} (${project_id}) ─────────────────────────────────"

  if [ "$MODE" != "dry-run" ]; then
    if ! preflight "$project_id" "$project_key"; then
      record_failure "$project_key" "preflight" "scopes" "one or more scopes/endpoints unavailable — see the list above"
      echo "  preflight failed; SKIPPING this project but continuing the run."
      return 0
    fi
  fi

  # ---- dashboards -------------------------------------------------------------
  local d_count d_i d_name d_desc d_pinned d_id body
  d_count="$(jq -r '.dashboards | length' "$INSIGHTS")"
  d_i=0
  # `dashboard-name<TAB>id` map, flat file (bash 3.2 has no associative arrays).
  : > "$TMPDIR_APPLY/dash-ids.tsv"

  while [ "$d_i" -lt "$d_count" ]; do
    d_name="$(jq -r --argjson i "$d_i" '.dashboards[$i].name' "$INSIGHTS")"
    d_desc="$(jq -r --argjson i "$d_i" '.dashboards[$i].description' "$INSIGHTS")"
    d_pinned="$(jq -r --argjson i "$d_i" '.dashboards[$i].pinned' "$INSIGHTS")"
    d_i=$((d_i + 1))

    if [ "$MODE" = "dry-run" ]; then
      echo "  PLAN  dashboard  '${d_name}'"
      continue
    fi

    d_id="$(find_by_name "$project_id" "dashboards" "$d_name")"
    case "$d_id" in
      __OVERFLOW__)
        record_failure "$project_key" "dashboard" "$d_name" "the dashboards list hit the 500-row page cap — idempotency-by-name can no longer be trusted; paginate before re-running"
        continue ;;
      __ERROR__*)
        record_failure "$project_key" "dashboard" "$d_name" "list failed (HTTP ${d_id#__ERROR__})"
        continue ;;
    esac

    if [ -n "$d_id" ]; then
      echo "  skip  dashboard  '${d_name}' (id ${d_id})"
      skipped=$((skipped + 1))
    elif [ "$MODE" = "verify" ]; then
      record_failure "$project_key" "dashboard" "$d_name" "MISSING on the live project"
      continue
    else
      body="$TMPDIR_APPLY/dash.json"
      jq -n --arg n "$d_name" --arg d "$d_desc" --argjson p "$d_pinned" \
        --argjson t "$(jq -c --arg n "$d_name" '.dashboards[] | select(.name == $n) | .tags' "$INSIGHTS")" \
        '{name: $n, description: $d, pinned: $p, tags: $t}' > "$body"
      local status
      status="$(api POST "/api/projects/${project_id}/dashboards/" "$body")"
      if [ "$status" = "201" ] || [ "$status" = "200" ]; then
        d_id="$(jq -r '.id' "$TMPDIR_APPLY/body")"
        echo "  new   dashboard  '${d_name}' (id ${d_id})"
        created=$((created + 1))
      else
        record_failure "$project_key" "dashboard" "$d_name" "POST returned ${status} — $(body_snippet)"
        continue
      fi
    fi
    printf '%s\t%s\n' "$d_name" "$d_id" >> "$TMPDIR_APPLY/dash-ids.tsv"
  done

  # ---- insights ---------------------------------------------------------------
  local i_count i_i i_name i_dash i_id i_dash_id
  i_count="$(jq -r '.insights | length' "$INSIGHTS")"
  i_i=0
  while [ "$i_i" -lt "$i_count" ]; do
    i_name="$(jq -r --argjson i "$i_i" '.insights[$i].name' "$INSIGHTS")"
    i_dash="$(jq -r --argjson i "$i_i" '.insights[$i].dashboard' "$INSIGHTS")"
    i_i=$((i_i + 1))

    if [ "$MODE" = "dry-run" ]; then
      echo "  PLAN  insight    '${i_name}'  → board '${i_dash}'"
      continue
    fi

    i_id="$(find_by_name "$project_id" "insights" "$i_name")"
    case "$i_id" in
      __OVERFLOW__)
        record_failure "$project_key" "insight" "$i_name" "the insights list hit the 500-row page cap — idempotency-by-name can no longer be trusted; paginate before re-running"
        continue ;;
      __ERROR__*)
        record_failure "$project_key" "insight" "$i_name" "list failed (HTTP ${i_id#__ERROR__})"
        continue ;;
    esac

    if [ -n "$i_id" ]; then
      # Drift check: is the LIVE query still the committed one? This is the check that
      # catches a fix made in the UI instead of in this repo — the failure mode that
      # makes a committed-JSON plane quietly stop describing reality.
      local live_query committed_query get_status
      get_status="$(api GET "/api/projects/${project_id}/insights/${i_id}/")"
      if [ "$get_status" != "200" ]; then
        record_failure "$project_key" "insight" "$i_name" "read-back for the drift check returned ${get_status}"
        continue
      fi
      live_query="$(jq -r '.query.source.query // ""' "$TMPDIR_APPLY/body")"
      committed_query="$(jq -r --arg n "$i_name" '.insights[] | select(.name == $n) | .query' "$INSIGHTS")"
      if [ "$live_query" != "$committed_query" ]; then
        if [ "$MODE" = "verify" ]; then
          record_failure "$project_key" "insight" "$i_name" "DRIFT: the live query differs from the committed one (someone edited it in the UI, or this file changed). Re-run without --verify to overwrite."
          continue
        fi
        echo "  drift insight    '${i_name}' (id ${i_id}) — overwriting the live query"
      else
        echo "  skip  insight    '${i_name}' (id ${i_id})"
        skipped=$((skipped + 1))
        continue
      fi
    elif [ "$MODE" = "verify" ]; then
      record_failure "$project_key" "insight" "$i_name" "MISSING on the live project"
      continue
    fi

    i_dash_id="$(awk -F'\t' -v n="$i_dash" '$1 == n {print $2; exit}' "$TMPDIR_APPLY/dash-ids.tsv")"
    if [ -z "${i_dash_id:-}" ]; then
      record_failure "$project_key" "insight" "$i_name" "its dashboard '${i_dash}' was not created, so it has nowhere to land"
      continue
    fi

    body="$TMPDIR_APPLY/insight.json"
    jq -n \
      --arg n "$i_name" \
      --arg d "$(jq -r --arg n "$i_name" '.insights[] | select(.name == $n) | .description' "$INSIGHTS")" \
      --arg q "$(jq -r --arg n "$i_name" '.insights[] | select(.name == $n) | .query' "$INSIGHTS")" \
      --arg disp "$(jq -r --arg n "$i_name" '.insights[] | select(.name == $n) | .display' "$INSIGHTS")" \
      --argjson t "$(jq -c --arg n "$i_name" '.insights[] | select(.name == $n) | .tags' "$INSIGHTS")" \
      --argjson dash "$i_dash_id" \
      '{
         name: $n,
         description: $d,
         tags: $t,
         dashboards: [$dash],
         query: { kind: "DataVisualizationNode", display: $disp, source: { kind: "HogQLQuery", query: $q } }
       }' > "$body"

    local status
    if [ -n "$i_id" ]; then
      status="$(api PATCH "/api/projects/${project_id}/insights/${i_id}/" "$body")"
    else
      status="$(api POST "/api/projects/${project_id}/insights/" "$body")"
    fi
    if [ "$status" = "201" ] || [ "$status" = "200" ]; then
      i_id="$(jq -r '.id' "$TMPDIR_APPLY/body")"
      echo "  ok    insight    '${i_name}' (id ${i_id})"
      created=$((created + 1))
    else
      record_failure "$project_key" "insight" "$i_name" "write returned ${status} — $(body_snippet)"
    fi
  done

  # ---- alerts (prod only) -----------------------------------------------------
  if [ "$wants_alerts" != "true" ]; then
    echo "  ----  alerts skipped: '${project_key}' is not the production project (by design)."
  else
    local a_count a_i a_name a_insight a_id a_insight_id subscribers
    subscribers="$(jq -c '[.alertSubscribers[].posthogUserId]' "$CONFIG")"
    a_count="$(jq -r '.alerts | length' "$ALERTS")"
    a_i=0
    while [ "$a_i" -lt "$a_count" ]; do
      a_name="$(jq -r --argjson i "$a_i" '.alerts[$i].name' "$ALERTS")"
      a_insight="$(jq -r --argjson i "$a_i" '.alerts[$i].insight' "$ALERTS")"
      a_i=$((a_i + 1))

      if [ "$MODE" = "dry-run" ]; then
        echo "  PLAN  alert      '${a_name}'  ← insight '${a_insight}'"
        continue
      fi

      a_id="$(find_by_name "$project_id" "alerts" "$a_name")"
      case "$a_id" in
        __OVERFLOW__|__ERROR__*)
          record_failure "$project_key" "alert" "$a_name" "alert list unavailable (${a_id})"
          continue ;;
      esac

      if [ -n "$a_id" ]; then
        echo "  skip  alert      '${a_name}' (id ${a_id})"
        skipped=$((skipped + 1))
        continue
      fi
      if [ "$MODE" = "verify" ]; then
        record_failure "$project_key" "alert" "$a_name" "MISSING on the live project"
        continue
      fi

      a_insight_id="$(find_by_name "$project_id" "insights" "$a_insight")"
      case "$a_insight_id" in
        ""|__OVERFLOW__|__ERROR__*)
          record_failure "$project_key" "alert" "$a_name" "its source insight '${a_insight}' could not be resolved"
          continue ;;
      esac

      body="$TMPDIR_APPLY/alert.json"
      jq -n \
        --arg n "$a_name" \
        --argjson insight "$a_insight_id" \
        --argjson users "$subscribers" \
        --argjson spec "$(jq -c --arg n "$a_name" '.alerts[] | select(.name == $n)' "$ALERTS")" \
        '{
           name: $n,
           insight: $insight,
           subscribed_users: $users,
           enabled: $spec.enabled,
           calculation_interval: $spec.calculationInterval,
           condition: $spec.condition,
           threshold: $spec.threshold,
           config: $spec.config
         }' > "$body"

      local status
      status="$(api POST "/api/projects/${project_id}/alerts/" "$body")"
      if [ "$status" = "201" ] || [ "$status" = "200" ]; then
        echo "  new   alert      '${a_name}' (id $(jq -r '.id' "$TMPDIR_APPLY/body"))"
        created=$((created + 1))
      else
        record_failure "$project_key" "alert" "$a_name" "POST returned ${status} — $(body_snippet)"
      fi
    done
  fi

  echo "  summary [${project_key}]: ${created} written, ${skipped} already present"
}

# ── Recreate recipes for anything the API cannot express ────────────────────────
#
# The contract is: nothing is silently missing. If the applier cannot make an API call,
# it prints the manual steps instead of pretending the plane is complete.
emit_recipes() {
  record_recipe ""
  record_recipe "RECREATE RECIPES — steps this applier deliberately does NOT perform"
  record_recipe "========================================================================"
  record_recipe ""
  record_recipe "1. ERROR TRACKING (exception autocapture) is a PRODUCT TOGGLE, not an API"
  record_recipe "   object. Enabling it needs the 'product_enablement:write' scope, which"
  record_recipe "   personal API keys do not carry. Until it is on, browser and Worker"
  record_recipe "   exception capture has nowhere to land."
  record_recipe "     -> ${APP_HOST}/project/<id>/settings/error-tracking  (both projects)"
  record_recipe ""
  record_recipe "2. INTERNAL-USER EXCLUSION is a project setting, same story."
  record_recipe "     -> ${APP_HOST}/project/354071/settings/project  ->  'Internal users'"
  record_recipe "        Add chrisw@thewbsproject.com. Until then production product"
  record_recipe "        analytics carry operator traffic while page_views excludes it via"
  record_recipe "        verified admin session, and the two surfaces disagree for a reason"
  record_recipe "        that looks exactly like a bug."
  record_recipe ""
  record_recipe "3. NON-EMAIL ALERT DELIVERY (Slack / Discord / HTTPS webhook) is a"
  record_recipe "   cdp-functions object, not a field on the alert. Deliberately not wired:"
  record_recipe "   AECi has no Slack (CLAUDE.md), and email to \$ADMIN_ALERT_EMAIL is the"
  record_recipe "   established operator channel."
  record_recipe "     -> If that changes: integrations-channels-retrieve, then create a"
  record_recipe "        cdp-function filtered on the alert id."
  record_recipe ""
  record_recipe "4. LOG ALERTS (PostHog's other alert type) support 5/10/15/30/60-minute"
  record_recipe "   windows — TIGHTER than the hourly insight-alert floor this plane runs"
  record_recipe "   at. Not used yet, because our failure signals are metrics and the"
  record_recipe "   equivalent log lines are not yet emitted for every path. If the hourly"
  record_recipe "   cadence proves too slow for the Worker error-rate alert, this is the"
  record_recipe "   upgrade path that does NOT need the Boost add-on."
  record_recipe "     -> POST ${APP_HOST}/api/projects/354071/logs/alerts/  (max 20/project)"
  record_recipe "        {\"name\", \"filters\": {\"severityLevels\": [\"error\"],"
  record_recipe "         \"serviceNames\": [\"aeci-api\"]}, \"threshold_count\", \"window_minutes\"}"
  record_recipe ""
  record_recipe "5. DASHBOARD TILE LAYOUT is not managed here. Insights land on their board"
  record_recipe "   in creation order; drag them where you want them. Layout is presentation,"
  record_recipe "   it carries no contract, and pinning it in JSON would make every"
  record_recipe "   cosmetic tweak a repo change."
}

# ── Run ─────────────────────────────────────────────────────────────────────────
echo "AECi PostHog observability applier — mode: ${MODE}"
echo "  config:   $CONFIG"
echo "  host:     $APP_HOST"
if [ "$MODE" = "dry-run" ]; then
  echo "  key:      not required in --dry-run (no writes, no scope probes)"
elif [ -z "$API_KEY" ]; then
  echo ""
  echo "apply.sh: no personal API key found." >&2
  echo "  Set POSTHOG_PERSONAL_API_KEY or POSTHOG_CLI_API_KEY to a phx_ key with the" >&2
  echo "  §7 + §8.3 scope union (insight write, dashboard write, alert write, project" >&2
  echo "  read; plus error tracking write + organization read if the same key also does" >&2
  echo "  source-map upload). Create one at ${APP_HOST}/settings/user-api-keys." >&2
  echo "  This is an OPERATOR tool — it cannot read the GitHub Actions secret." >&2
  exit 2
else
  echo "  key:      ${API_KEY%%_*}_… (${#API_KEY} chars)"
fi

P_COUNT="$(jq -r '.projects | length' "$CONFIG")"
P_I=0
while [ "$P_I" -lt "$P_COUNT" ]; do
  PKEY="$(jq -r --argjson i "$P_I" '.projects[$i].key' "$CONFIG")"
  PID="$(jq -r --argjson i "$P_I" '.projects[$i].id' "$CONFIG")"
  PALERTS="$(jq -r --argjson i "$P_I" '.projects[$i].receivesAlerts' "$CONFIG")"
  P_I=$((P_I + 1))
  if [ -n "$ONLY_PROJECT" ] && [ "$ONLY_PROJECT" != "$PKEY" ]; then
    continue
  fi
  apply_project "$PKEY" "$PID" "$PALERTS"
done

emit_recipes

echo ""
cat "$RECIPES"

# ── Per-project failure summary ─────────────────────────────────────────────────
echo ""
echo "========================================================================"
FAIL_COUNT="$(wc -l < "$FAILURES" | tr -d ' ')"
if [ "$FAIL_COUNT" = "0" ]; then
  echo "RESULT: clean — no failures."
  if [ "$MODE" = "apply" ]; then
    echo ""
    echo "Next: paste the dashboard URLs into docs/OBSERVABILITY.md (spec §7)."
    P_I=0
    while [ "$P_I" -lt "$P_COUNT" ]; do
      PID="$(jq -r --argjson i "$P_I" '.projects[$i].id' "$CONFIG")"
      echo "  ${APP_HOST}/project/${PID}/dashboard"
      P_I=$((P_I + 1))
    done
  fi
  exit 0
fi

echo "RESULT: ${FAIL_COUNT} failure(s). Per-project summary:"
# A `while read` over a sorted key list rather than an associative array — bash 3.2 again.
cut -f1 "$FAILURES" | sort -u > "$TMPDIR_APPLY/failed-projects.txt"
while IFS= read -r pkey; do
  [ -n "$pkey" ] || continue
  echo ""
  echo "  [${pkey}]"
  awk -F'\t' -v p="$pkey" '$1 == p { printf "    %-10s %s\n                 %s\n", $2, $3, $4 }' "$FAILURES"
done < "$TMPDIR_APPLY/failed-projects.txt"
echo ""
echo "The run COMPLETED — everything above this line that did not fail was applied."
echo "Fix the JSON (never the UI) and re-run; the applier is idempotent by name."
exit 1
