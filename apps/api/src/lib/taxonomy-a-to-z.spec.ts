import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { compareText } from '@aeci/shared/text-sort';
import { describe, expect, it } from 'vitest';

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
