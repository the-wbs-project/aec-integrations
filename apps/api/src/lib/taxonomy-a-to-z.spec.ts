import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProductFacetsResponseSchema } from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProductFacetsHandler } from '../routes/product-facets';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';

/**
 * The filter panel on `/products` and the taxonomy term pages says "Phases in
 * project order. Other terms A to Z." (AECI-1793, rulings 5 and 6 of
 * 2026-11-16). Audiences are ordered by name in `routes/product-facets.ts`, so
 * that half holds by construction. Categories and trades are ordered by
 * `display_order` (`displayOrderAsc`), so the caption is only true while the
 * curated `display_order` runs A to Z. This test holds it there.
 *
 * The seed files are the canonical vocabulary (their own headers say so), and
 * no migration after `0009` writes `display_order` for these two tables. If you
 * add a term, give it a `display_order` that keeps the list A to Z, or change
 * the caption in `apps/web/src/app/shared/facets/facet-sidebar.ts` first.
 */

interface Term {
  readonly name: string;
  readonly order: number;
}

/** Read the `(id, slug, name, description, display_order, …)` rows of one INSERT. */
function seedTerms(file: string, table: string): Term[] {
  const sql = readFileSync(join(process.cwd(), 'seed', file), 'utf8');
  const start = sql.indexOf(`INSERT INTO "${table}"`);
  expect(start, `${table} INSERT in seed/${file}`).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf(';\n', start);
  const block = sql.slice(start, end === -1 ? undefined : end);
  const row = /^\s*\('[^']*',\s*'[^']*',\s*'((?:[^']|'')*)',\s*(?:'(?:[^']|'')*'|NULL),\s*(\d+)/gm;
  const terms: Term[] = [];
  for (const match of block.matchAll(row)) {
    terms.push({ name: match[1]!.replaceAll("''", "'"), order: Number(match[2]) });
  }
  return terms;
}

function inDisplayOrder(terms: readonly Term[]): string[] {
  return [...terms].sort((a, b) => a.order - b.order).map((t) => t.name);
}

describe('filter caption "Other terms A to Z" (AECI-1793)', () => {
  it.each([
    ['taxonomy.sql', 'taxonomy_categories', 20],
    ['trades.sql', 'taxonomy_trades', 20],
  ])('%s %s: display_order runs A to Z', (file, table, atLeast) => {
    const terms = seedTerms(file, table);
    // Guard the parser: an empty or truncated read would pass vacuously.
    expect(terms.length).toBeGreaterThanOrEqual(atLeast);
    const ordered = inDisplayOrder(terms);
    expect(ordered).toEqual([...ordered].sort(compareText));
  });

  it('every display_order is distinct, so no tie falls back to the name by accident', () => {
    for (const [file, table] of [
      ['taxonomy.sql', 'taxonomy_categories'],
      ['trades.sql', 'taxonomy_trades'],
    ] as const) {
      const orders = seedTerms(file, table).map((t) => t.order);
      expect(new Set(orders).size).toBe(orders.length);
    }
  });
});

/**
 * The seed check above reads the files. This one reads what the filter panel
 * renders: `GET /api/products/facets` over an in-memory D1 holding the real
 * seed vocabulary. The panel keeps the route's order (`aec-facet-sidebar` only
 * drops zero-count terms), so this is the order the caption describes.
 */
describe('GET /api/products/facets renders the order the caption states (AECI-1793)', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
    for (const file of ['taxonomy.sql', 'trades.sql']) {
      t.raw.exec(readFileSync(join(process.cwd(), 'seed', file), 'utf8'));
    }
  });
  afterEach(() => t.dispose());

  async function facets() {
    const res = await buildAppWithHandler({
      method: 'get',
      path: '/api/products/facets',
      handler: createProductFacetsHandler(t.factory),
    }).request('/api/products/facets', {}, TEST_ENV, fakeExecutionContext());
    expect(res.status).toBe(200);
    return ProductFacetsResponseSchema.parse(await res.json());
  }

  it('categories, audiences and trades come out A to Z', async () => {
    const body = await facets();
    for (const [group, terms, atLeast] of [
      ['categories', body.categories, 20],
      ['audiences', body.audiences, 20],
      ['trades', body.trades, 20],
    ] as const) {
      const names = terms.map((term) => term.name);
      expect(names.length, group).toBeGreaterThanOrEqual(atLeast);
      expect(names, group).toEqual([...names].sort(compareText));
    }
  });

  it('phases come out in project order, which is not A to Z', async () => {
    const body = await facets();
    const phases = body.phases.map((term) => term.slug);
    expect(phases).toEqual([
      'concept-planning',
      'design',
      'pre-construction',
      'construction',
      'closeout-operations',
    ]);
  });
});
