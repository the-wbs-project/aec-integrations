//
// classify.mjs — the pure half of the strand audit (AECI-897 / AECI-888).
//
// Every function here is a total function of its arguments. No wrangler, no MCP, no fs,
// no clock. `audit.mjs` keeps all of that and calls into this file, which is the only
// reason any of it can be tested: `scripts/ops/**` has no test harness of its own, so the
// spec lives at `apps/api/src/test/strand-classify.spec.ts` where the unit lane already
// runs in plain Node and picks it up with no config change.
//
// ─── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
//
// The audit read `integrations` and counted `connector_evidenced_pairs` without ever
// classifying it. On 2026-09-10 and again on 2026-09-11 it reported GREEN, immediately
// after 215 rows were deleted upstream with none removed from the public site. All 215
// were in the table it does not read. A check that cannot see a whole table is worse than
// no check, because it reads as coverage (AECI-897).
//
// The recorded reason for the exclusion was that classifying pairs against
// `list_integrations` "would report all of them, every run". That was MEASURED on
// 2026-09-14 against production and is wrong:
//
//     upstream integrations carrying a supabaseId   1,010
//     D1 connector_evidenced_pairs                     62
//       ...claimed upstream                            60
//       ...unclaimed                                    2
//
// It is wrong by 60 of 62. The comparand is sound because the ids are the same ids: the
// product promote arm writes a pair row under the caller's `supabaseId` verbatim and
// reports it back on `response.integrations[]`, which the review app stores in the same
// `supabase_integration_id` column `list_integrations` projects. Spot-checked on upstream
// `recBL85bbICUSkvp7`, whose `supabaseId` is the `connector_evidenced_pairs` row
// `a70e2044-1fe6-42e7-9437-b0d25ea6fc9a`.
//
// The two unclaimed rows are HeavyJob → Sage 300 CRE and HeavyJob → Procore. They are
// candidate findings, not noise, and the first scheduled run rules on them.
//

/**
 * The floor under {@link comparandLooksBroken}.
 *
 * A table where EVERY row is unclaimed is far more likely to mean the comparand broke
 * than that the whole catalogue was retracted at once — but only once there are enough
 * rows for "every" to mean anything. Three rows that are genuinely all stranded is a
 * finding, not a broken join. Ten is the smallest number where the inference is worth
 * more than the rows it would suppress. Measured headroom on 2026-09-14: 60 of 62
 * claimed, so the gate is nowhere near tripping on healthy data.
 */
export const COMPARAND_FLOOR = 10;

/**
 * Did the comparison itself fail, rather than find something?
 *
 * If upstream ever stops projecting `supabaseId` on `list_integrations`, or renames it,
 * or the tool starts excluding connector-powered edges, then EVERY pair row goes
 * unclaimed and the audit reports the entire table as stranded. That is not a finding —
 * it is the check breaking, and reporting it as 62 stranded rows would send an operator
 * to delete a live catalogue.
 *
 * So it is routed to the audit's exit 2, "could not check", which is the same line every
 * other upstream read in the lane draws and is explicitly NOT a pass.
 */
export function comparandLooksBroken({ tableSize, unclaimed, floor = COMPARAND_FLOOR }) {
  return tableSize >= floor && unclaimed === tableSize;
}

/** `/products/{slug}` — duplicated rather than imported so this file stays dependency-free. */
const productUrl = (slug) => `/products/${slug}`;
const pairUrl = (a, b) => `/products/${a}/integrations/${b}`;

/**
 * One finding for an `integrations` row.
 *
 * `table` is new (AECI-888) and is on EVERY entry, including the `integrations` ones. An
 * id alone does not say which table holds it — migration `0027` preserved ids verbatim
 * across the move — and the `--ids-out` file is consumed by hand, so an entry that does
 * not name its table is an entry an operator can act on wrongly.
 */
export function integrationEntry(row, reason, deps) {
  const { slugOf, promotedOf } = deps;
  const a = slugOf(row.source_product_id);
  const b = slugOf(row.target_product_id);
  return {
    id: row.id,
    table: 'integrations',
    name: row.name,
    mechanismKind: row.mechanism_kind,
    reason,
    sourceProductId: row.source_product_id,
    targetProductId: row.target_product_id,
    builtByVendorId: row.built_by_vendor_id,
    poweredByProductId: row.powered_by_product_id,
    url: a && b ? pairUrl(a, b) : null,
    // Both endpoint pages also render the edge, so a retraction touches three URLs.
    alsoRenderedOn: [a && productUrl(a), b && productUrl(b)].filter(Boolean),
    inAlgolia: promotedOf(row.source_product_id) && promotedOf(row.target_product_id),
    cascade: { claims: row.claim_count, attestations: row.attestation_count },
  };
}

/**
 * One finding for a `connector_evidenced_pairs` row.
 *
 * Same shape as {@link integrationEntry} on purpose, so the report, the summary table and
 * the id list stay table-agnostic. Three columns differ and the mapping is the one the
 * retraction consumer already uses (`consume.mjs`): endpoints are `product_a_id` /
 * `product_b_id`, the mechanism label is `mechanism_name` (there is no `mechanism_kind`
 * column — the lane answers "which mechanism"), and the connector is a third product that
 * is neither endpoint.
 *
 * `poweredByProductId` carries the connector so a reader comparing the two tables does
 * not have to know which column each one keeps it in.
 */
export function evidencedPairEntry(row, reason, deps) {
  const { slugOf, promotedOf } = deps;
  const a = slugOf(row.product_a_id);
  const b = slugOf(row.product_b_id);
  const connector = slugOf(row.connector_product_id);
  return {
    id: row.id,
    table: 'connector_evidenced_pairs',
    name: row.name,
    mechanismKind: row.mechanism_name,
    reason,
    sourceProductId: row.product_a_id,
    targetProductId: row.product_b_id,
    builtByVendorId: row.built_by_vendor_id,
    poweredByProductId: row.connector_product_id,
    url: a && b ? pairUrl(a, b) : null,
    // The connector's own hub renders the edge too (§12.5 option B counts it there), so
    // a de-listing touches FOUR urls for a pair, not three.
    alsoRenderedOn: [
      a && productUrl(a),
      b && productUrl(b),
      connector && productUrl(connector),
    ].filter(Boolean),
    inAlgolia: promotedOf(row.product_a_id) && promotedOf(row.product_b_id),
    cascade: { claims: row.claim_count, attestations: row.attestation_count },
  };
}

/**
 * Split one table's rows into the two stranded classes.
 *
 * `sourceGone` — no upstream record carries this id. `endpointStranded` — upstream still
 * claims it, but something it points at is stranded, so the row renders a link to a page
 * that should not exist.
 *
 * Identical logic for both tables; only the entry builder and the column names differ.
 * That is deliberate — the reason the pairs table went unaudited for so long is that
 * nobody wrote the second copy, so there is exactly one copy here.
 */
export function classifyRows({
  rows,
  entryFor,
  claimedIds,
  strandedProductIds,
  strandedVendorIds,
  endpointsOf,
  deps,
}) {
  const sourceGone = [];
  const endpointStranded = [];
  for (const row of rows) {
    if (!claimedIds.has(row.id)) {
      sourceGone.push(entryFor(row, 'no upstream record carries this id', deps));
      continue;
    }
    const broken = [];
    const { a, b, connector, builtBy, connectorLabel } = endpointsOf(row);
    if (strandedProductIds.has(a)) broken.push('source product stranded');
    if (strandedProductIds.has(b)) broken.push('target product stranded');
    if (connector && strandedProductIds.has(connector)) broken.push(`${connectorLabel} stranded`);
    if (builtBy && strandedVendorIds.has(builtBy)) broken.push('built_by vendor stranded');
    if (broken.length > 0) endpointStranded.push(entryFor(row, broken.join('; '), deps));
  }
  return { sourceGone, endpointStranded };
}

/** Column mapping for `integrations`, passed to {@link classifyRows}. */
export const integrationEndpoints = (row) => ({
  a: row.source_product_id,
  b: row.target_product_id,
  connector: row.powered_by_product_id,
  builtBy: row.built_by_vendor_id,
  connectorLabel: 'powered_by product',
});

/** Column mapping for `connector_evidenced_pairs`, passed to {@link classifyRows}. */
export const evidencedPairEndpoints = (row) => ({
  a: row.product_a_id,
  b: row.product_b_id,
  connector: row.connector_product_id,
  builtBy: row.built_by_vendor_id,
  connectorLabel: 'connector product',
});

/**
 * Annotate each finding with the row on the OTHER table covering the same product pair.
 *
 * This is AECI-888's stated signature — "one product pair holding a row in each table with
 * only one of them referenced upstream" — and it is already DETECTED by the source-gone
 * classes above: the unreferenced twin *is* the source-gone row. So this adds no new
 * detection and gets no bucket of its own. What it adds is the thing an operator needs
 * next, which is which row survived and where it lives.
 *
 * A twin is NOT by itself a defect. Under the Addendum C model a product pair can
 * legitimately carry both a delivered edge and a connector-delivered one, and AECI-798's
 * 2026-09-07 sweep found two such pairs in production that were deliberately left alone
 * (`autodesk-construction-cloud ↔ cmic` and `procore-project-management ↔ deltek-computerease`,
 * both still live). Only "both tables, one unreferenced" is the strand shape, which is why
 * this decorates findings rather than producing them.
 *
 * The pair key is ORDER-INSENSITIVE. `integrations` stores source/target as authored,
 * `connector_evidenced_pairs` canonicalises to `a < b`, so a same-pair twin will usually
 * disagree on orientation. Comparing them as authored finds nothing and reports a clean
 * sweep — the failure mode `scripts/ops/**` has hit before.
 */
export function attachTwins({ findings, integrationRows, pairRows }) {
  const key = (x, y) => [x, y].sort().join('|');
  const byPair = new Map();
  const add = (k, v) => {
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(v);
  };
  for (const r of integrationRows) {
    add(key(r.source_product_id, r.target_product_id), { id: r.id, table: 'integrations' });
  }
  for (const r of pairRows) {
    add(key(r.product_a_id, r.product_b_id), { id: r.id, table: 'connector_evidenced_pairs' });
  }
  for (const f of findings) {
    const siblings = byPair.get(key(f.sourceProductId, f.targetProductId)) ?? [];
    const twin = siblings.find((s) => s.id !== f.id && s.table !== f.table);
    if (twin) f.twin = twin;
  }
  return findings;
}
