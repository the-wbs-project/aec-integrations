import { describe, expect, it } from 'vitest';

import type { RefinementItem } from '../shared/facets/refinement-item';

import { PHASE_LIFECYCLE_ORDER, orderFacetItems } from './search-facet-order';

function item(value: string, count = 0): RefinementItem {
  return { value, label: value, count, isRefined: false };
}

describe('orderFacetItems', () => {
  it('orders phases by project lifecycle, ignoring count', () => {
    // Count-shuffled input — lifecycle order must win.
    const input = [
      item('Closeout & Operations', 99),
      item('Concept & Planning', 1),
      item('Construction', 50),
      item('Design', 2),
      item('Pre-Construction', 3),
    ];
    expect(orderFacetItems('phases', input).map((i) => i.value)).toEqual([
      ...PHASE_LIFECYCLE_ORDER,
    ]);
  });

  it('sorts unknown phase names to the end', () => {
    const input = [item('Mystery Phase'), item('Design'), item('Concept & Planning')];
    expect(orderFacetItems('phases', input).map((i) => i.value)).toEqual([
      'Concept & Planning',
      'Design',
      'Mystery Phase',
    ]);
  });

  it('passes non-phase attributes through unchanged (copy, not in place)', () => {
    const input = [item('b'), item('a')];
    const out = orderFacetItems('categories', input);
    expect(out.map((i) => i.value)).toEqual(['b', 'a']);
    expect(out).not.toBe(input);
  });

  it('passes trades through on the connector default, count-desc (AECI-545)', () => {
    // Deliberate: the trade vocabulary's display_order is alphabetical, which
    // carries no meaning, and with 34 terms under REFINEMENT_LIST_LIMIT an
    // alphabetical sort would truncate the list around "E" and hide Roofing,
    // Plumbing, Steel… Count order is the useful one. This pins that decision
    // against a future "helpful" alphabetical sort.
    const input = [item('Roofing', 9), item('Concrete', 4)];
    const out = orderFacetItems('trades', input);
    expect(out.map((i) => i.value)).toEqual(['Roofing', 'Concrete']);
    expect(out).not.toBe(input);
  });

  it('does not mutate the phases input', () => {
    const input = [item('Design'), item('Concept & Planning')];
    orderFacetItems('phases', input);
    expect(input.map((i) => i.value)).toEqual(['Design', 'Concept & Planning']);
  });
});
