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
 * 2. **Both arms (AECI-1091).** `connector_evidenced_pairs` gained `retired_at` in
 *    migration `0049`, and since AECI-1091 the owner and AECi retire pairs too (the
 *    AECI-1040 carve-out). So every count and id set filters BOTH tables: the
 *    `integrations` arm with {@link liveIntegrationSql} and the evidenced arm with
 *    {@link liveEvidencedPairSql}. They are the same SQL. They have two names so
 *    `count-lockstep.spec.ts` can prove each site carries both arms rather than one.
 *    (Until AECI-1091 this rule was "`integrations` only", because no route could
 *    retire a pair.)
 * 3. **Never key membership on `claimed_at` or `origin`.** Only `retired_at` removes
 *    a row. A predicate on either ownership column drops a small live subset, which
 *    sits under the orphan sweep's 50-delete cap and is deleted permanently.
 *
 * 4. **Liveness includes endpoint visibility (AECI-1238, ADR 0052).** A row that
 *    touches a hidden product (`products.hidden_at`, `listing-visibility.ts`) as
 *    source, target or connector is not live: its page would name a listing AECi
 *    took down. The clause is part of {@link liveIntegrationSql} and
 *    {@link liveEvidencedPairSql}, so every site inherits it. It is NOT part of the
 *    retire test: a write guard that only asks "has the owner retired this?" uses
 *    {@link notRetiredIntegrationSql}, because the portal keeps working while a
 *    listing is hidden.
 *
 * `scripts/ops/**` is plain `.mjs` and cannot import this. Those sites carry the
 * literal `retired_at IS NULL`, and the lockstep spec's source scan checks them.
 */

import { endpointsVisibleSql, endpointsVisibleSqlIf } from './listing-visibility';

/** The column. Exported so a source scan can name it without a string literal. */
export const INTEGRATION_RETIRED_COLUMN = 'retired_at';

/** The endpoint columns of an `integrations` row, qualified by `alias`. */
function integrationEndpointColumns(alias: string): string[] {
  return [
    `${alias}."source_product_id"`,
    `${alias}."target_product_id"`,
    `${alias}."powered_by_product_id"`,
  ];
}

/** The endpoint columns of a `connector_evidenced_pairs` row, qualified by `alias`. */
function evidencedPairEndpointColumns(alias: string): string[] {
  return [`${alias}."product_a_id"`, `${alias}."product_b_id"`, `${alias}."connector_product_id"`];
}

/** `<alias>."retired_at" IS NULL`: the owner has not retired the row. The retire
 *  test alone, for write guards. Public reads use {@link liveIntegrationSql}. */
export function notRetiredIntegrationSql(alias: string): string {
  return `${alias}."${INTEGRATION_RETIRED_COLUMN}" IS NULL`;
}

/** The row is live: not retired, and no endpoint or connector is hidden. Pass the
 *  table alias the surrounding query uses (`i`, `bi`, `integrations`). */
export function liveIntegrationSql(alias: string): string {
  return `(${notRetiredIntegrationSql(alias)} AND ${endpointsVisibleSql(integrationEndpointColumns(alias))})`;
}

/** The exact complement of {@link liveIntegrationSql}: retired, or touching a
 *  hidden product. The sync's delete arm is built from this. */
export function notLiveIntegrationSql(alias: string): string {
  return `NOT ${liveIntegrationSql(alias)}`;
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

/**
 * {@link liveIntegrationSql}, degraded per column for a database whose migrations
 * lag: the retire clause needs `integrations.retired_at` (migration `0044`), the
 * endpoint clause needs `products.hidden_at` (migration `0112`). Each absent column
 * degrades its own clause to always-true. Both flags are required, so a tool cannot
 * forget to probe one.
 */
export function liveIntegrationSqlIf(
  alias: string,
  hasRetiredColumn: boolean,
  hasHiddenColumn: boolean,
): string {
  const retired = hasRetiredColumn ? notRetiredIntegrationSql(alias) : '1 = 1';
  return `(${retired} AND ${endpointsVisibleSqlIf(integrationEndpointColumns(alias), hasHiddenColumn)})`;
}

// ─── The evidenced arm (AECI-1091) ───────────────────────────────────────────
//
// `connector_evidenced_pairs` carries `retired_at` too (migration `0049`), with the
// same meaning. The functions below are the evidenced arm's names for the same SQL.
// A site that counts or lists both tables uses one name per arm, so the lockstep
// spec's source scan can tell a two-arm site from a one-arm site. Migration `0049`
// reaches a deployed tier later than `0044` did, so the tools that probe
// `integrations` for the column probe this table separately.

/** The pair is live over `connector_evidenced_pairs`: not retired, and neither
 *  endpoint nor the connector is hidden. */
export function liveEvidencedPairSql(alias: string): string {
  return `(${alias}."${INTEGRATION_RETIRED_COLUMN}" IS NULL AND ${endpointsVisibleSql(evidencedPairEndpointColumns(alias))})`;
}

/** The exact complement of {@link liveEvidencedPairSql}. */
export function notLiveEvidencedPairSql(alias: string): string {
  return `NOT ${liveEvidencedPairSql(alias)}`;
}

/** The read that returns the `connector_evidenced_pairs` table's `CREATE TABLE` text. */
export const EVIDENCED_PAIRS_DDL_QUERY = `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'connector_evidenced_pairs'`;

/** {@link integrationsDdlOrThrow} for the evidenced table. An empty read throws. */
export function evidencedPairsDdlOrThrow(sql: unknown): string {
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new Error(
      'Could not read the connector_evidenced_pairs table definition from sqlite_master, so retired pairs cannot be excluded. Refusing to continue.',
    );
  }
  return sql;
}

/** {@link liveEvidencedPairSql}, degraded per column like
 *  {@link liveIntegrationSqlIf}: `retired_at` on the pair table (migration `0049`)
 *  and `products.hidden_at` (migration `0112`). */
export function liveEvidencedPairSqlIf(
  alias: string,
  hasRetiredColumn: boolean,
  hasHiddenColumn: boolean,
): string {
  const retired = hasRetiredColumn ? `${alias}."${INTEGRATION_RETIRED_COLUMN}" IS NULL` : '1 = 1';
  return `(${retired} AND ${endpointsVisibleSqlIf(evidencedPairEndpointColumns(alias), hasHiddenColumn)})`;
}
