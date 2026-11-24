/**
 * AECI-2046 — the "What it syncs" roll-up (`what-it-syncs.ts`, `STAGE_1_5_SPEC.md`
 * §13.13). The owner-removed flow is excluded before this helper runs; that half is
 * pinned over the real read in `routes/vendor-owner-flows.spec.ts`.
 */
import { describe, expect, it } from 'vitest';

import { rollUpWhatItSyncs, type WhatItSyncsFlow, type WhatItSyncsRow } from './what-it-syncs';

const SELF = 'p-sync';
const flow = (slug: string, direction: string, name = slug.toUpperCase()): WhatItSyncsFlow => ({
  slug,
  name,
  direction,
});
const row = (aId: string, bId: string, flows: WhatItSyncsFlow[]): WhatItSyncsRow => ({
  aId,
  bId,
  flows,
});

describe('rollUpWhatItSyncs', () => {
  it('counts each record type over the pairs that carry it, with partial coverage', () => {
    const out = rollUpWhatItSyncs(
      [
        row('p1', 'e1', [flow('budgets', 'both'), flow('invoices', 'a_to_b')]),
        row('p1', 'e2', [flow('budgets', 'both')]),
        row('p2', 'e1', [flow('budgets', 'both')]),
      ],
      SELF,
    );
    expect(out.pair_count).toBe(3);
    expect(out.pairs_with_flows).toBe(3);
    expect(out.objects).toEqual([
      { slug: 'budgets', name: 'BUDGETS', pair_count: 3, both_ways: 3, one_way: 0 },
      { slug: 'invoices', name: 'INVOICES', pair_count: 1, both_ways: 0, one_way: 1 },
    ]);
  });

  it('mixes directions: both ways where a pair says both or carries both one-way flows', () => {
    const out = rollUpWhatItSyncs(
      [
        row('p1', 'e1', [flow('costs', 'a_to_b'), flow('costs', 'b_to_a')]),
        row('p1', 'e2', [flow('costs', 'a_to_b')]),
        row('p2', 'e1', [flow('costs', 'b_to_a')]),
        row('p2', 'e2', [flow('costs', 'both')]),
      ],
      SELF,
    );
    expect(out.objects).toEqual([
      { slug: 'costs', name: 'COSTS', pair_count: 4, both_ways: 2, one_way: 2 },
    ]);
  });

  it('merges two rows of one pair stored in opposite frames', () => {
    // The same one-way flow, e1 to p1, framed once from each side: still one way.
    const sameWay = rollUpWhatItSyncs(
      [row('p1', 'e1', [flow('rfis', 'b_to_a')]), row('e1', 'p1', [flow('rfis', 'a_to_b')])],
      SELF,
    );
    expect(sameWay.pair_count).toBe(1);
    expect(sameWay.objects[0]).toMatchObject({ pair_count: 1, both_ways: 0, one_way: 1 });

    // Opposite one-way flows across the two rows: both ways.
    const opposite = rollUpWhatItSyncs(
      [row('p1', 'e1', [flow('rfis', 'a_to_b')]), row('e1', 'p1', [flow('rfis', 'a_to_b')])],
      SELF,
    );
    expect(opposite.objects[0]).toMatchObject({ pair_count: 1, both_ways: 1, one_way: 0 });
  });

  it('leaves out a row with the Sync Service itself as an endpoint', () => {
    const out = rollUpWhatItSyncs(
      [row(SELF, 'e1', [flow('rfis', 'both')]), row('p1', 'e1', [])],
      SELF,
    );
    expect(out).toEqual({ pair_count: 1, pairs_with_flows: 0, objects: [] });
  });

  it('reports pairs that list no record type, and is empty with no rows', () => {
    const out = rollUpWhatItSyncs(
      [row('p1', 'e1', [flow('rfis', 'both')]), row('p1', 'e2', [])],
      SELF,
    );
    expect(out.pair_count).toBe(2);
    expect(out.pairs_with_flows).toBe(1);
    expect(rollUpWhatItSyncs([], SELF)).toEqual({
      pair_count: 0,
      pairs_with_flows: 0,
      objects: [],
    });
  });

  it('orders A to Z by name whatever the case or the input order, slug on a tie', () => {
    const rows = [
      row('p1', 'e1', [
        flow('z-b', 'both', 'Timesheets'),
        flow('a-b', 'both', 'budgets'),
        flow('m-b', 'both', 'Budgets'),
        flow('c-b', 'both', 'Change Orders'),
      ]),
    ];
    const forward = rollUpWhatItSyncs(rows, SELF).objects.map((o) => o.slug);
    const reversed = rollUpWhatItSyncs(
      [row('p1', 'e1', [...rows[0]!.flows].reverse())],
      SELF,
    ).objects.map((o) => o.slug);
    expect(forward).toEqual(reversed);
    // `compareText`: a letter outranks case, and case only breaks a letter tie (lower
    // case first in the `en` collation). Never the stored order.
    expect(forward).toEqual(['a-b', 'm-b', 'c-b', 'z-b']);
  });
});
