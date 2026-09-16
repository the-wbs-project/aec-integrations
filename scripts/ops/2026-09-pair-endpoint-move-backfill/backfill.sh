#!/usr/bin/env bash
set -euo pipefail

# AECI-953 — seed `integration_endpoint_moves` for the 52 endpoint moves that happened
# BEFORE the promote learned to record them.
#
# AECI-726 moved 37 live Procore edges onto the new platform record on 2026-09-14 and
# AECI-950 moved 15 more on 2026-09-15. Each kept its id and updated its public row in
# place, but the pair page is keyed by two product SLUGS — so 52 indexed URLs now serve
# 200 + `noindex` with no redirect. The promote records this from now on; these 52 have
# to be written by hand, once.
#
# ─── THE COHORT IS SLUGS, NOT IDS, AND THAT IS DELIBERATE ────────────────────
#
# The Linear comments name upstream `rec…` review-app ids. Those are NOT the app-DB ids
# — the promote mints its own — so a cohort keyed on them resolves to nothing here. The
# committed `moves.json` names pair URLs instead: `(from, to, other)` slug triples. The
# projection below resolves each triple against the target DB and writes one row per
# edge that is CURRENTLY on the destination pair.
#
# That means the script re-derives the edge ids from live data every run, so it cannot
# write a row for an edge that has since moved again or been retracted.
#
# ─── ADR 0022: THE AUDIT ROW ─────────────────────────────────────────────────
#
# A move row is domain state, so §26.1 wants its `audit_log` row in the same atomic
# unit. A bash CLI has no `db.batch()`, so the write is one generated file applied with
# `wrangler d1 execute --file`, which routes through D1's import pipeline and DOES
# promise all-or-nothing. Same reasoning, verbatim, as the AECI-706 powered_by backfill
# next door.
#
# Audit rows are per-row `integration.endpoint_moved` with actor_type 'system' —
# exactly what the ingest now writes for the same mutation. The one-summary-row form is
# ADR 0022's SCHEDULED-DELETE exception and does not apply.
#
# Idempotent: every INSERT is `INSERT OR IGNORE` against the composite PK, and the
# audit INSERT is guarded by a NOT EXISTS on the move row, so a re-run writes nothing
# at all. The rollback deletes only rows this script could have written.
#
# ─── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
#
#   - It does not purge the edge cache. The 52 old URLs are cached as 200s and will
#     keep serving until purged or expired; see the follow-ups printed at the end.
#   - It does not re-promote anything, and it never touches `integrations`.
#
# USAGE (needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID):
#   scripts/ops/2026-09-pair-endpoint-move-backfill/backfill.sh --env production
#   scripts/ops/2026-09-pair-endpoint-move-backfill/backfill.sh --env production --apply --allow-production
#   scripts/ops/2026-09-pair-endpoint-move-backfill/backfill.sh --env production --rollback --apply --allow-production

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WRANGLER="$ROOT/apps/api/node_modules/.bin/wrangler"
CONFIG="$ROOT/apps/api/wrangler.jsonc"
MOVES="$HERE/moves.json"

usage() {
  echo "usage: backfill.sh --env <preview|staging|demo|production>" >&2
  echo "                   [--apply] [--allow-production] [--rollback]" >&2
  exit 2
}

ENV_NAME=""
APPLY=0
ALLOW_PROD=0
ROLLBACK=0
while [ "${1:-}" != "" ]; do
  case "$1" in
    --env) ENV_NAME="${2:-}"; shift 2 ;;
    --env=*) ENV_NAME="${1#*=}"; shift ;;
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
DB="aeci-app-$ENV_NAME"

if [ "$ENV_NAME" = "production" ] && [ "$APPLY" = "1" ] && [ "$ALLOW_PROD" != "1" ]; then
  echo "REFUSING: production writes need --allow-production." >&2
  exit 1
fi

[ -x "$WRANGLER" ] || { echo "missing wrangler at $WRANGLER (run pnpm install)" >&2; exit 1; }
[ -f "$MOVES" ]    || { echo "missing cohort at $MOVES" >&2; exit 1; }
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || echo "warn: CLOUDFLARE_API_TOKEN is unset; wrangler will fall back to an interactive login." >&2

d1_json() { "$WRANGLER" d1 execute "$DB" --env "$ENV_NAME" --remote --json --config "$CONFIG" --command "$1"; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$HERE/backups/$STAMP-$ENV_NAME"

echo "== target: $DB"
echo "   cohort: $MOVES"
echo "   action: $([ "$ROLLBACK" = 1 ] && echo 'ROLLBACK (delete the seeded rows)' || echo 'BACKFILL')"
echo "   mode:   $([ "$APPLY" = 1 ] && echo APPLY || echo DRY-RUN)"

# ─── 1. Resolve the cohort against the live DB ────────────────────────────────
#
# Each triple becomes ONE standalone SELECT that finds the edge CURRENTLY on the
# destination pair, in either anchor table and either orientation. A triple that
# resolves to nothing prints as `unresolved` and writes nothing — it is not an error,
# it means that edge moved again or was retracted.
#
# AECI-991 SIMPLIFIED THIS. The table is keyed on the two old pair SLUGS now, not on
# two product ids, so the query no longer has to resolve the OLD product at all — the
# cohort file already names it. It also no longer has to exist: an id-keyed row could
# only be written while the retired endpoint's row was still there, which is exactly
# backwards for a redirect that points away from it.
#
# 52 SEPARATE STATEMENTS, not one 52-arm UNION ALL: SQLite caps the number of terms in
# a compound SELECT and a 52-arm union fails outright with
# `too many terms in compound SELECT: SQLITE_ERROR`. `--file` returns one result set
# per statement, which the reader below flattens.
echo
echo "-- resolving --"
mkdir -p "$OUT"
python3 - "$MOVES" "$OUT" <<'PYEOF' > "$OUT/query.sql"
import json, sys
moves = json.load(open(sys.argv[1]))["moves"]
def lit(s):
    return "'" + str(s).replace("'", "''") + "'"
arms = []
for m in moves:
    arms.append(f"""
SELECT {lit(m['from'])} AS from_slug, {lit(m['to'])} AS to_slug, {lit(m['other'])} AS other_slug,
       e.id AS edge_id
FROM products newp
JOIN products otherp ON otherp.slug = {lit(m['other'])}
JOIN (
  SELECT id, source_product_id AS x, target_product_id AS y FROM integrations
  UNION ALL
  SELECT id, product_a_id AS x, product_b_id AS y FROM connector_evidenced_pairs
) e ON (e.x = newp.id AND e.y = otherp.id) OR (e.x = otherp.id AND e.y = newp.id)
WHERE newp.slug = {lit(m['to'])};""".strip())
print("\n\n".join(arms))
PYEOF
echo "   query:  $OUT/query.sql"

"$WRANGLER" d1 execute "$DB" --env "$ENV_NAME" --remote --json --config "$CONFIG" \
  --file "$OUT/query.sql" > "$OUT/resolved.json"

python3 - "$MOVES" "$OUT" <<'PYEOF'
import json, sys
moves = json.load(open(sys.argv[1]))["moves"]
out = sys.argv[2]
raw = json.load(open(f"{out}/resolved.json"))
# One result set per statement, and `--remote` wraps the array in `{"result": [...]}`
# while `--local` returns it bare. Flatten both shapes.
sets = raw if isinstance(raw, list) else raw["result"]
rows = [r for s in sets for r in (s.get("results") or [])]
json.dump(rows, open(f"{out}/rows.json", "w"), indent=2)

by_key = {}
for r in rows:
    by_key.setdefault((r["from_slug"], r["other_slug"]), []).append(r)

resolved = unresolved = 0
print(f"  {'old pair URL':64} edges")
for m in moves:
    hits = by_key.get((m["from"], m["other"]), [])
    url = f"/products/{m['from']}/integrations/{m['other']}"
    if hits:
        resolved += 1
        print(f"  {url:64} {len(hits)}  -> /products/{m['to']}/integrations/{m['other']}")
    else:
        unresolved += 1
        print(f"  {url:64} UNRESOLVED (moved again, or retracted)")
print(f"\n  {resolved} of {len(moves)} triples resolved; {len(rows)} move row(s) to write.")
PYEOF

ROW_N="$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))))" "$OUT/rows.json")"
if [ "$ROW_N" = "0" ]; then
  echo
  echo "Nothing to do — no triple resolved to a live edge on its destination pair."
  exit 0
fi

# ─── 2. Generate the forward + rollback files ─────────────────────────────────
#
# Written on dry-run too, so the exact bytes that would be applied are reviewable.
echo
echo "-- artifacts --"
python3 - "$OUT" "$STAMP" <<'PYEOF'
import json, sys, uuid, datetime
out, stamp = sys.argv[1], sys.argv[2]
rows = json.load(open(f"{out}/rows.json"))
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

def lit(s):
    """Quoted SQL literal. `wrangler d1 execute` has no bind support, so every value is
    escaped and interpolated the same way apps/api/src/lib/retract-product.ts does."""
    return "'" + str(s).replace("'", "''") + "'"

forward, back = [], []
seen = set()
for r in rows:
    fa, fb = sorted([r["from_slug"], r["other_slug"]])
    key = (r["edge_id"], fa, fb)
    if key in seen:
        continue
    seen.add(key)
    edge = r["edge_id"]
    meta = json.dumps(
        {"source": "ops-backfill-aeci-953", "runId": stamp,
         "fromPair": [r["from_slug"], r["other_slug"]], "toPair": [r["to_slug"], r["other_slug"]]},
        separators=(",", ":"),
    )
    forward.append(
        "INSERT OR IGNORE INTO integration_endpoint_moves "
        "(integration_id, from_product_a_slug, from_product_b_slug, moved_at) VALUES ("
        f"{lit(edge)}, {lit(fa)}, {lit(fb)}, {lit(now)});"
    )
    # Guarded so a re-run (where the INSERT was a no-op) does not add a second audit
    # row for a move that was already recorded.
    forward.append(
        "INSERT INTO audit_log (id, actor_id, actor_type, action, entity_type, entity_id, "
        "before_state, after_state, metadata, created_at) "
        f"SELECT {lit(uuid.uuid4())}, NULL, 'system', 'integration.endpoint_moved', 'integration', "
        f"{lit(edge)}, "
        f"{lit(json.dumps({'productSlugs': [fa, fb]}, separators=(',', ':')))}, NULL, "
        f"{lit(meta)}, {lit(now)} "
        "WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE entity_id = "
        f"{lit(edge)} AND action = 'integration.endpoint_moved');"
    )
    back.append(
        "DELETE FROM integration_endpoint_moves WHERE integration_id = "
        f"{lit(edge)} AND from_product_a_slug = {lit(fa)} AND from_product_b_slug = {lit(fb)};"
    )
    back.append(
        "DELETE FROM audit_log WHERE action = 'integration.endpoint_moved' "
        f"AND json_extract(metadata, '$.runId') = {lit(stamp)} AND entity_id = {lit(edge)};"
    )

header = (f"-- AECI-953 endpoint-move backfill, run {stamp}\n"
          f"-- {len(seen)} move row(s); each INSERT is paired with its audit_log row and\n"
          f"-- applied via `wrangler d1 execute --file` (atomic D1 import).\n")
open(f"{out}/backfill.sql", "w").write(header + "\n".join(forward) + "\n")
open(f"{out}/rollback.sql", "w").write(header + "\n".join(back) + "\n")
print(f"   forward:  {out}/backfill.sql ({len(forward)} statements)")
print(f"   rollback: {out}/rollback.sql ({len(back)} statements)")
PYEOF

SQL_FILE="$OUT/backfill.sql"
[ "$ROLLBACK" = "1" ] && SQL_FILE="$OUT/rollback.sql"

# ─── 3. The write ─────────────────────────────────────────────────────────────
if [ "$APPLY" != "1" ]; then
  echo
  echo "DRY-RUN — nothing written. Review $SQL_FILE, then re-run with"
  echo "  --apply$([ "$ENV_NAME" = production ] && echo ' --allow-production')."
  exit 0
fi

echo
echo "-- applying $SQL_FILE --"
"$WRANGLER" d1 execute "$DB" --env "$ENV_NAME" --remote --config "$CONFIG" --file "$SQL_FILE"

# ─── 4. Verify ────────────────────────────────────────────────────────────────
echo
echo "-- after --"
d1_json "SELECT COUNT(*) AS move_rows FROM integration_endpoint_moves;"
d1_json "SELECT COUNT(*) AS audit_rows FROM audit_log
    WHERE action = 'integration.endpoint_moved'
      AND json_extract(metadata, '\$.runId') = '$STAMP';"

echo
cat <<EOF
DONE. Follow-ups (this script does NOT run them):
  1. verify   curl -sI https://www.aecintegrations.com/products/procore-project-management/integrations/okta
              -> expect 301 with Location .../products/procore/integrations/okta
              (production runs UNCACHED today, so no purge is needed there; on a
               cached tier the old 200 is still in the edge cache, see 2.)
  2. cache    POST /admin/purge with one tag per old pair, alphabetical:
                pair:<min>__<max>   for each (from_slug, other_slug) pair above
              The generated rows.json has every pair; nothing else reaches those URLs.
  3. record   Add a dated line to README.md's Run Log.
EOF
