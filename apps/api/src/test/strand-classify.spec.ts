/**
 * The strand audit's classification, over BOTH anchor tables (AECI-897 / AECI-888).
 *
 * ─── WHY THIS FILE IS HERE AND NOT NEXT TO THE SCRIPT ────────────────────────
 *
 * `scripts/ops/**` has no test harness anywhere in the repo — no vitest include, no
 * package script — and the lane README says so explicitly. The audit is read-only, so
 * ADR 0030's credential-boundary objection to moving ops code into `apps/api` does not
 * apply to its *classification*: `classify.mjs` is a pure function of its arguments and
 * touches no network, no wrangler and no clock. The unit lane already runs
 * `environment: 'node'`, so importing it by relative path needs no config change.
 *
 * ─── WHAT "REPLAY THE 2026-09-10 DATA" CAN AND CANNOT MEAN ───────────────────
 *
 * The real 215-row upstream snapshot is gitignored production catalog content and is not
 * checked in. So the fixture below is a handful of rows in that state's SHAPE, not those
 * 215 ids. The assertion is that the shape goes red. That is the whole regression: on
 * 2026-09-10 and 2026-09-11 this shape reported GREEN because one of the two tables was
 * never classified.
 */

import { describe, expect, it } from 'vitest';

import {
  attachTwins,
  classifyRows,
  comparandLooksBroken,
  COMPARAND_FLOOR,
  evidencedPairEndpoints,
  evidencedPairEntry,
  integrationEndpoints,
  integrationEntry,
  // @ts-expect-error — plain-ESM ops module, deliberately untyped; see the header.
} from '../../../../scripts/ops/2026-09-stranded-row-audit/classify.mjs';

// ─── fixtures ────────────────────────────────────────────────────────────────

const PRODUCTS = new Map([
  ['p-heavyjob', { slug: 'heavyjob', promotion_status: 'promoted' }],
  ['p-sage300', { slug: 'sage-300-cre', promotion_status: 'promoted' }],
  ['p-procore', { slug: 'procore', promotion_status: 'promoted' }],
  ['p-agave', { slug: 'agave-erp-sync', promotion_status: 'promoted' }],
  ['p-dead', { slug: 'dead-product', promotion_status: 'promoted' }],
]);

const deps = {
  slugOf: (id: string) => PRODUCTS.get(id)?.slug ?? null,
  promotedOf: (id: string) => PRODUCTS.get(id)?.promotion_status === 'promoted',
};

const NO_STRANDED = { strandedProductIds: new Set<string>(), strandedVendorIds: new Set<string>() };

function pair(id: string, a: string, b: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `${a} ↔ ${b}`,
    mechanism_name: 'Agave connector',
    product_a_id: a,
    product_b_id: b,
    connector_product_id: 'p-agave',
    built_by_vendor_id: null,
    claim_count: 0,
    attestation_count: 0,
    ...extra,
  };
}

function integration(id: string, a: string, b: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: `${a} → ${b}`,
    mechanism_kind: 'native',
    source_product_id: a,
    target_product_id: b,
    built_by_vendor_id: null,
    powered_by_product_id: null,
    claim_count: 0,
    attestation_count: 0,
    ...extra,
  };
}

const classifyPairs = (rows: unknown[], claimedIds: Set<string>, stranded = NO_STRANDED) =>
  classifyRows({
    rows,
    entryFor: evidencedPairEntry,
    claimedIds,
    ...stranded,
    endpointsOf: evidencedPairEndpoints,
    deps,
  });

const classifyIntegrations = (rows: unknown[], claimedIds: Set<string>, stranded = NO_STRANDED) =>
  classifyRows({
    rows,
    entryFor: integrationEntry,
    claimedIds,
    ...stranded,
    endpointsOf: integrationEndpoints,
    deps,
  });

// ─── the regression ──────────────────────────────────────────────────────────

describe('strand audit — connector_evidenced_pairs is classified (AECI-897)', () => {
  it('goes RED on the 2026-09-10 shape: rows live in D1, deleted upstream', () => {
    // The state on 2026-09-10. Rows are live and public; upstream claims none of them,
    // because the curator deleted the records. The sweep reported clean for two days.
    const rows = [
      pair('e1', 'p-heavyjob', 'p-sage300'),
      pair('e2', 'p-heavyjob', 'p-procore'),
      pair('e3', 'p-procore', 'p-sage300'),
    ];
    const claimed = new Set<string>();

    const { sourceGone, endpointStranded } = classifyPairs(rows, claimed);

    expect(sourceGone).toHaveLength(3);
    expect(endpointStranded).toHaveLength(0);
    expect(sourceGone.map((e: { id: string }) => e.id)).toEqual(['e1', 'e2', 'e3']);
    // `table` is on every entry. Without it the `--ids-out` file mixes two tables with
    // two different repairs under ids that look identical.
    expect(
      sourceGone.every((e: { table: string }) => e.table === 'connector_evidenced_pairs'),
    ).toBe(true);
  });

  it('reports the connector page among the URLs a pair retraction touches', () => {
    // Four URLs for a pair, not three: §12.5 option B counts the edge for the connector
    // too, so its own hub renders it and goes stale with the rest.
    const [entry] = classifyPairs([pair('e1', 'p-heavyjob', 'p-sage300')], new Set()).sourceGone;
    expect(entry.url).toBe('/products/heavyjob/integrations/sage-300-cre');
    expect(entry.alsoRenderedOn).toEqual([
      '/products/heavyjob',
      '/products/sage-300-cre',
      '/products/agave-erp-sync',
    ]);
  });

  it('carries the real cascade cost, which the single-column claim read reported as zero', () => {
    const rows = [pair('e1', 'p-heavyjob', 'p-sage300', { claim_count: 7, attestation_count: 11 })];
    const [entry] = classifyPairs(rows, new Set()).sourceGone;
    expect(entry.cascade).toEqual({ claims: 7, attestations: 11 });
  });

  it('stays green when upstream still claims every row', () => {
    const rows = [pair('e1', 'p-heavyjob', 'p-sage300'), pair('e2', 'p-heavyjob', 'p-procore')];
    const { sourceGone, endpointStranded } = classifyPairs(rows, new Set(['e1', 'e2']));
    expect(sourceGone).toEqual([]);
    expect(endpointStranded).toEqual([]);
  });

  it('flags a claimed pair whose connector product is itself stranded', () => {
    const rows = [pair('e1', 'p-heavyjob', 'p-sage300')];
    const { sourceGone, endpointStranded } = classifyPairs(rows, new Set(['e1']), {
      strandedProductIds: new Set(['p-agave']),
      strandedVendorIds: new Set<string>(),
    });
    expect(sourceGone).toEqual([]);
    expect(endpointStranded).toHaveLength(1);
    expect(endpointStranded[0].reason).toBe('connector product stranded');
  });
});

// ─── AECI-888's stated signature ─────────────────────────────────────────────

describe('cross-table twins (AECI-888)', () => {
  it('flags one product pair holding a row in each table with only one claimed', () => {
    // The AECI-798 shape exactly: the curator cleared `powered_by`, the promote inserted
    // a fresh `integrations` row and repointed its id at it, and the old pair row became
    // addressable by nothing. Both rows are live; upstream claims only the new one.
    const integrationRows = [integration('i1', 'p-heavyjob', 'p-sage300')];
    const pairRows = [pair('e1', 'p-sage300', 'p-heavyjob')];

    const claimed = new Set(['i1']);
    const intg = classifyIntegrations(integrationRows, claimed);
    const pairs = classifyPairs(pairRows, claimed);

    // Exactly one finding, and it is the unreferenced half.
    expect(intg.sourceGone).toEqual([]);
    expect(pairs.sourceGone).toHaveLength(1);
    expect(pairs.sourceGone[0].id).toBe('e1');

    attachTwins({
      findings: [...intg.sourceGone, ...pairs.sourceGone],
      integrationRows,
      pairRows,
    });
    // The surviving row is named, so the operator does not have to go find it. Note the
    // fixture stores the endpoints in OPPOSITE order across the two tables — which is
    // normal, since `connector_evidenced_pairs` canonicalises to `a < b` and
    // `integrations` stores them as authored. An order-sensitive key finds no twin here
    // and reports a clean sweep.
    expect(pairs.sourceGone[0].twin).toEqual({ id: 'i1', table: 'integrations' });
  });

  it('does NOT treat a legitimate twin as a defect when both rows are claimed', () => {
    // Two production pairs look exactly like this and were deliberately left alone on
    // 2026-09-07: a product pair may carry both a delivered edge and a connector-delivered
    // one under the Addendum C model. "Both tables" is not the signature. "Both tables,
    // one unreferenced" is.
    const integrationRows = [integration('i1', 'p-procore', 'p-sage300')];
    const pairRows = [pair('e1', 'p-procore', 'p-sage300')];
    const claimed = new Set(['i1', 'e1']);

    const intg = classifyIntegrations(integrationRows, claimed);
    const pairs = classifyPairs(pairRows, claimed);
    expect([...intg.sourceGone, ...pairs.sourceGone]).toEqual([]);
  });
});

// ─── the comparand gate ──────────────────────────────────────────────────────

describe('comparand sanity gate (AECI-897)', () => {
  it('trips when a table above the floor comes back entirely unclaimed', () => {
    // If upstream stops projecting `supabaseId`, or excludes connector-powered edges from
    // `list_integrations`, every row goes unclaimed at once. That is the check breaking,
    // and reporting it as N findings would point an operator at a live catalogue.
    expect(comparandLooksBroken({ tableSize: 62, unclaimed: 62 })).toBe(true);
    expect(comparandLooksBroken({ tableSize: COMPARAND_FLOOR, unclaimed: COMPARAND_FLOOR })).toBe(
      true,
    );
  });

  it('does NOT trip below the floor, where all-unclaimed is a plausible finding', () => {
    // Three rows that are genuinely all stranded is a finding, not a broken join.
    expect(comparandLooksBroken({ tableSize: 3, unclaimed: 3 })).toBe(false);
    expect(
      comparandLooksBroken({ tableSize: COMPARAND_FLOOR - 1, unclaimed: COMPARAND_FLOOR - 1 }),
    ).toBe(false);
  });

  it('does NOT trip on the measured production shape', () => {
    // 60 of 62 claimed, measured 2026-09-14. The two unclaimed rows must reach the
    // operator as findings — suppressing them is the defect this whole change removes.
    expect(comparandLooksBroken({ tableSize: 62, unclaimed: 2 })).toBe(false);
  });

  it('does not trip on an empty table', () => {
    // Non-production environments have no connector data at all.
    expect(comparandLooksBroken({ tableSize: 0, unclaimed: 0 })).toBe(false);
  });
});
