/**
 * The public read of AECi's corrections (AECI-1614). One statement per entity table,
 * meant for the page's existing `db.batch`. It adds no round trip and no query per row:
 * each scope is a predicate on the page's slug-keyed ids, so no id list is bound and D1's
 * 100-parameter cap is out of reach. It reads lifted rows too (ADR 0039).
 *
 * The live value comes back from the same statement as a `CASE` over the entity's own
 * columns, so a row list need not select a description per row to compare one correction.
 * The selection is the guard: `reason`, `internal_note`, `lift_reason`, `set_by` and
 * `vendor_id` are never read here, so no mapper can publish them.
 */

import type { FieldOverrideEntityType } from '@aeci/shared';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';

import type { Db } from '../db/client';
import {
  connectorEvidencedPairs,
  fieldOverrides,
  integrations,
  products,
  vendors,
} from '../db/schema';

import type { CorrectionRow } from './field-captions';
import { PRODUCT_OVERRIDE_COLUMNS, VENDOR_OVERRIDE_COLUMNS } from './field-overrides';
import { EDIT_FIELD_COLUMNS } from './integration-contests';

/** `CASE field WHEN 'website' THEN "website" ... END`. A field with no column (a facet)
 *  reads NULL, and the mapper compares it against the product's slugs instead. */
function liveValue(table: SQLiteTable, columns: Readonly<Record<string, string>>): SQL {
  const byKey = table as unknown as Record<string, SQLiteColumn>;
  const arms = Object.entries(columns).map(([field, key]) => sql`WHEN ${field} THEN ${byKey[key]}`);
  return sql`CASE ${fieldOverrides.field} ${sql.join(arms, sql` `)} END`;
}

function correctionsQuery(
  db: Db,
  entityType: FieldOverrideEntityType,
  table: SQLiteTable,
  id: SQLiteColumn,
  columns: Readonly<Record<string, string>>,
  scope: SQL | undefined,
) {
  return db
    .select({
      id: fieldOverrides.id,
      entityId: fieldOverrides.entityId,
      field: fieldOverrides.field,
      value: fieldOverrides.value,
      sourceUrl: fieldOverrides.sourceUrl,
      setAt: fieldOverrides.setAt,
      live: sql<CorrectionRow['live']>`${liveValue(table, columns)}`,
    })
    .from(fieldOverrides)
    .innerJoin(table, eq(id, fieldOverrides.entityId))
    .where(and(eq(fieldOverrides.entityType, entityType), scope));
}

/** Corrections on the vendors `scope` selects. */
export function vendorCorrectionsQuery(db: Db, scope: SQL) {
  return correctionsQuery(db, 'vendor', vendors, vendors.id, VENDOR_OVERRIDE_COLUMNS, scope);
}

/** Corrections on the products `scope` selects. */
export function productCorrectionsQuery(db: Db, scope: SQL) {
  return correctionsQuery(db, 'product', products, products.id, PRODUCT_OVERRIDE_COLUMNS, scope);
}

/** Corrections on the `integrations` rows `scope` selects. */
export function integrationCorrectionsQuery(db: Db, scope: SQL | undefined) {
  return correctionsQuery(
    db,
    'integration',
    integrations,
    integrations.id,
    EDIT_FIELD_COLUMNS,
    scope,
  );
}

/** Corrections on the `connector_evidenced_pairs` rows `scope` selects. A pair has no
 *  `mechanism_kind` column, and that field is never offered on one. */
export function evidencedPairCorrectionsQuery(db: Db, scope: SQL | undefined) {
  const { mechanism_kind: _frozen, ...columns } = EDIT_FIELD_COLUMNS;
  return correctionsQuery(
    db,
    'connector_evidenced_pair',
    connectorEvidencedPairs,
    connectorEvidencedPairs.id,
    columns,
    scope,
  );
}

/** Rows from any of the reads above, keyed by entity id. Ids are UUIDs across all four
 *  tables, so one map serves a page. */
export function groupCorrections(
  ...reads: ReadonlyArray<readonly CorrectionRow[]>
): Map<string, CorrectionRow[]> {
  const out = new Map<string, CorrectionRow[]>();
  for (const rows of reads) {
    for (const row of rows) {
      const list = out.get(row.entityId);
      if (list) list.push(row);
      else out.set(row.entityId, [row]);
    }
  }
  return out;
}
