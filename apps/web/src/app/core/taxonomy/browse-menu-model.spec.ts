import { describe, expect, it } from 'vitest';

import type { TaxonomyResponse, TaxonomyTermWithCount } from '@aeci/shared';

import {
  BROWSE_COLUMN_LENGTH,
  BROWSE_KEY_CATEGORY_SLUGS,
  EMPTY_BROWSE_MENU,
  buildBrowseMenu,
} from './browse-menu-model';

function term(
  slug: string,
  count: number,
  opts: { name?: string; id?: string; order?: number } = {},
): TaxonomyTermWithCount {
  return {
    id: opts.id ?? `id-${slug}`,
    slug,
    name: opts.name ?? slug,
    description: null,
    display_order: opts.order ?? 0,
    product_count: count,
  };
}

function response(overrides: Partial<TaxonomyResponse> = {}): TaxonomyResponse {
  return {
    categories: [],
    audiences: [],
    phases: [],
    trades: [],
    total_products: 120,
    ...overrides,
  };
}

const slugs = (terms: readonly TaxonomyTermWithCount[]) => terms.map((t) => t.slug);

describe('buildBrowseMenu', () => {
  it('is empty before the fetch lands, and on a failed fetch', () => {
    expect(buildBrowseMenu(null)).toBe(EMPTY_BROWSE_MENU);
    expect(EMPTY_BROWSE_MENU.totalProducts).toBeUndefined();
  });

  it('keeps the key categories in the ruled order, whatever their counts', () => {
    // Counts rise against the ruled order, so a count sort would reverse it.
    const menu = buildBrowseMenu(
      response({
        categories: [
          term('accounting-erp', 92),
          term('bim-authoring', 64),
          term('project-management', 30),
          term('ai', 2),
          term('field-management', 50),
        ],
      }),
    );
    expect(slugs(menu.keyCategories)).toEqual([...BROWSE_KEY_CATEGORY_SLUGS]);
    expect(BROWSE_KEY_CATEGORY_SLUGS[0]).toBe('ai');
  });

  it('skips a key slug the API no longer returns, and a key category with no products', () => {
    const menu = buildBrowseMenu(
      response({
        categories: [term('ai', 4), term('bim-authoring', 0), term('accounting-erp', 1)],
      }),
    );
    expect(slugs(menu.keyCategories)).toEqual(['ai', 'accounting-erp']);
  });

  it('leaves the key categories out of the Categories column, then takes the top seven', () => {
    const others = Array.from({ length: 10 }, (_, i) => term(`cat-${i}`, i + 1));
    const menu = buildBrowseMenu(
      response({ categories: [term('ai', 99), term('project-management', 98), ...others] }),
    );
    expect(menu.categories).toHaveLength(BROWSE_COLUMN_LENGTH);
    expect(slugs(menu.categories)).toEqual([
      'cat-9',
      'cat-8',
      'cat-7',
      'cat-6',
      'cat-5',
      'cat-4',
      'cat-3',
    ]);
    for (const key of BROWSE_KEY_CATEGORY_SLUGS) expect(slugs(menu.categories)).not.toContain(key);
  });

  it('breaks a count tie by name, ignoring case, then by id', () => {
    const menu = buildBrowseMenu(
      response({
        categories: [
          term('zeta', 5, { name: 'zeta' }),
          term('alpha-b', 5, { name: 'Alpha', id: 'b' }),
          term('beta', 5, { name: 'beta' }),
          term('alpha-a', 5, { name: 'alpha', id: 'a' }),
          term('top', 9, { name: 'Top' }),
        ],
        audiences: [
          term('owners', 3, { name: 'Owners' }),
          term('architects', 3, { name: 'architects' }),
        ],
      }),
    );
    expect(slugs(menu.categories)).toEqual(['top', 'alpha-a', 'alpha-b', 'beta', 'zeta']);
    expect(slugs(menu.audiences)).toEqual(['architects', 'owners']);
  });

  it('never shows a term with no products in a count column', () => {
    const menu = buildBrowseMenu(
      response({
        categories: [term('robotics', 0), term('estimating', 3)],
        audiences: [term('nobody', 0), term('owners', 1)],
        trades: [term('roofing', 0), term('hvac', 2)],
      }),
    );
    expect(slugs(menu.categories)).toEqual(['estimating']);
    expect(slugs(menu.audiences)).toEqual(['owners']);
    expect(slugs(menu.trades)).toEqual(['hvac']);
  });

  it('shows every phase in project order, not by count', () => {
    const menu = buildBrowseMenu(
      response({
        phases: [
          term('closeout', 50, { order: 5 }),
          term('concept', 1, { order: 1 }),
          term('construction', 40, { order: 4 }),
          term('design', 2, { order: 2 }),
          term('preconstruction', 3, { order: 3 }),
        ],
      }),
    );
    expect(slugs(menu.phases)).toEqual([
      'concept',
      'design',
      'preconstruction',
      'construction',
      'closeout',
    ]);
  });

  it('caps audiences and trades at seven, most products first', () => {
    const many = (prefix: string) =>
      Array.from({ length: 9 }, (_, i) => term(`${prefix}-${i}`, i + 1));
    const menu = buildBrowseMenu(response({ audiences: many('aud'), trades: many('trade') }));
    expect(menu.audiences).toHaveLength(7);
    expect(menu.audiences[0]?.slug).toBe('aud-8');
    expect(menu.trades).toHaveLength(7);
    expect(menu.trades[6]?.slug).toBe('trade-2');
  });

  it('carries the total, and no total when an older API Worker omits it', () => {
    expect(buildBrowseMenu(response({ total_products: 486 })).totalProducts).toBe(486);
    const older = { ...response(), total_products: undefined } as unknown as TaxonomyResponse;
    expect(buildBrowseMenu(older).totalProducts).toBeUndefined();
  });
});
