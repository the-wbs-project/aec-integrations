#!/usr/bin/env bash
set -euo pipefail

# AECI-991 — rebuild `integration_endpoint_moves` from the `integration.endpoint_moved`
# audit rows.
#
# The move rows carried two foreign keys to `products` with ON DELETE CASCADE until
# migration 0041. A redirect keyed on the pair an edge moved AWAY from cannot survive
# that: retract the old endpoint and the redirect goes with it. AECI-809 did exactly
# that — 44 edges re-pointed off Autodesk Construction Cloud onto Autodesk Forma, then
# the ACC record retracted — and all 44 move rows vanished. 44 indexed pair URLs went
# from "about to 301" to 404 with nothing logged.
#
# `audit_log` kept the full record. This script reads it back.
#
# ─── WHY THIS IS NOT THE OTHER BACKFILL ──────────────────────────────────────
#
# `scripts/ops/2026-09-pair-endpoint-move-backfill/` seeds the 52 Procore moves that
# happened BEFORE the promote learned to record them — they have no audit rows at all,
# so its cohort is a committed list of pair-URL slug triples resolved against live
# data. This one is the opposite case: the audit rows exist and the derived rows were
# deleted. Run both; they do not overlap, and each is idempotent.
#
# ─── THE ONE THING THE AUDIT LOG CANNOT ANSWER ───────────────────────────────
#
# A pre-AECI-991 audit row records `before_state.productIds` — IDS. A deleted product
# has no row, so no query recovers the slug that id used to hold, and the move row is
# keyed on slugs. `retired-products.json` is the operator ruling that closes the gap,
# one sourced entry per retired id. An id that resolves in neither place prints
# `UNRESOLVED` and writes nothing; it is never guessed.
#
# Audit rows written from AECI-991 onward also carry `before_state.productSlugs`, which
# is used in preference to everything above. That file should stop growing.
#
# ─── NO NEW AUDIT ROWS, AND THAT IS DELIBERATE (ADR 0022) ────────────────────
#
# The mutation being repaired is already in the log — that is the whole input to this
# script. Writing a second `integration.endpoint_moved` row per rebuilt move would
# assert a move that never happened and would double every future reconstruction. One
# SUMMARY row per run is written instead, naming the run id and the count, so the
# repair itself is auditable without corrupting the event stream it reads.
#
# Idempotent: the INSERT is `OR IGNORE` against the composite primary key, and the
# summary row carries a NOT EXISTS guard on its run id. The rollback deletes only the
# rows this run could have written.
#
# USAGE (needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID):
#   scripts/ops/2026-09-endpoint-move-rebuild/rebuild.sh --env production
#   scripts/ops/2026-09-endpoint-move-rebuild/rebuild.sh --env production --apply --allow-production
#   scripts/ops/2026-09-endpoint-move-rebuild/rebuild.sh --env production --rollback --apply --allow-production

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
WRANGLER="$ROOT/apps/api/node_modules/.bin/wrangler"
CONFIG="$ROOT/apps/api/wrangler.jsonc"
RETIRED="$HERE/retired-products.json"

usage() {
  echo "usage: rebuild.sh --env <preview|staging|demo|production>" >&2
  echo "                  [--apply] [--allow-production] [--rollback]" >&2
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
[ -f "$RETIRED" ]  || { echo "missing ruling file at $RETIRED" >&2; exit 1; }
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || echo "warn: CLOUDFLARE_API_TOKEN is unset; wrangler will fall back to an interactive login." >&2

d1_json() { "$WRANGLER" d1 execute "$DB" --env "$ENV_NAME" --remote --json --config "$CONFIG" --command "$1"; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$HERE/backups/$STAMP-$ENV_NAME"
mkdir -p "$OUT"

echo "== target: $DB"
echo "   source: audit_log where action = 'integration.endpoint_moved'"
echo "   action: $([ "$ROLLBACK" = 1 ] && echo 'ROLLBACK (delete the rebuilt rows)' || echo 'REBUILD')"
echo "   mode:   $([ "$APPLY" = 1 ] && echo APPLY || echo DRY-RUN)"

# ─── 1. Read the audit rows, the live slug map and the existing move rows ─────
#
# Three `--command` reads rather than one join: `--file` routes through D1's import
# pipeline and returns no rows at all (it parses as valid JSON with one empty result,
# so a query run that way fails SILENTLY). Each is small — the audit slice is one
# action, and the products table is the whole catalog's id/slug pairs.
echo
echo "-- reading --"
d1_json "SELECT entity_id, before_state, created_at FROM audit_log
           WHERE action = 'integration.endpoint_moved'
           ORDER BY created_at" > "$OUT/audit.json"
d1_json "SELECT id, slug FROM products" > "$OUT/products.json"
d1_json "SELECT integration_id, from_product_a_slug, from_product_b_slug
           FROM integration_endpoint_moves" > "$OUT/existing.json"

# ─── 2. Project the cohort ────────────────────────────────────────────────────
python3 - "$OUT" "$RETIRED" <<'PYEOF'
import json, sys
out, retired_path = sys.argv[1], sys.argv[2]

def rows(name):
    raw = json.load(open(f"{out}/{name}.json"))
    sets = raw if isinstance(raw, list) else raw["result"]
    return [r for s in sets for r in (s.get("results") or [])]

retired = {k: v["slug"] for k, v in json.load(open(retired_path))["retired"].items()}
slug_by_id = {r["id"]: r["slug"] for r in rows("products")}
have = {(r["integration_id"], r["from_product_a_slug"], r["from_product_b_slug"])
        for r in rows("existing")}

planned, skipped, unresolved = [], 0, []
seen = set()
for r in rows("audit"):
    before = r["before_state"]
    if isinstance(before, str):
        before = json.loads(before)
    if not isinstance(before, dict):
        continue
    edge = r["entity_id"]
    # Preferred: the slugs the row states outright (AECI-991 onward).
    slugs = before.get("productSlugs")
    if not slugs:
        ids = before.get("productIds") or []
        slugs = []
        for pid in ids:
            s = slug_by_id.get(pid) or retired.get(pid)
            if not s:
                unresolved.append((edge, pid))
                slugs = []
                break
            slugs.append(s)
    if len(slugs) != 2:
        continue
    a, b = sorted(slugs)
    # A pair needs two distinct endpoints; equal slugs name no URL.
    if a == b:
        continue
    key = (edge, a, b)
    if key in seen:
        continue
    seen.add(key)
    if key in have:
        skipped += 1
        continue
    planned.append({"edge_id": edge, "from_a": a, "from_b": b, "moved_at": r["created_at"]})

json.dump(planned, open(f"{out}/rows.json", "w"), indent=2)

print(f"  {'old pair URL':64} edge")
for p in planned:
    print(f"  /products/{p['from_a']}/integrations/{p['from_b']:<28} {p['edge_id']}")
print()
print(f"  {len(planned)} row(s) to write; {skipped} already present.")
if unresolved:
    print()
    print("  UNRESOLVED — id resolves in neither `products` nor retired-products.json.")
    print("  Add a SOURCED entry to that file, or accept the loss. Never guess a slug.")
    for edge, pid in sorted(set(unresolved)):
        print(f"    edge {edge}  product {pid}")
PYEOF

ROW_N="$(python3 -c "import json,sys; print(len(json.load(open(sys.argv[1]))))" "$OUT/rows.json")"
if [ "$ROW_N" = "0" ]; then
  echo
  echo "Nothing to do — every recorded move already has its row (or none resolved)."
  exit 0
fi

# ─── 3. Generate the forward + rollback files ─────────────────────────────────
echo
echo "-- artifacts --"
python3 - "$OUT" "$STAMP" <<'PYEOF'
import json, sys, uuid, datetime
out, stamp = sys.argv[1], sys.argv[2]
planned = json.load(open(f"{out}/rows.json"))
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

def lit(s):
    """Quoted SQL literal. `wrangler d1 execute` has no bind support, so every value is
    escaped and interpolated the same way apps/api/src/lib/retract-product.ts does."""
    return "'" + str(s).replace("'", "''") + "'"

forward, back = [], []
for p in planned:
    forward.append(
        "INSERT OR IGNORE INTO integration_endpoint_moves "
        "(integration_id, from_product_a_slug, from_product_b_slug, moved_at) VALUES ("
        f"{lit(p['edge_id'])}, {lit(p['from_a'])}, {lit(p['from_b'])}, {lit(p['moved_at'])});"
    )
    back.append(
        "DELETE FROM integration_endpoint_moves WHERE integration_id = "
        f"{lit(p['edge_id'])} AND from_product_a_slug = {lit(p['from_a'])} "
        f"AND from_product_b_slug = {lit(p['from_b'])};"
    )

# ONE summary row for the repair itself. Not one per move — those events are already in
# the log, and this script's entire input is those rows.
summary = json.dumps(
    {"source": "ops-rebuild-aeci-991", "runId": stamp, "rebuilt": len(planned),
     "pairs": [[p["from_a"], p["from_b"]] for p in planned]},
    separators=(",", ":"),
)
forward.append(
    "INSERT INTO audit_log (id, actor_id, actor_type, action, entity_type, entity_id, "
    "before_state, after_state, metadata, created_at) "
    f"SELECT {lit(uuid.uuid4())}, NULL, 'system', 'integration.endpoint_moves_rebuilt', "
    f"'integration', NULL, NULL, NULL, {lit(summary)}, {lit(now)} "
    "WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'integration.endpoint_moves_rebuilt' "
    f"AND json_extract(metadata, '$.runId') = {lit(stamp)});"
)
back.append(
    "DELETE FROM audit_log WHERE action = 'integration.endpoint_moves_rebuilt' "
    f"AND json_extract(metadata, '$.runId') = {lit(stamp)};"
)

header = (f"-- AECI-991 endpoint-move rebuild from audit_log, run {stamp}\n"
          f"-- {len(planned)} move row(s) + one summary audit row, applied via\n"
          f"-- `wrangler d1 execute --file` (atomic D1 import).\n")
open(f"{out}/rebuild.sql", "w").write(header + "\n".join(forward) + "\n")
open(f"{out}/rollback.sql", "w").write(header + "\n".join(back) + "\n")
print(f"   forward:  {out}/rebuild.sql ({len(forward)} statements)")
print(f"   rollback: {out}/rollback.sql ({len(back)} statements)")
PYEOF

SQL_FILE="$OUT/rebuild.sql"
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
d1_json "SELECT COUNT(*) AS move_rows FROM integration_endpoint_moves;"

echo
cat <<EOF
DONE. Follow-ups (this script does NOT run them):
  1. verify   curl -sI https://www.aecintegrations.com/products/autodesk-construction-cloud/integrations/power-bi
              -> expect 301. NOTE that URL 301s from \`slug_redirects\` alone once
              AECI-991 ships, because the ACC slug is retired; the rows this script
              writes are what answer a pair whose endpoints both still exist.
  2. cache    production runs UNCACHED today (CACHE_STRATEGY.md §1), so no purge is
              needed there. On a cached tier, purge one \`pair:<a>__<b>\` tag per row
              in rows.json.
  3. record   Add a dated line to README.md's Run Log.
EOF
