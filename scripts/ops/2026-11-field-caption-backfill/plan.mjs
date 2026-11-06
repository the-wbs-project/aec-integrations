// The field-caption backfill's one definition (AECI-1614): which column, on which rows,
// from what. `run.mjs` turns each entry into a dry-run SELECT or an UPDATE, so the two
// cannot disagree. `apps/api/src/lib/field-caption-backfill.spec.ts` runs them for real.
//
// Stamps read vendor-portal audit rows only (`metadata.source`), and only rows after the
// record last left the vendor, so promote's text never takes a vendor's date. Every write
// fills a NULL and never overwrites, so a re-run, or a run after live writes, is safe.
// Raw SQL has no `$onUpdate`, so `updated_at` does not move.

const VENDOR_WRITE = `json_extract(a.metadata, '$.source') = 'vendor-portal'`;

/** A key is in the audit diff and its value moved. Absent keys read NULL from json_type. */
const moved = (key) =>
  `(json_type(a.after_state, '$.${key}') IS NOT NULL AND json_extract(a.after_state, '$.${key}') IS NOT json_extract(a.before_state, '$.${key}'))`;

/** The last time a product left its vendor (`lib/vendor-handback.ts`). */
const productReturnedAt = `COALESCE((SELECT MAX(r.created_at) FROM audit_log r WHERE r.entity_type = 'product' AND r.entity_id = products.id AND json_extract(r.metadata, '$.cause') = 'records-returned-to-aeci'), '')`;

function productStamp(column, keys, { since: sinceRule }) {
  const since =
    sinceRule === 'always'
      ? ` AND a.created_at > ${productReturnedAt}`
      : ` AND (products.usefulness_source IS NOT NULL OR a.created_at > ${productReturnedAt})`;
  return {
    table: 'products',
    column,
    value: `(SELECT MAX(a.created_at) FROM audit_log a WHERE a.entity_type = 'product' AND a.entity_id = products.id AND a.action IN ('product.updated', 'product.created') AND ${VENDOR_WRITE} AND (${keys.map(moved).join(' OR ')})${since})`,
    where: `${column} IS NULL`,
  };
}

/** A row's stamp: the holder's own content writes since it last changed hands. A per-side
 *  link counts only when the holder wrote it and the row rendered it, as the live writer. */
function rowStamp(table, entityType) {
  const left = `COALESCE((SELECT MAX(r.created_at) FROM audit_log r WHERE r.entity_type = '${entityType}' AND r.entity_id = ${table}.id AND json_extract(r.metadata, '$.reason') IN ('records-returned-to-aeci', 'owner-reassigned', 'owner-approved')), '')`;
  return {
    table,
    column: 'vendor_edited_at',
    value: `(SELECT MAX(a.created_at) FROM audit_log a WHERE a.entity_type = '${entityType}' AND a.entity_id = ${table}.id AND ${VENDOR_WRITE} AND json_extract(a.metadata, '$.vendorId') = ${table}.built_by_vendor_id AND ((a.action = 'integration.updated' AND json_extract(a.metadata, '$.reason') IN ('owner-edit', 'contest-accepted')) OR a.action = 'integration.created' OR (a.action IN ('integration.link_set', 'integration.link_removed') AND json_extract(a.metadata, '$.connectorPowered') IS NULL AND json_extract(a.before_state, '$.url') IS NOT json_extract(a.after_state, '$.url'))) AND a.created_at > ${left})`,
    where: `vendor_edited_at IS NULL AND built_by_vendor_id IS NOT NULL AND (claimed_at IS NOT NULL OR origin = 'vendor')`,
  };
}

const LIVE_ON_VENDOR = `EXISTS (SELECT 1 FROM licenses l JOIN billing_accounts b ON b.id = l.billing_account_id WHERE b.vendor_id = vendors.id AND l.ended_at IS NULL)`;
const LIVE_ON_PRODUCT = `EXISTS (SELECT 1 FROM licenses l WHERE l.assigned_product_id = products.id AND l.ended_at IS NULL)`;

export const PLAN = [
  productStamp('description_edited_at', ['description'], { since: 'always' }),
  productStamp('profile_edited_at', ['website', 'category_slugs'], { since: 'always' }),
  // A set `usefulness_source` is one-way, so its stamp survives a return (ADR 0033). A
  // proposal accept leaves it NULL, and promote can write that text after a return.
  productStamp('usefulness_edited_at', ['usefulness'], { since: 'unless-source-set' }),
  productStamp(
    'managed_edited_at',
    ['toolIntegrationsUrl', 'apiDocsUrl', 'trade_slugs', 'audience_slugs', 'phase_slugs'],
    { since: 'always' },
  ),
  rowStamp('integrations', 'integration'),
  rowStamp('connector_evidenced_pairs', 'connector_evidenced_pair'),
  {
    table: 'vendors',
    column: 'plan_ended_at',
    value: `(SELECT MAX(l.ended_at) FROM licenses l JOIN billing_accounts b ON b.id = l.billing_account_id WHERE b.vendor_id = vendors.id)`,
    where: `plan_ended_at IS NULL AND NOT ${LIVE_ON_VENDOR}`,
  },
  {
    table: 'products',
    column: 'managed_ended_at',
    // The later of an ended license still naming the product and an early unassign, which
    // leaves no pointer on the license and is known only from its audit row.
    value: `(SELECT MAX(at) FROM (SELECT l.ended_at AS at FROM licenses l WHERE l.assigned_product_id = products.id AND l.ended_at IS NOT NULL UNION ALL SELECT a.created_at AS at FROM audit_log a WHERE a.entity_type = 'billing_account' AND a.product_id = products.id AND a.action IN ('license.unassigned', 'license.release_approved') AND json_extract(a.before_state, '$.assigned_product_id') = products.id AND json_extract(a.after_state, '$.assigned_product_id') IS NULL))`,
    where: `managed_ended_at IS NULL AND NOT ${LIVE_ON_PRODUCT}`,
  },
];

/** The dry-run SELECT: how many rows would change, and a sample. */
export function projectionSql({ table, column, value, where }) {
  const label = `'${table}.${column}'`;
  return `SELECT ${label} AS target, COUNT(*) AS would_write, MIN(v) AS earliest, MAX(v) AS latest FROM (SELECT ${value} AS v FROM ${table} WHERE ${where}) WHERE v IS NOT NULL;`;
}

/** The UPDATE. The value is non-NULL or the row is left alone. */
export function updateSql({ table, column, value, where }) {
  return `UPDATE ${table} SET ${column} = ${value} WHERE ${where} AND ${value} IS NOT NULL;`;
}
