import { describe, expect, it } from 'vitest';

import type { IntegrationTerm, ProductIntegrationItem, ProductLink } from '@aeci/shared';

import { splitIntegrationLanes } from './connector-lane-grouping';
import {
  GROUPED_LIST_MIN_ROWS,
  GROUP_PEEK_ROWS,
  GROUP_PEEK_ROWS_PHONE,
  GROUP_STACK_LOGOS,
  ONE_LIST_PAGE_SIZE,
  groupDomId,
  groupRowsByCategory,
  isLongIntegrationList,
  peekGroup,
  rowsInCategory,
  stackPartners,
} from './integration-category-groups';
import {
  NO_INTEGRATION_FILTER,
  countRowsWithDirection,
  filterIntegrationLanes,
  partnerCategoryOptions,
  rowsForFacetCount,
} from './integration-filter';

/**
 * AECI-1783: the grouping model behind the long integration list. Every fixture goes
 * through `splitIntegrationLanes` first, so the rows are the rows the page renders.
 */

const page: ProductLink = { id: 'p-procore', slug: 'procore', name: 'Procore', logo_url: null };
const link = (slug: string, name: string): ProductLink => ({
  id: `p-${slug}`,
  slug,
  name,
  logo_url: null,
});
const term = (slug: string, name: string): IntegrationTerm => ({ slug, name });

const ACCOUNTING = term('accounting-erp', 'Accounting and ERP');
const SCHEDULING = term('scheduling', 'Scheduling');
const BIM = term('bim-coordination', 'BIM coordination');
// Two categories that tie on name: the slug decides.
const FIELD_A = term('field-a', 'Field');
const FIELD_B = term('field-b', 'Field');

let seq = 0;
function edge(
  partner: ProductLink,
  categories: IntegrationTerm[],
  extra: Partial<ProductIntegrationItem> = {},
): ProductIntegrationItem {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    name: `Procore and ${partner.name}`,
    mechanism_kind: 'api',
    mechanism_name: null,
    direction: 'a_to_b',
    context_direction: 'outbound',
    source: page,
    target: partner,
    via: null,
    powered_by_product: null,
    data_object_slugs: [],
    data_objects: [],
    partner_categories: categories,
    agreement: null,
    caption: null,
    corrections: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

/** A view of `n` partners, inserted out of order, with categories cycling through the set. */
function longView(n: number) {
  seq = 0;
  const sets: IntegrationTerm[][] = [
    [SCHEDULING],
    [ACCOUNTING, BIM],
    [],
    [FIELD_B],
    [FIELD_A, SCHEDULING],
    [ACCOUNTING],
  ];
  const rows: ProductIntegrationItem[] = [];
  for (let i = 0; i < n; i++) {
    const k = (i * 7) % n;
    rows.push(
      edge(link(`partner-${k}`, `Partner ${String(k).padStart(2, '0')}`), sets[k % sets.length]!, {
        context_direction: (['outbound', 'inbound', 'both'] as const)[k % 3]!,
      }),
    );
  }
  return splitIntegrationLanes(rows, []);
}

describe('isLongIntegrationList', () => {
  it('groups from 13 rows: one more than a page of the one-list mode', () => {
    expect(GROUPED_LIST_MIN_ROWS).toBe(ONE_LIST_PAGE_SIZE + 1);
    expect(isLongIntegrationList(longView(1))).toBe(false);
    expect(isLongIntegrationList(longView(12))).toBe(false);
    expect(isLongIntegrationList(longView(13))).toBe(true);
    expect(isLongIntegrationList(longView(58))).toBe(true);
  });

  it('groups only with fewer groups than half the rows (ruled 2026-11-16)', () => {
    seq = 0;
    // Each row in a category of its own: categories cycle through `k` names.
    const spread = (rows: number, k: number) =>
      splitIntegrationLanes(
        Array.from({ length: rows }, (_, i) =>
          edge(link(`s-${i}`, `S ${String(i).padStart(2, '0')}`), [
            term(`cat-${i % k}`, `Cat ${i % k}`),
          ]),
        ),
        [],
      );
    // 13 rows in 13 one-card groups: a flat list.
    expect(isLongIntegrationList(spread(13, 13))).toBe(false);
    // 7 groups: 14 rows is not more than twice that, 15 is.
    expect(isLongIntegrationList(spread(14, 7))).toBe(false);
    expect(isLongIntegrationList(spread(15, 7))).toBe(true);
    // The uncategorised group counts as a group.
    const withNone = splitIntegrationLanes(
      [
        ...Array.from({ length: 13 }, (_, i) => edge(link(`n-${i}`, `N ${i}`), [])),
        edge(link('one', 'One'), [SCHEDULING]),
      ],
      [],
    );
    expect(isLongIntegrationList(withNone)).toBe(true);
  });

  it('never groups a page with a Via lane, whatever its length', () => {
    seq = 0;
    const rows = Array.from({ length: 20 }, (_, i) => edge(link(`p-${i}`, `P ${i}`), [SCHEDULING]));
    rows.push(
      edge(link('xero', 'Xero'), [], { via: link('agave', 'Agave'), mechanism_kind: null }),
    );
    expect(isLongIntegrationList(splitIntegrationLanes(rows, []))).toBe(false);
  });
});

describe('groupRowsByCategory', () => {
  const view = longView(58);
  const groups = groupRowsByCategory(view.direct);

  it('orders groups A to Z by category name, slug breaking a tie, uncategorised last', () => {
    expect(groups.map((g) => g.key)).toEqual([
      'accounting-erp',
      'bim-coordination',
      'field-a',
      'field-b',
      'scheduling',
      '',
    ]);
    expect(groups.at(-1)!.category).toBeNull();
    // The same order as the category chips.
    expect(groups.slice(0, -1).map((g) => g.key)).toEqual(
      partnerCategoryOptions(view).map((t) => t.slug),
    );
  });

  it('files a row under every category it carries, and keeps the lane order inside a group', () => {
    const laneOrder = view.direct.map((r) => r.key);
    for (const group of groups) {
      const keys = group.rows.map((r) => r.key);
      expect(
        laneOrder.filter((k) => keys.includes(k)),
        group.key,
      ).toEqual(keys);
    }
    const twoCategories = view.direct.find((r) => r.integration.partner_categories.length === 2)!;
    const holding = groups.filter((g) => g.rows.includes(twoCategories)).map((g) => g.key);
    expect(holding).toHaveLength(2);
    // Every row is in at least one group.
    const grouped = new Set(groups.flatMap((g) => g.rows.map((r) => r.key)));
    expect(grouped.size).toBe(view.direct.length);
  });

  it('keeps only the chosen categories, and drops the uncategorised group, when chips are pressed', () => {
    const chosen = groupRowsByCategory(view.direct, ['scheduling', 'accounting-erp']);
    expect(chosen.map((g) => g.key)).toEqual(['accounting-erp', 'scheduling']);
  });
});

describe('the three counts for one category agree', () => {
  it('rail, group heading and chip print one number, with and without other filters', () => {
    const view = longView(58);
    const states = [
      NO_INTEGRATION_FILTER,
      { ...NO_INTEGRATION_FILTER, directions: ['inbound' as const] },
      { ...NO_INTEGRATION_FILTER, partnerCategories: ['scheduling'] },
      { ...NO_INTEGRATION_FILTER, query: 'partner 1', partnerCategories: ['field-a'] },
    ];
    for (const state of states) {
      const base = rowsForFacetCount(view, state, 'partnerCategories');
      const groups = groupRowsByCategory(base, state.partnerCategories);
      for (const group of groups) {
        // The rail and the heading both print group.rows.length.
        const chip = rowsInCategory(base, group.category?.slug ?? null).length;
        expect(group.rows.length, `${group.key} ${JSON.stringify(state)}`).toBe(chip);
      }
      // The groups hold exactly the rows the filter keeps.
      const kept = filterIntegrationLanes(view, state).direct.map((r) => r.key);
      expect(new Set(groups.flatMap((g) => g.rows.map((r) => r.key)))).toEqual(new Set(kept));
    }
  });

  it('a chip counts the rows it would show once pressed alone in its facet', () => {
    const view = longView(58);
    const state = { ...NO_INTEGRATION_FILTER, directions: ['inbound' as const] };
    const base = rowsForFacetCount(view, state, 'partnerCategories');
    const pressed = filterIntegrationLanes(view, { ...state, partnerCategories: ['scheduling'] });
    expect(rowsInCategory(base, 'scheduling').length).toBe(pressed.rowCount);

    const directionBase = rowsForFacetCount(view, state, 'directions');
    const outbound = filterIntegrationLanes(view, { ...state, directions: ['outbound'] });
    expect(countRowsWithDirection(directionBase, 'outbound')).toBe(outbound.rowCount);
  });
});

describe('the cuts', () => {
  it('a group peeks its first rows in its own order, and the stack names the first hidden ones', () => {
    const group = groupRowsByCategory(longView(58).direct)[0]!;
    const { peek, hidden } = peekGroup(group.rows);
    expect(peek).toEqual(group.rows.slice(0, GROUP_PEEK_ROWS));
    expect(hidden).toEqual(group.rows.slice(GROUP_PEEK_ROWS));
    expect(stackPartners(hidden)).toEqual(hidden.slice(0, GROUP_STACK_LOGOS));
  });

  it('the phone cut is the first rows of the same order, inside the wide cut (AECI-1720)', () => {
    expect(GROUP_PEEK_ROWS_PHONE).toBe(3);
    expect(GROUP_PEEK_ROWS_PHONE).toBeLessThan(GROUP_PEEK_ROWS);
    const group = groupRowsByCategory(longView(58).direct)[0]!;
    const phone = peekGroup(group.rows, GROUP_PEEK_ROWS_PHONE);
    expect(phone.peek).toEqual(peekGroup(group.rows).peek.slice(0, GROUP_PEEK_ROWS_PHONE));
    expect(phone.hidden).toEqual(group.rows.slice(GROUP_PEEK_ROWS_PHONE));
  });

  it('group ids never collide with the uncategorised group', () => {
    expect(groupDomId('')).toBe('integrations-uncategorised');
    expect(groupDomId('uncategorised')).not.toBe(groupDomId(''));
  });
});
