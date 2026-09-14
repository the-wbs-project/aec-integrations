import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { taxonomyCategories } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { displayOrderAsc } from './display-order';

/**
 * Two halves (AECI-925).
 *
 * The behavioural half proves the ordering: a term with a NULL `display_order`
 * lands LAST, not first. Worth a real D1 rather than a string assertion, because
 * the whole defect was a wrong belief about how SQLite sorts NULL — asserting the
 * SQL text would just re-state the belief.
 *
 * The source-scan half is the one that keeps it fixed. `asc(x.displayOrder)` is
 * the obvious thing to write, reads correctly, and is silent when wrong: the list
 * still returns 200 and still looks ordered, right up until a promote mints a term
 * with no curated position and that term jumps to the top of the category nav. The
 * scan is over source rather than over behaviour because a behavioural test only
 * covers the query it happens to seed, and there are fifteen of these.
 */

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const read = (rel: string) => strip(readFileSync(join(process.cwd(), rel), 'utf8'));

/** Every `.ts` under `src/`, minus specs — the scan's own corpus. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.spec.')) out.push(path);
  }
  return out;
}

describe('displayOrderAsc — NULLs last (AECI-925)', () => {
  it('puts an uncurated term after every curated one', async () => {
    const testDb: TestDb = await makeTestDb();
    const { db } = testDb;
    await db.insert(taxonomyCategories).values([
      { id: 'c-late', slug: 'zzz-last', name: 'Zzz Last', displayOrder: 900 },
      // The promote-minted shape: name + slug only.
      { id: 'c-null', slug: 'minted-by-promote', name: 'Aaa Minted' },
      { id: 'c-early', slug: 'aaa-first', name: 'Aaa First', displayOrder: 10 },
    ]);

    const rows = await db
      .select({ slug: taxonomyCategories.slug })
      .from(taxonomyCategories)
      .orderBy(...displayOrderAsc(taxonomyCategories.displayOrder));

    // `Aaa Minted` sorts first alphabetically AND has display_order NULL. Under a
    // bare `asc()` it would win on both counts; here it must come last.
    expect(rows.map((r) => r.slug)).toEqual(['aaa-first', 'zzz-last', 'minted-by-promote']);
    testDb.dispose();
  });

  it('is the only spelling — no bare asc() on a displayOrder column', () => {
    const offenders = sourceFiles(join(process.cwd(), 'src'))
      .filter((f) => /\basc\(\s*\w+\.displayOrder\s*\)/.test(strip(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(process.cwd().length + 1));

    expect(offenders).toEqual([]);
  });

  it('is not a vacuous scan — the call sites really do order by display_order', () => {
    const SITES = [
      'src/routes/taxonomy.ts',
      'src/routes/taxonomy-list.ts',
      'src/routes/product-facets.ts',
      'src/lib/admin-catalog.ts',
      'src/lib/data-object-vocabulary.ts',
    ];
    for (const site of SITES) {
      expect(read(site), site).toContain('displayOrderAsc(');
    }
  });
});
