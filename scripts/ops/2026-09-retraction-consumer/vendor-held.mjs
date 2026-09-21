//
// vendor-held.mjs — "is this delivered-tier row the vendor's, not AECi's?" for the
// ops lanes (AECI-1005 / ADR 0035).
//
// Pure, dependency-free, no I/O. Imported by the retraction consumer (this directory)
// and by the strand audit's `classify.mjs`, and tested from
// `apps/api/src/test/vendor-held.spec.ts`, which also pins it against the API
// Worker's own `isVendorHeld` in `apps/api/src/lib/integration-claims.ts`.
// `scripts/ops/**` cannot import TypeScript, so this is a deliberate second copy of a
// two-clause rule, and the spec is what keeps the two copies equal.
//
// ─── THE RULE ────────────────────────────────────────────────────────────────
//
// A row is VENDOR-HELD when either:
//   - `claimed_at IS NOT NULL` — its owner claimed it (or AECi approved an
//     owner-unknown claim). From then on promote writes nothing to it; or
//   - `origin = 'vendor'` — a vendor created it (AECI-1011). It never had an
//     upstream record at all.
//
// Every lane that treats "no upstream record points at this row" as "this row is an
// orphan" is wrong about a vendor-held row. The upstream record of a claimed row may
// be deleted or re-curated upstream without that being a ruling on the vendor's row,
// and a vendor-created row never had one. So:
//   - the strand audit must not report it as source-gone;
//   - the datatool prune must refuse to delete it, with no acknowledgment override;
//   - the retraction consumer must refuse, loudly, to delete it.
//
// ─── WHY THE COLUMNS ARE PROBED, NOT ASSUMED ─────────────────────────────────
//
// These tools run against DEPLOYED databases, and migration `0044` reaches each tier
// only when that tier is next deployed. Production can lag `main` by days. A query
// that names `claimed_at` on a database without the column fails outright, which is
// "could not check" (exit 2) every day until the promote lands. So each lane reads the
// table's DDL once and asks {@link vendorHeldColumnsSql} for a projection that
// degrades to `NULL` where a column is absent. A database without the columns cannot
// hold a claimed or vendor-created row, so the degraded answer is also the correct one.

/** The two columns the rule reads. `connector_evidenced_pairs` has neither today. */
export const VENDOR_HELD_COLUMNS = ['claimed_at', 'origin'];

/**
 * Does this `CREATE TABLE` statement (from `sqlite_master.sql`) declare `column`?
 * Matches a quoted or bare identifier at a column-definition position followed by
 * a declared type, so a name inside a CHECK expression does not count. Columns added by `ALTER TABLE … ADD` are rewritten into this text by SQLite.
 */
export function ddlHasColumn(ddl, column) {
  if (typeof ddl !== 'string') return false;
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A declared type must follow, which is what tells a column definition apart from
  // the same name inside a CHECK expression (`CHECK ("origin" IN …)`).
  return new RegExp(
    `[(,]\\s*[\`"\\[]?${escaped}[\`"\\]]?\\s+(text|integer|int|real|blob|numeric)\\b`,
    'i',
  ).test(ddl);
}

/**
 * The SELECT-list fragment that projects `claimed_at` and `origin` for table alias
 * `alias`, as `claimedAt` and `origin`, with `NULL` standing in for any column the
 * table does not have.
 */
export function vendorHeldColumnsSql(alias, ddl) {
  const col = (name, as) =>
    ddlHasColumn(ddl, name) ? `${alias}.${name} AS ${as}` : `NULL AS ${as}`;
  return `${col('claimed_at', 'claimedAt')}, ${col('origin', 'origin')}`;
}

/** The rule. Accepts either spelling of the columns, so a raw `SELECT *` row and an
 *  aliased one both work. */
export function isVendorHeld(row) {
  if (!row) return false;
  const claimedAt = row.claimedAt ?? row.claimed_at ?? null;
  return (claimedAt !== null && claimedAt !== undefined) || row.origin === 'vendor';
}

/**
 * The retraction consumer's refusal set: every resolved live row that is
 * vendor-held and NOT on the operator's HOLD list.
 *
 * A held vendor-held row is fine. HOLD never deletes and never confirms, which is
 * exactly what a vendor-owned row needs: its journal entry stays pending until
 * someone rules on it. Anything else vendor-held is a delete the lane must refuse.
 *
 * `items` are `{ entry: { supabaseId }, table, row }`, as the consumer builds them.
 */
export function vendorHeldRefusals(items, hold = {}) {
  return items.filter((item) => isVendorHeld(item.row) && !hold[item.entry.supabaseId]);
}
