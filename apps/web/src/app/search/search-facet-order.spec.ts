import { describe, expect, it } from 'vitest';

import type { RefinementItem } from '../shared/facets/refinement-item';

import {
  compareFacetValues,
  PHASE_LIFECYCLE_ORDER,
  orderFacetItems,
  withCheckedValues,
} from './search-facet-order';

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

  // AECI-1662 — the /products order, not the counts. A value outside the
  // vocabulary can only come from a hand-edited URL, and is dropped.
  it('orders connector_kind in vocabulary order and drops an unknown value', () => {
    const input = [item('sync_service', 9), item('junk', 3), item('integration_platform', 1)];
    const out = orderFacetItems('connector_kind', input);
    expect(out.map((i) => i.value)).toEqual(['integration_platform', 'sync_service']);
    expect(input.map((i) => i.value)).toEqual(['sync_service', 'junk', 'integration_platform']);
  });

  it('does not mutate the phases input', () => {
    const input = [item('Design'), item('Concept & Planning')];
    orderFacetItems('phases', input);
    expect(input.map((i) => i.value)).toEqual(['Design', 'Concept & Planning']);
  });
});

describe('compareFacetValues', () => {
  const v = (name: string, count: number, isRefined = false) => ({ name, count, isRefined });

  it('puts checked values first, then count descending, then name A to Z', () => {
    const input = [v('Oracle', 5), v('SAP', 2), v('Zeta', 1, true), v('Procore Technologies', 8)];
    expect([...input].sort(compareFacetValues).map((x) => x.name)).toEqual([
      'Zeta',
      'Procore Technologies',
      'Oracle',
      'SAP',
    ]);
  });

  it('never lets case decide a tie (AECI-825)', () => {
    // Code-unit order would be SRS Distribution, Spotable, airSlate.
    const input = [v('SRS Distribution', 1), v('Spotable', 1), v('airSlate', 1)];
    expect([...input].sort(compareFacetValues).map((x) => x.name)).toEqual([
      'airSlate',
      'Spotable',
      'SRS Distribution',
    ]);
  });
});

describe('withCheckedValues (AECI-1899)', () => {
  const checked = (value: string, count = 0): RefinementItem => ({
    value,
    label: value,
    count,
    isRefined: true,
  });

  it('adds a checked value the response left out, checked at 0', () => {
    expect(withCheckedValues([], ['Roofing'])).toEqual([checked('Roofing')]);
  });

  it('returns the same list when nothing is missing', () => {
    const items = [checked('AI', 3), item('Scheduling', 9)];
    expect(withCheckedValues(items, ['AI'])).toBe(items);
    expect(withCheckedValues([], [])).toEqual([]);
  });

  it('places an added value after checked values with matches, before unchecked ones', () => {
    const out = withCheckedValues(
      [checked('AI', 3), item('Scheduling', 9)],
      ['AI', 'zeta', 'Beta'],
    );
    expect(out.map((i) => i.value)).toEqual(['AI', 'Beta', 'zeta', 'Scheduling']);
  });
});
