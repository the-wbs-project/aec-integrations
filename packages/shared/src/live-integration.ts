/**
 * The "live integration" predicate, raw-SQL form (AECI-1010 /
 * `STAGE_1_5_SPEC.md` §13.5).
 *
 * An `integrations` row is LIVE when `retired_at IS NULL`. The owner retires a row
 * (`POST /api/vendor/integrations/:id/retire`) and restores it; a retired row keeps
 * its claims and attestations but counts nowhere, is searchable nowhere and renders
 * on no public page. Retire is not retract (ADR 0030): nothing is deleted.
 *
 * This module is the string half, for the sites that write SQL by hand and cannot
 * import from `apps/api`: the datatool reindex and prune, the catalog agent's
 * queries and the API's own operator scripts. The Drizzle half is
 * `apps/api/src/lib/live-integration.ts`, and both are pinned by
 * `apps/api/src/lib/count-lockstep.spec.ts`.
 *
 * Three rules, each of which has a failure behind it:
 *
 * 1. **`IS NULL`, never `= NULL`.** A comparison with NULL is never true. On the
 *    09:00 orphan sweep's id set that empties the set, and an empty set makes every
 *    record look orphaned (the cap then refuses the pass, so retired records are
 *    never swept either).
 * 2. **`integrations` only.** `connector_evidenced_pairs` has no `retired_at`. Every
 *    row there is connector-powered, and decision 9 of AECI-1003 keeps every vendor
 *    write, retire included, off connector-powered rows. Do not add the predicate to
 *    an evidenced-pair arm "for symmetry": the column does not exist.
 * 3. **Never key membership on `claimed_at` or `origin`.** Only `retired_at` removes
 *    a row. A predicate on either ownership column drops a small live subset, which
 *    sits under the orphan sweep's 50-delete cap and is deleted permanently.
 *
 * `scripts/ops/**` is plain `.mjs` and cannot import this. Those sites carry the
 * literal `retired_at IS NULL`, and the lockstep spec's source scan checks them.
 */

/** The column. Exported so a source scan can name it without a string literal. */
export const INTEGRATION_RETIRED_COLUMN = 'retired_at';

/** `<alias>."retired_at" IS NULL`: the row is live. Pass the table alias the
 *  surrounding query uses (`i`, `bi`, `integrations`). */
export function liveIntegrationSql(alias: string): string {
  return `${alias}."${INTEGRATION_RETIRED_COLUMN}" IS NULL`;
}

/** `<alias>."retired_at" IS NOT NULL`: the exact complement of
 *  {@link liveIntegrationSql}. The sync's delete arm is built from this. */
export function retiredIntegrationSql(alias: string): string {
  return `${alias}."${INTEGRATION_RETIRED_COLUMN}" IS NOT NULL`;
}

// ─── Tools that run against a DEPLOYED database ──────────────────────────────
//
// The datatool, the operator CLIs and the ops scripts query a deployed D1 directly.
// Migration `0044` (which adds `retired_at`) reaches each tier only at that tier's
// next deploy, and production can lag `main` by days. A query naming a missing column
// fails outright, so those tools read the table definition first and ask
// {@link liveIntegrationSqlIf} for a predicate that degrades to always-true when the
// column is absent. A database without the column cannot hold a retired row, so the
// degraded answer is also the correct one. This mirrors how the same tools probe
// `claimed_at` / `origin` for the vendor-held rule (AECI-1005 review).

/** The read that returns the `integrations` table's `CREATE TABLE` text. */
export const INTEGRATIONS_DDL_QUERY = `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'integrations'`;

/**
 * Does this `CREATE TABLE` text (from `sqlite_master.sql`) declare `retired_at`?
 * A declared type must follow the name, so a mention inside a CHECK does not count.
 * Columns added by `ALTER TABLE … ADD` are rewritten into this text by SQLite.
 */
export function ddlHasRetiredColumn(ddl: string | null | undefined): boolean {
  if (typeof ddl !== 'string') return false;
  return new RegExp(
    `[(,]\\s*[\`"\\[]?${INTEGRATION_RETIRED_COLUMN}[\`"\\]]?\\s+(text|integer|int|real|blob|numeric)\\b`,
    'i',
  ).test(ddl);
}

/**
 * The DDL text out of an {@link INTEGRATIONS_DDL_QUERY} read, or a THROW. An empty
 * read is "could not check", never "no column": falling back to `''` would silently
 * count retired rows as live on a migrated database.
 */
export function integrationsDdlOrThrow(sql: unknown): string {
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new Error(
      'Could not read the integrations table definition from sqlite_master, so retired rows cannot be excluded. Refusing to continue.',
    );
  }
  return sql;
}

/** {@link liveIntegrationSql} when the column exists, else the always-true `1 = 1`. */
export function liveIntegrationSqlIf(alias: string, hasRetiredColumn: boolean): string {
  return hasRetiredColumn ? liveIntegrationSql(alias) : '1 = 1';
}
