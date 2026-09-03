import { describe, expect, it } from 'vitest';

import { isConnectorPoweredEdge } from './connector-powered';

/**
 * The union is the whole point of AECI-705, so the truth table is the spec.
 *
 * `mechanism_kind` describes the EDGE and `powered_by_product_id` links to a
 * PRODUCT, and nothing in the schema cross-validates them — which is why either
 * half alone selects the wrong set (53 production edges are `iPaaS` with a NULL
 * FK, 18 carry the FK while typed something else). Each row below is one of
 * those real populations, not a hypothetical.
 */
describe('isConnectorPoweredEdge', () => {
  it('is true when the FK names a connector, whatever the edge is typed', () => {
    // The 18 production edges typed `marketplace-app` (17) or `partner` (1)
    // whose `powered_by_product_id` resolves to a connector- or hybrid-role
    // product. An iPaaS-only predicate would miss every one.
    expect(
      isConnectorPoweredEdge({ poweredByProductId: 'p-agave', mechanismKind: 'marketplace-app' }),
    ).toBe(true);
    expect(
      isConnectorPoweredEdge({ poweredByProductId: 'p-agave', mechanismKind: 'partner' }),
    ).toBe(true);
    expect(isConnectorPoweredEdge({ poweredByProductId: 'p-agave', mechanismKind: null })).toBe(
      true,
    );
  });

  it('is true for an iPaaS edge whose connector is not a promoted product', () => {
    // The 53 production edges naming Zapier / Workato / n8n / Make / Boomi in
    // free text. Their FK is NULL because promote only sends `poweredByProduct`
    // once the connector is itself promoted, and AECI-706 puts the backfillable
    // count at 0 — so an FK-only predicate would keep prompting on these
    // indefinitely, not just until someone runs a script.
    expect(isConnectorPoweredEdge({ poweredByProductId: null, mechanismKind: 'iPaaS' })).toBe(true);
  });

  it('is true when both signals agree', () => {
    expect(isConnectorPoweredEdge({ poweredByProductId: 'p-agave', mechanismKind: 'iPaaS' })).toBe(
      true,
    );
  });

  it('is true for an `integrator` edge, which carries no FK by definition (AECI-721)', () => {
    // AECI-698 defines `integrator` as "an SI/consultancy built and maintains it,
    // NEITHER VENDOR DID" — this predicate's question, word for word. Such an edge
    // has no `powered_by` (there is no connector platform to name), so without the
    // kind disjunct it falls through both halves.
    //
    // Zero rows carry it today: the app-DB CHECK still refuses `integrator`, which
    // is why AECI-721 PR-A adds it to the enums and to the gate together. The
    // regression this guards is the ~117 `partner` rows the review app re-keys next:
    // the day they promote, an unguarded gate starts asking Procore to confirm work
    // an integrator did.
    expect(isConnectorPoweredEdge({ poweredByProductId: null, mechanismKind: 'integrator' })).toBe(
      true,
    );
  });

  it('is false for a direct edge, including an untyped one', () => {
    for (const mechanismKind of ['native', 'marketplace-app', 'api', 'webhook', 'partner', null]) {
      expect(isConnectorPoweredEdge({ poweredByProductId: null, mechanismKind })).toBe(false);
    }
  });

  it('does NOT treat `partner` as connector delivery', () => {
    // Pinned separately from the loop above because it is the one exclusion that
    // looks like an oversight and is not. `partner` is the dumping ground AECI-698
    // exists to empty — a sample of six held an app-center listing, a Procore
    // support tutorial and a partnerpage.io directory entry — so suppressing
    // attestation on it would silence 55 production edges an endpoint vendor may
    // well have built. They earn `integrator` one at a time, upstream, under the
    // rubric; they do not inherit it by proximity.
    expect(isConnectorPoweredEdge({ poweredByProductId: null, mechanismKind: 'partner' })).toBe(
      false,
    );
  });

  it('treats a null mechanism_kind as not connector delivery', () => {
    // `integrations.mechanism_kind` is nullable and its CHECK constrains only
    // non-null values (15 production rows are NULL). Absent evidence is not
    // evidence of a connector; the FK is what speaks for those rows.
    expect(isConnectorPoweredEdge({ poweredByProductId: null, mechanismKind: null })).toBe(false);
  });
});
