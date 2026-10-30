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
// These tools run against DEPLOYED databases, and migrations `0044` (`integrations`)
// and `0049` (`connector_evidenced_pairs`, AECI-1088) reach each tier
// only when that tier is next deployed. Production can lag `main` by days. A query
// that names `claimed_at` on a database without the column fails outright, which is
// "could not check" (exit 2) every day until the promote lands. So each lane reads the
// table's DDL once and asks {@link vendorHeldColumnsSql} for a projection that
// degrades to `NULL` where a column is absent. A database without the columns cannot
// hold a claimed or vendor-created row, so the degraded answer is also the correct one.

/** The two columns the rule reads. `integrations` gained them in migration 0044 and
 *  `connector_evidenced_pairs` in migration 0049 (AECI-1088). */
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

/**
 * The DDL text out of a `SELECT sql FROM sqlite_master …` read, or a THROW.
 *
 * An empty read is "could not check", never "no columns" (AECI-1005 review): falling
 * back to `''` would project NULL for both columns and silently switch the vendor-held
 * protection off for the whole run. Both scripts route a throw to exit 2.
 */
export function tableDdlOrThrow(rows, table) {
  const ddl = Array.isArray(rows) ? rows[0]?.sql : undefined;
  if (typeof ddl !== 'string' || ddl.trim() === '') {
    throw new Error(
      `could not read the table definition of \`${table}\` from sqlite_master, so the ` +
        'vendor-held protection cannot be checked. Refusing to continue.',
    );
  }
  return ddl;
}

/**
 * A WHERE-clause suffix that keeps a DELETE off vendor-held rows, or `''` when the
 * table predates its ownership migration (0044 for `integrations`, 0049 for
 * `connector_evidenced_pairs`), where no row can be vendor-held. The consumer puts
 * it in the DELETE itself, so a row claimed between the plan and the write survives,
 * and the verify step reports it as a leftover instead of confirming it.
 */
export function notVendorHeldSql(ddl) {
  return ddlHasColumn(ddl, 'claimed_at') && ddlHasColumn(ddl, 'origin')
    ? ` AND "claimed_at" IS NULL AND "origin" <> 'vendor'`
    : '';
}

const sqlText = (v) => `'${String(v).replace(/'/g, "''")}'`;

const SQL_UUID =
  `lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || ` +
  `substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || ` +
  `substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))`;

/**
 * The private-thread detach for a claim delete (AECI-1542,
 * `STAGE_2_ATTESTATIONS_SPEC.md` §15.5), as two SQL statements to run in the delete's
 * batch, BEFORE the claims DELETE. Every thread on a claim in `claimScope` (a subquery)
 * is detached: `claim_id` NULLed and `anchor_snapshot` written from the claim. An open
 * thread also closes `claim_removed`, with one `thread.closed` audit row, written
 * first, and one `portal-thread-closed` notice per company (AECI-1548, §15.8), the
 * `notification.sent` row `threadClosedNoticeStatements` writes. `vendor_id`
 * (migration 0063) is safe to name, because this runs only where 0098 is. A closed
 * thread keeps its reason and gets no notice. The messages stay.
 *
 * `scripts/ops/**` cannot import TypeScript, so this is a deliberate copy of
 * `claimRemovedThreadDetachWhere` in `apps/api/src/lib/claim-thread-lifecycle.ts`.
 * `apps/api/src/test/vendor-held.spec.ts` runs it against the real migrations.
 * Only call it on a tier that has `claim_threads` (migration 0098): probe first.
 */
export function claimThreadDetachSql({ claimScope, now, metadata }) {
  const meta = `json_set(${sqlText(JSON.stringify(metadata ?? {}))}, '$.claimId', t.claim_id, '$.closedReason', 'claim_removed')`;
  return [
    `INSERT INTO audit_log (id, actor_id, actor_type, action, entity_type, entity_id, after_state, metadata, created_at) ` +
      `SELECT ${SQL_UUID}, NULL, 'system', 'thread.closed', 'claim_thread', t.id, ` +
      `json_object('closedAt', ${sqlText(now)}, 'closedReason', 'claim_removed'), ${meta}, ${sqlText(now)} ` +
      `FROM claim_threads t WHERE t.claim_id IN (${claimScope}) AND t.closed_at IS NULL;`,
    ...[
      ['vendor_a_id', 'vendor_b_id'],
      ['vendor_b_id', 'vendor_a_id'],
    ].map(
      ([recipient, other]) =>
        `INSERT INTO audit_log (id, actor_id, actor_type, action, entity_type, entity_id, metadata, created_at, vendor_id) ` +
        `SELECT ${SQL_UUID}, NULL, 'system', 'notification.sent', 'claim_thread', t.id, ` +
        `json_object('kind', 'thread_closed', 'notificationId', 'portal-thread-closed', ` +
        `'vendorId', t.${recipient}, 'otherVendorId', t.${other}, 'otherVendorName', ov.company_name, ` +
        `'threadId', t.id, 'claimId', t.claim_id, 'closedReason', 'claim_removed', ` +
        `'dataObject', json(CASE WHEN d.id IS NULL THEN NULL ELSE json_object('slug', d.slug, 'name', d.name) END)), ` +
        `${sqlText(now)}, t.${recipient} ` +
        `FROM claim_threads t LEFT JOIN vendors ov ON ov.id = t.${other} ` +
        `LEFT JOIN claims c ON c.id = t.claim_id ` +
        `LEFT JOIN taxonomy_data_objects d ON d.id = c.data_object_id ` +
        `WHERE t.claim_id IN (${claimScope}) AND t.closed_at IS NULL;`,
    ),
    `UPDATE claim_threads SET claim_id = NULL, ` +
      `anchor_snapshot = coalesce(anchor_snapshot, (SELECT json_object('anchorId', c.anchor_id, 'dataObjectId', c.data_object_id) FROM claims c WHERE c.id = claim_threads.claim_id)), ` +
      `closed_at = coalesce(closed_at, ${sqlText(now)}), ` +
      `closed_reason = coalesce(closed_reason, 'claim_removed') ` +
      `WHERE claim_id IN (${claimScope});`,
  ];
}

/**
 * The child-to-parent DELETEs for a set of anchor rows, every one scoped to the rows
 * that are still NOT vendor-held at write time (AECI-1005 review for `integrations`,
 * AECI-1088 for `connector_evidenced_pairs`). A row claimed after the plan keeps
 * itself, its claims and their attestations, and the verify step reports it.
 *
 * `table` is the anchor table, `anchorColumn` the `claims` column that points at it,
 * `ph` the quoted id list and `keep` the {@link notVendorHeldSql} suffix for that
 * table's own DDL. Explicit child-to-parent because D1 does not guarantee FK
 * enforcement is on for a given `wrangler d1 execute`.
 *
 * `threadDetach` (`{ now, metadata }`, AECI-1542) puts {@link claimThreadDetachSql}
 * first, scoped to the same claims. Pass it on every tier that has `claim_threads`.
 */
export function guardedAnchorDeleteSql({ table, anchorColumn, ph, keep, threadDetach }) {
  const deletable = `SELECT id FROM ${table} WHERE id IN (${ph})${keep}`;
  return [
    ...(threadDetach
      ? claimThreadDetachSql({
          claimScope: `SELECT id FROM claims WHERE ${anchorColumn} IN (${deletable})`,
          ...threadDetach,
        })
      : []),
    `DELETE FROM attestations WHERE claim_id IN (SELECT id FROM claims WHERE ${anchorColumn} IN (${deletable}));`,
    `DELETE FROM claims WHERE ${anchorColumn} IN (${deletable});`,
    `DELETE FROM ${table} WHERE id IN (${ph})${keep};`,
  ];
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
