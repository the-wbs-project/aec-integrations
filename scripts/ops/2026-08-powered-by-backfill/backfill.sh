#!/usr/bin/env bash
set -euo pipefail

# Backfill `integrations.powered_by_product_id` on prod rows the promote ingest wrote
# with a NULL FK because the connector product was not promoted yet (AECI-706).
#
# THE COHORT IS NEVER DEFINED HERE. It is read out of a fresh `audit.mjs --json`
# report — specifically its `backfillable` bucket, which is the set where the FK is the
# ONLY difference from upstream. audit.mjs is the single source of truth for what is
# safe to write; this script parses it so the projection, the write and the rollback
# cannot drift from it (same rule as the operator-page-view backfill's PAIRS block).
#
# WHY THE OTHER BUCKETS ARE REFUSED, NOT WRITTEN:
#   divergent  — the row is also stale on name/mechanism_kind/direction/ENDPOINTS.
#                AECI-671 swapped source/target on Kroo's rows; writing a correct FK
#                onto a backwards edge is worse than the NULL it replaces. Re-promote.
#   mismatch   — prod points at a different connector than upstream. Someone decided
#                that, or something is wrong. Never auto-corrected.
#
# ─── ADR 0022: WHY THE WRITE IS ONE GENERATED FILE ───────────────────────────
#
# `integrations` is CATALOG — domain state — so §26.1 requires the `audit_log` row in
# the SAME atomic unit as the mutation. A Node/bash CLI has no `db.batch()`, so the
# question is what a multi-statement wrangler call actually guarantees.
#
# Measured on a real remote D1 (staging, 2026-08-31), UPDATE + a deliberately failing
# second statement, for BOTH a prepare-time error (unknown column) and a RUNTIME error
# (CHECK violation): `--command` and `--file` BOTH rolled the UPDATE back. So
# `--command` is atomic today — the D1 /query endpoint wraps a multi-statement body.
#
# We still generate a file and apply it with `--file`, for two reasons:
#
#   1. Only `--file` states the guarantee as a CONTRACT. It routes through D1's import
#      pipeline, which announces "if the execution fails to complete, your DB will
#      return to its original state and you can safely retry." `--command`'s rollback
#      is observed behaviour of an endpoint that does not promise it; an ADR-0022
#      invariant should not rest on that.
#   2. The cohort is unbounded. A few hundred UPDATE+INSERT pairs is a multi-megabyte
#      argv; a file has no such limit, and it is reviewable and archivable — the exact
#      bytes that were applied stay in backups/ next to the rollback that undoes them.
#
# Audit rows are per-row `integration.updated` with actor_type 'system', matching what
# the promote ingest itself writes for the same mutation. The one-summary-row form is
# ADR 0022's SCHEDULED-DELETE exception and does not apply here.
#
# `updated_at` is deliberately NOT touched: it tracks last-promote recency, and the
# audit_log row is the record of this change. Bumping it would fake a promote.
#
# Idempotent: every UPDATE carries `AND powered_by_product_id IS NULL`, so a re-run is
# a no-op and the rollback is a genuine inverse (every row it set was NULL before).
#
# USAGE (needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID):
#   node scripts/ops/2026-08-powered-by-backfill/audit.mjs --json --out /tmp/r.json
#   scripts/ops/2026-08-powered-by-backfill/backfill.sh --env production --report /tmp/r.json
#   scripts/ops/2026-08-powered-by-backfill/backfill.sh --env production --report /tmp/r.json --apply --allow-production
#   scripts/ops/2026-08-powered-by-backfill/backfill.sh --env production --report /tmp/r.json --rollback --apply --allow-production

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WRANGLER="$ROOT/apps/api/node_modules/.bin/wrangler"
CONFIG="$ROOT/apps/api/wrangler.jsonc"

# A report older than this cannot be trusted to describe the database we are about to
# write to — a promote in between could have changed any row in the cohort.
MAX_REPORT_AGE_MIN=60

usage() {
  echo "usage: backfill.sh --env <preview|staging|demo|production> --report <path>" >&2
  echo "                   [--apply] [--allow-production] [--rollback]" >&2
  exit 2
}

ENV_NAME=""
REPORT=""
APPLY=0
ALLOW_PROD=0
ROLLBACK=0
while [ "${1:-}" != "" ]; do
  case "$1" in
    --env) ENV_NAME="${2:-}"; shift 2 ;;
    --env=*) ENV_NAME="${1#*=}"; shift ;;
    --report) REPORT="${2:-}"; shift 2 ;;
    --report=*) REPORT="${1#*=}"; shift ;;
    --apply) APPLY=1; shift ;;
    --allow-production) ALLOW_PROD=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

case "$ENV_NAME" in
  preview|staging|demo|production) ;;
  *) usage ;;
esac
[ -n "$REPORT" ] || usage
DB="aeci-app-$ENV_NAME"

if [ "$ENV_NAME" = "production" ] && [ "$APPLY" = "1" ] && [ "$ALLOW_PROD" != "1" ]; then
  echo "REFUSING: production writes need --allow-production." >&2
  exit 1
fi

[ -x "$WRANGLER" ] || { echo "missing wrangler at $WRANGLER (run pnpm install)" >&2; exit 1; }
[ -f "$REPORT" ]   || { echo "missing report at $REPORT (run audit.mjs --json --out ...)" >&2; exit 1; }
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || echo "warn: CLOUDFLARE_API_TOKEN is unset; wrangler will fall back to an interactive login." >&2

d1() { "$WRANGLER" d1 execute "$DB" --env "$ENV_NAME" --remote --json --config "$CONFIG" --command "$1"; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$HERE/backups/$STAMP-$ENV_NAME"

# ─── 1. Validate the report against the target ────────────────────────────────
#
# Every refusal below is a way the cohort could describe a DIFFERENT database than the
# one we are about to write to.
python3 - "$REPORT" "$ENV_NAME" "$MAX_REPORT_AGE_MIN" <<'PYEOF'
import datetime, json, sys
report_path, env_name, max_age_min = sys.argv[1], sys.argv[2], int(sys.argv[3])
r = json.load(open(report_path))

if r.get("env") != env_name:
    sys.exit(f"REFUSING: report was measured against --env {r.get('env')!r}, not {env_name!r}.")

measured = datetime.datetime.fromisoformat(r["measuredAt"].replace("Z", "+00:00"))
age_min = (datetime.datetime.now(datetime.timezone.utc) - measured).total_seconds() / 60
if age_min > max_age_min:
    sys.exit(
        f"REFUSING: report is {age_min:.0f} min old (limit {max_age_min}). A promote in\n"
        f"  between could have changed any row in the cohort. Re-run audit.mjs."
    )

for bucket in ("divergent", "mismatch"):
    rows = r["buckets"].get(bucket, [])
    if rows:
        names = "\n".join(f"    {e['integrationId']}  {e.get('name')}" for e in rows[:10])
        sys.exit(
            f"REFUSING: {len(rows)} row(s) in `{bucket}`. These are NOT FK-only drift and\n"
            f"  must be healed by a re-promote, not by this script:\n{names}\n"
            f"  Re-run once they are clean."
        )
print(f"report OK — measured {age_min:.0f} min ago against {r['database']}")
PYEOF

COHORT_N="$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))['buckets']['backfillable']))" "$REPORT")"

echo "== target: $DB"
echo "   report: $REPORT"
echo "   cohort: $COHORT_N backfillable row(s)"
echo "   action: $([ "$ROLLBACK" = 1 ] && echo 'ROLLBACK (powered_by -> NULL)' || echo 'BACKFILL (NULL -> connector)')"
echo "   mode:   $([ "$APPLY" = 1 ] && echo APPLY || echo DRY-RUN)"

if [ "$COHORT_N" = "0" ]; then
  echo
  echo "Nothing to do — the backfillable bucket is empty."
  echo "  Every prod edge whose connector IS promoted already carries its FK. The"
  echo "  remaining upstream powered edges are blocked on promotion coverage, not on"
  echo "  this script — see the report's connectorUnpromoted / edgeUnpromoted buckets"
  echo "  and README.md §'What the sweep found'."
  exit 0
fi

# ─── 2. Projection ────────────────────────────────────────────────────────────
echo
echo "-- cohort --"
python3 - "$REPORT" <<'PYEOF'
import json, sys
rows = json.load(open(sys.argv[1]))["buckets"]["backfillable"]
print(f"  {'integration id':38} {'connector':28} pair")
for e in rows:
    pair = f"{e.get('sourceSlug')} -> {e.get('targetSlug')}"
    print(f"  {e['integrationId']:38} {str(e.get('connectorSlug')):28} {pair}")
PYEOF

# ─── 3. Backup + generated SQL, written BEFORE any decision to apply ──────────
#
# Produced on dry-run too, so the exact file that would be applied can be reviewed.
mkdir -p "$OUT"
echo
echo "-- artifacts --"
"$WRANGLER" d1 export "$DB" --env "$ENV_NAME" --remote --config "$CONFIG" \
  --table integrations --no-schema --output "$OUT/integrations.sql" >/dev/null
echo "   backup:   $OUT/integrations.sql"

python3 - "$REPORT" "$OUT" "$STAMP" "$ROLLBACK" <<'PYEOF'
import json, sys, uuid, datetime
report_path, out_dir, stamp, rollback = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
rows = json.load(open(report_path))["buckets"]["backfillable"]
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

def lit(s):
    """Quoted SQL literal. wrangler --command/--file has no bind support, so every
    value is escaped and interpolated the same way apps/api/src/lib/retract-product.ts
    does it."""
    return "'" + str(s).replace("'", "''") + "'"

forward, back = [], []
for e in rows:
    edge, conn = e["integrationId"], e["connector"]["productId"]
    meta = json.dumps({"source": "ops-backfill-aeci-706", "runId": stamp,
                       "connectorSlug": e.get("connectorSlug")}, separators=(",", ":"))
    # UPDATE then its audit row, adjacent, in one file → one atomic D1 import.
    forward.append(
        f"UPDATE integrations SET powered_by_product_id = {lit(conn)} "
        f"WHERE id = {lit(edge)} AND powered_by_product_id IS NULL;"
    )
    forward.append(
        "INSERT INTO audit_log (id, actor_id, actor_type, action, entity_type, entity_id, "
        "before_state, after_state, metadata, created_at) VALUES ("
        f"{lit(uuid.uuid4())}, NULL, 'system', 'integration.updated', 'integration', {lit(edge)}, "
        f"""{lit('{"powered_by_product_id":null}')}, """
        f"""{lit(json.dumps({"powered_by_product_id": conn}, separators=(",", ":")))}, """
        f"{lit(meta)}, {lit(now)});"
    )
    # The inverse only ever touches rows this script could have set.
    back.append(
        f"UPDATE integrations SET powered_by_product_id = NULL "
        f"WHERE id = {lit(edge)} AND powered_by_product_id = {lit(conn)};"
    )
    back.append(
        "INSERT INTO audit_log (id, actor_id, actor_type, action, entity_type, entity_id, "
        "before_state, after_state, metadata, created_at) VALUES ("
        f"{lit(uuid.uuid4())}, NULL, 'system', 'integration.updated', 'integration', {lit(edge)}, "
        f"""{lit(json.dumps({"powered_by_product_id": conn}, separators=(",", ":")))}, """
        f"""{lit('{"powered_by_product_id":null}')}, """
        f"{lit(json.dumps({'source': 'ops-backfill-aeci-706', 'runId': stamp, 'rollback': True}, separators=(',', ':')))}, "
        f"{lit(now)});"
    )

header = (f"-- AECI-706 powered_by backfill, run {stamp}\n"
          f"-- {len(rows)} integration(s); each UPDATE is paired with its audit_log row\n"
          f"-- and applied via `wrangler d1 execute --file` (atomic D1 import).\n")
open(f"{out_dir}/backfill.sql", "w").write(header + "\n".join(forward) + "\n")
open(f"{out_dir}/rollback.sql", "w").write(header + "\n".join(back) + "\n")
print(f"   forward:  {out_dir}/backfill.sql ({len(forward)} statements)")
print(f"   rollback: {out_dir}/rollback.sql ({len(back)} statements)")
PYEOF

SQL_FILE="$OUT/backfill.sql"
[ "$ROLLBACK" = "1" ] && SQL_FILE="$OUT/rollback.sql"

# ─── 4. The write ─────────────────────────────────────────────────────────────
if [ "$APPLY" != "1" ]; then
  echo
  echo "DRY-RUN — nothing written. Review $SQL_FILE, then re-run with"
  echo "  --apply$([ "$ENV_NAME" = production ] && echo ' --allow-production')."
  exit 0
fi

echo
echo "-- applying $SQL_FILE --"
"$WRANGLER" d1 execute "$DB" --env "$ENV_NAME" --remote --config "$CONFIG" --file "$SQL_FILE"

# ─── 5. Verify ────────────────────────────────────────────────────────────────
echo
echo "-- after --"
d1 "SELECT COUNT(*) AS total,
      SUM(CASE WHEN powered_by_product_id IS NOT NULL THEN 1 ELSE 0 END) AS powered
    FROM integrations;"
d1 "SELECT COUNT(*) AS audit_rows FROM audit_log
    WHERE action = 'integration.updated'
      AND json_extract(metadata, '\$.runId') = '$STAMP';"

echo
cat <<EOF
DONE. Follow-ups (this script does NOT run them):
  1. re-sweep  node scripts/ops/2026-08-powered-by-backfill/audit.mjs --env $ENV_NAME
               → backfillable must now be 0.
  2. algolia   pnpm --filter @aeci/api ops:purge-algolia-orphans -- --env $ENV_NAME --apply
               (only if a reindex is wanted; the FK is not an indexed attribute today)
  3. cache     POST /admin/purge with, for every row in the cohort:
                 product:<connectorSlug>  product:<sourceSlug>  product:<targetSlug>
                 pair:<sourceSlug>__<targetSlug>  integration:<integrationId>
               The connector's own page is the one no other rule reaches — it is
               neither endpoint nor the promoted product (docs/CACHE_STRATEGY.md).
  4. record    Add a dated line to README.md's Run Log and to
               docs/POST_LAUNCH_HEALTH_REPORT.md.
EOF
