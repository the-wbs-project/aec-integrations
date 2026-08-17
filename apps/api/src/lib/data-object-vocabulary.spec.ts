/**
 * The find-only `data_object` vocabulary resolver (Stage 1.5 §6.2), extracted
 * from `routes/promote.ts` by AECI-301 so promote and the vendor authoring API
 * share ONE matching rule.
 *
 * These cases pin the behaviour promote already depended on — normalisation,
 * alias matching, slug-beats-alias, and above all that a miss is a miss. The two
 * callers differ only in what they do with a miss (`skipped[]` vs a 400), so a
 * regression here would silently change both at once.
 */

import { eq } from 'drizzle-orm';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { taxonomyDataObjects } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { loadDataObjectResolver, safeSlugify } from './data-object-vocabulary';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const RFIS = uuid(1);
const SUBMITTALS = uuid(2);
const COST = uuid(3);

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(taxonomyDataObjects).values([
    { id: RFIS, slug: 'rfis', name: 'RFIs', aliases: ['Requests for Information', 'RFI'] },
    { id: SUBMITTALS, slug: 'submittals', name: 'Submittals', aliases: null },
    { id: COST, slug: 'cost-items', name: 'Cost items', aliases: ['Budget lines'] },
  ]);
});
afterEach(() => t.dispose());

describe('safeSlugify', () => {
  it('normalizes case and spacing', () => {
    expect(safeSlugify('  Requests For Information ')).toBe('requests-for-information');
  });

  it('returns null instead of throwing on a value that maps to no usable slug', () => {
    // A bare `slugify` throws here; term resolution must degrade to "no match"
    // rather than 500 the whole promote.
    expect(safeSlugify('   ')).toBeNull();
    expect(safeSlugify('!!!')).toBeNull();
  });
});

describe('loadDataObjectResolver', () => {
  it('resolves a term by its exact slug, returning the whole term', async () => {
    const resolve = await loadDataObjectResolver(t.db);
    // slug + name ride along so the vendor path can echo them on the created
    // claim without a second read of the row it just matched.
    expect(resolve('rfis')).toEqual({ id: RFIS, slug: 'rfis', name: 'RFIs' });
    expect(resolve('submittals')?.id).toBe(SUBMITTALS);
  });

  it('resolves by alias', async () => {
    const resolve = await loadDataObjectResolver(t.db);
    expect(resolve('Requests for Information')?.id).toBe(RFIS);
    expect(resolve('Budget lines')?.id).toBe(COST);
  });

  it('ignores case and spacing on both sides of the match', async () => {
    const resolve = await loadDataObjectResolver(t.db);
    expect(resolve('RFIs')?.id).toBe(RFIS);
    expect(resolve('  COST ITEMS  ')?.id).toBe(COST);
    expect(resolve('requests-for-information')?.id).toBe(RFIS);
  });

  it('is find-only — an unknown term resolves to undefined, never a new row', async () => {
    const resolve = await loadDataObjectResolver(t.db);
    expect(resolve('punch-lists')).toBeUndefined();
    expect(await t.db.select().from(taxonomyDataObjects)).toHaveLength(3);
  });

  it('returns undefined for a value that slugifies to nothing', async () => {
    const resolve = await loadDataObjectResolver(t.db);
    expect(resolve('   ')).toBeUndefined();
  });

  it('lets a term’s own slug beat another term’s alias for the same key', async () => {
    // Deliberate collision: `submittals` is both a slug on one row and an alias
    // on another. Rows are keyed slug-first, and first-write-wins, so the slug
    // owner keeps the key regardless of row order.
    await t.db
      .update(taxonomyDataObjects)
      .set({ aliases: ['Submittals'] })
      .where(eq(taxonomyDataObjects.id, COST));
    const resolve = await loadDataObjectResolver(t.db);
    expect(resolve('submittals')?.id).toBe(SUBMITTALS);
  });

  it('tolerates a null aliases column', async () => {
    const resolve = await loadDataObjectResolver(t.db);
    expect(resolve('Submittals')?.id).toBe(SUBMITTALS);
  });

  it('resolves against an empty vocabulary without throwing', async () => {
    await t.db.delete(taxonomyDataObjects);
    const resolve = await loadDataObjectResolver(t.db);
    expect(resolve('rfis')).toBeUndefined();
  });
});
