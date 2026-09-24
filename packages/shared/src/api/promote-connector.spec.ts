import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_AUTO_DECIDER,
  CONNECTOR_PAGE_MAX_ROWS,
  PromoteConnectorPagePayloadSchema,
} from './promote-connector';

const CATALOG = {
  id: 'rec76C362381D6CDF',
  connectorProductId: '11111111-1111-4111-8111-111111111111',
};
const STAMPS = { firstSeenAt: '2026-08-27T06:10:37.867Z', lastSeenAt: '2026-08-27T06:11:54.977Z' };

function stub(id: string, slug: string) {
  return { id, slug, ...STAMPS };
}

function page(overrides: Record<string, unknown> = {}) {
  return {
    catalog: CATALOG,
    page: { index: 0, of: 1 },
    stubs: [stub('recStub0000000001', 'adp')],
    ...overrides,
  };
}

describe('PromoteConnectorPagePayloadSchema (AECI-714)', () => {
  it('accepts a minimal page and defaults the optional arrays', () => {
    const parsed = PromoteConnectorPagePayloadSchema.parse(page());
    expect(parsed.surfaces).toEqual([]);
    expect(parsed.mappings).toEqual([]);
    expect(parsed.pairs).toEqual([]);
  });

  it('STRIPS managedBy — the flag is AECi-owned and not settable from the wire (AECI-720)', () => {
    // Not a rejection: Zod drops unknown keys, so a sender that still includes the field
    // is ignored rather than 400'd. What must never happen is the value reaching the
    // catalogue upsert, because a re-sync would then flip a vendor-managed catalogue back
    // to `review` — which is what this schema did until AECI-720.
    const parsed = PromoteConnectorPagePayloadSchema.parse(
      page({ catalog: { ...CATALOG, managedBy: 'vendor' } }),
    );
    expect(parsed.catalog).not.toHaveProperty('managedBy');
  });

  it('accepts a catalogue whose connector product is not promoted', () => {
    // The whole page is skipped at ingest, NOT rejected here: the review app is right
    // to keep ingesting a catalogue whose platform AECi has not promoted. Zapier's was
    // that case until AECI-1064 promoted it on 2026-09-23 (reversing AECI-700).
    const parsed = PromoteConnectorPagePayloadSchema.parse(page({ catalog: { id: CATALOG.id } }));
    expect(parsed.catalog.connectorProductId).toBeUndefined();
  });

  it('rejects a page carrying nothing but a catalogue header', () => {
    const result = PromoteConnectorPagePayloadSchema.safeParse(page({ stubs: [] }));
    expect(result.success).toBe(false);
  });

  it('rejects a page over the row ceiling', () => {
    const stubs = Array.from({ length: CONNECTOR_PAGE_MAX_ROWS + 1 }, (_, i) =>
      stub(`recStub${String(i).padStart(11, '0')}`, `app-${i}`),
    );
    const result = PromoteConnectorPagePayloadSchema.safeParse(page({ stubs }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('ceiling');
  });

  it('rejects a duplicate id within one page — the last write would silently win', () => {
    const result = PromoteConnectorPagePayloadSchema.safeParse(
      page({ stubs: [stub('recDup00000000001', 'a'), stub('recDup00000000001', 'b')] }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('Duplicate id');
  });

  it('rejects a non-canonical pair rather than letting the CHECK roll the page back', () => {
    const result = PromoteConnectorPagePayloadSchema.safeParse(
      page({
        stubs: [stub('recA0000000000001', 'a'), stub('recB0000000000001', 'b')],
        pairs: [
          {
            id: 'recPair000000001',
            stubAId: 'recB0000000000001',
            stubBId: 'recA0000000000001',
            ...STAMPS,
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('canonically ordered');
  });

  it('keeps the two mapping status families apart', () => {
    const productId = '22222222-2222-4222-8222-222222222222';
    // `mapped` NAMES a product…
    expect(
      PromoteConnectorPagePayloadSchema.safeParse(
        page({
          mappings: [
            {
              id: 'recMap0000000001',
              stubId: 'recStub0000000001',
              productId,
              status: 'mapped',
              decidedBy: 'chris',
            },
          ],
        }),
      ).success,
    ).toBe(true);

    // …a stub-level decision asserts there is none to name. One carrying a product
    // would collide on the partial unique index and fail the whole page at commit.
    const crossed = PromoteConnectorPagePayloadSchema.safeParse(
      page({
        mappings: [
          { id: 'recMap0000000002', stubId: 'recStub0000000001', productId, status: 'no_record' },
        ],
      }),
    );
    expect(crossed.success).toBe(false);
    expect(crossed.error?.issues[0]?.message).toContain('may not name a product');
  });

  it('allows several mapped products on one stub but only one stub-level decision', () => {
    const base = { stubId: 'recStub0000000001', decidedBy: 'chris' };
    expect(
      PromoteConnectorPagePayloadSchema.safeParse(
        page({
          mappings: [
            {
              ...base,
              id: 'recM1',
              productId: '33333333-3333-4333-8333-333333333333',
              status: 'mapped',
            },
            {
              ...base,
              id: 'recM2',
              productId: '44444444-4444-4444-8444-444444444444',
              status: 'mapped',
            },
          ],
        }),
      ).success,
    ).toBe(true);

    const twoDecisions = PromoteConnectorPagePayloadSchema.safeParse(
      page({
        mappings: [
          { id: 'recM3', stubId: 'recStub0000000001', status: 'no_record' },
          { id: 'recM4', stubId: 'recStub0000000001', status: 'out_of_scope' },
        ],
      }),
    );
    expect(twoDecisions.success).toBe(false);
    expect(twoDecisions.error?.issues[0]?.message).toContain('more than one stub-level decision');
  });

  it('rejects an out-of-vocabulary status, confidence or pair surface', () => {
    for (const mappings of [
      [{ id: 'recM5', stubId: 'recStub0000000001', status: 'pending' }],
      [
        {
          id: 'recM6',
          stubId: 'recStub0000000001',
          status: 'mapped',
          productId: '55555555-5555-4555-8555-555555555555',
          confidence: 'certain',
        },
      ],
    ]) {
      expect(PromoteConnectorPagePayloadSchema.safeParse(page({ mappings })).success).toBe(false);
    }
  });

  it('accepts `derived`, the fourth pair surface, and still rejects one outside it', () => {
    // AECI-906. `derived` means the vendor published NO page for this pair and we
    // enumerated it from their closed connector list, so it is not `unknown` ("a page
    // exists, nobody read it"). 669 upstream rows carry it.
    //
    // This enum and the `connector_pairs_surface_check` D1 CHECK are one vocabulary in
    // two spellings. A value this schema admits and the CHECK does not rolls back the
    // WHOLE page at commit, because the connector arm commits a page in one `db.batch`.
    const stubs = [stub('recA0000000000001', 'a'), stub('recB0000000000001', 'b')];
    const pair = (surface: string) => ({
      id: 'recPair000000001',
      stubAId: 'recA0000000000001',
      stubBId: 'recB0000000000001',
      surface,
      ...STAMPS,
    });

    const derived = PromoteConnectorPagePayloadSchema.parse(
      page({ stubs, pairs: [pair('derived')] }),
    );
    expect(derived.pairs[0]?.surface).toBe('derived');

    expect(
      PromoteConnectorPagePayloadSchema.safeParse(page({ stubs, pairs: [pair('inferred')] }))
        .success,
    ).toBe(false);
  });

  it('leaves scraper vocabulary loose, in lockstep with the absent DB CHECKs', () => {
    // `surfaceRole` / `indexKind` / `directionRole` are unconstrained on BOTH sides.
    // If this test starts failing, the two halves have drifted and a value the
    // contract admits will roll a page back at commit time.
    const parsed = PromoteConnectorPagePayloadSchema.parse(
      page({
        surfaces: [
          { id: 'recSurface000001', surfaceRole: 'partner-directory', indexKind: 'graphql' },
        ],
        stubs: [{ ...stub('recStub0000000001', 'adp'), directionRole: 'inbound' }],
      }),
    );
    expect(parsed.surfaces[0]?.surfaceRole).toBe('partner-directory');
  });

  it('rejects a page index outside its own page count', () => {
    expect(
      PromoteConnectorPagePayloadSchema.safeParse(page({ page: { index: 3, of: 3 } })).success,
    ).toBe(false);
  });

  it('pins the publication gate string so the read path cannot re-spell it', () => {
    expect(CONNECTOR_AUTO_DECIDER).toBe('auto-name-match');
  });
});

describe('reach-tier claims on the connector page (AECI-891)', () => {
  const PAIR_ID = 'recPair000000001';
  const claim = (overrides: Record<string, unknown> = {}) => ({
    id: 'recClaim00000001',
    connectorPairId: PAIR_ID,
    dataObject: 'RFIs',
    direction: 'a_to_b',
    ...overrides,
  });

  it('accepts a claim and defaults its attestations', () => {
    const parsed = PromoteConnectorPagePayloadSchema.parse(page({ claims: [claim()] }));
    expect(parsed.claims[0]).toMatchObject({ connectorPairId: PAIR_ID, direction: 'a_to_b' });
    expect(parsed.claims[0]?.attestations).toEqual([]);
  });

  it('accepts a claims-only page, because a claim may reference a stored pair', () => {
    // The pair may have ridden an earlier page. Rejecting this would force an ordering
    // the protocol does not define, and §3a is explicit that a dangling reference is
    // reported at ingest rather than refused at the wire.
    const parsed = PromoteConnectorPagePayloadSchema.parse(page({ stubs: [], claims: [claim()] }));
    expect(parsed.claims).toHaveLength(1);
  });

  it('shares the claim direction vocabulary with the product arm', () => {
    // One `claims_direction_check` CHECK covers both arms, so a value this schema admits
    // and that CHECK does not would roll the WHOLE page back at commit.
    for (const direction of ['a_to_b', 'b_to_a', 'both']) {
      expect(
        PromoteConnectorPagePayloadSchema.safeParse(page({ claims: [claim({ direction })] }))
          .success,
      ).toBe(true);
    }
    expect(
      PromoteConnectorPagePayloadSchema.safeParse(
        page({ claims: [claim({ direction: 'inbound' })] }),
      ).success,
    ).toBe(false);
  });

  it('rejects a duplicate claim record id within one page', () => {
    const result = PromoteConnectorPagePayloadSchema.safeParse(
      page({ claims: [claim(), claim({ dataObject: 'Submittals' })] }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('Duplicate id');
  });

  it('counts claims AND their nested attestations toward the page ceiling', () => {
    // The ceiling bounds STATEMENTS in one `db.batch`, and a claim emits one for itself
    // plus one for its attestation. Counting only the parents would let 500 claims become
    // 1,000 statements against a ceiling that reads 500.
    const attested = (i: number) => ({
      ...claim({ id: `recClaim${String(i).padStart(8, '0')}` }),
      attestations: [{ source: 'aeci', asserted: true }],
    });
    const half = CONNECTOR_PAGE_MAX_ROWS / 2;
    const claims = Array.from({ length: half }, (_, i) => attested(i));

    // `half` claims + `half` attestations = exactly the ceiling, with no stubs.
    expect(PromoteConnectorPagePayloadSchema.safeParse(page({ stubs: [], claims })).success).toBe(
      true,
    );
    const over = PromoteConnectorPagePayloadSchema.safeParse(
      page({ stubs: [], claims: [...claims, attested(half)] }),
    );
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.message).toContain('ceiling');
  });

  it('accepts an explicit claim deletion, and still rejects a page carrying nothing', () => {
    // `deleted.claims` is how a claim LEAVES. This arm never replaces by absence — a
    // claim missing from a page is a claim on a different page — so without the explicit
    // list a retracted claim would live forever.
    const parsed = PromoteConnectorPagePayloadSchema.parse(
      page({ stubs: [], deleted: { surfaces: [], mappings: [], claims: ['recClaim00000001'] } }),
    );
    expect(parsed.deleted?.claims).toEqual(['recClaim00000001']);

    const empty = PromoteConnectorPagePayloadSchema.safeParse(
      page({ stubs: [], deleted: { surfaces: [], mappings: [], claims: [] } }),
    );
    expect(empty.success).toBe(false);
    expect(empty.error?.issues[0]?.message).toContain('claims');
  });
});
