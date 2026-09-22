import { describe, expect, it } from 'vitest';

import { resolveIntegrationSort, resolveProductSort, resolveVendorSort } from './sort';

describe('resolveProductSort (§7.4 default-direction rule + AECI-99 tiebreaker)', () => {
  it('maps `created` to `[{ createdAt: "desc" }, { id: "asc" }]`', () => {
    expect(resolveProductSort('created')).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
  });
  it('maps `name` to `[{ name: "asc" }, { id: "asc" }]`', () => {
    expect(resolveProductSort('name')).toEqual([{ name: 'asc' }, { id: 'asc' }]);
  });
  it('maps `updated` to `[{ updatedAt: "desc" }, { id: "asc" }]`', () => {
    expect(resolveProductSort('updated')).toEqual([{ updatedAt: 'desc' }, { id: 'asc' }]);
  });
  it('maps `rating` to `[{ ratingOverallAvg: "desc" }, { id: "asc" }]`', () => {
    expect(resolveProductSort('rating')).toEqual([{ ratingOverallAvg: 'desc' }, { id: 'asc' }]);
  });
  it('maps `reviews` to `[{ reviewCount: "desc" }, { id: "asc" }]`', () => {
    expect(resolveProductSort('reviews')).toEqual([{ reviewCount: 'desc' }, { id: 'asc' }]);
  });
});

describe('resolveVendorSort (§"Sort & direction": name → company_name + AECI-99 tiebreaker)', () => {
  it('maps `name` to `[{ companyName: "asc" }, { id: "asc" }]` (vendors have no `name` column)', () => {
    expect(resolveVendorSort('name')).toEqual([{ companyName: 'asc' }, { id: 'asc' }]);
  });
  it('maps `created` to `[{ createdAt: "desc" }, { id: "asc" }]`', () => {
    expect(resolveVendorSort('created')).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
  });
  it('maps `updated` to `[{ updatedAt: "desc" }, { id: "asc" }]`', () => {
    expect(resolveVendorSort('updated')).toEqual([{ updatedAt: 'desc' }, { id: 'asc' }]);
  });
});

describe('resolveIntegrationSort', () => {
  it('maps `name` to `[{ name: "asc" }, { id: "asc" }]` (default per §7.4)', () => {
    expect(resolveIntegrationSort('name')).toEqual([{ name: 'asc' }, { id: 'asc' }]);
  });
  it('maps `created` to `[{ createdAt: "desc" }, { id: "asc" }]`', () => {
    expect(resolveIntegrationSort('created')).toEqual([{ createdAt: 'desc' }, { id: 'asc' }]);
  });
});

// ---------------------------------------------------------------------------
// AECI-99 — every list orderBy must end with a unique tiebreaker so page-based
// skip/take pagination cannot drop or duplicate rows when the primary sort
// column has ties.
// ---------------------------------------------------------------------------

describe('AECI-99 tiebreaker shape', () => {
  it.each([
    ['product/created', resolveProductSort('created')],
    ['product/name', resolveProductSort('name')],
    ['product/updated', resolveProductSort('updated')],
    ['product/rating', resolveProductSort('rating')],
    ['product/reviews', resolveProductSort('reviews')],
    ['vendor/created', resolveVendorSort('created')],
    ['vendor/name', resolveVendorSort('name')],
    ['vendor/updated', resolveVendorSort('updated')],
    ['integration/name', resolveIntegrationSort('name')],
    ['integration/created', resolveIntegrationSort('created')],
  ])('%s ends with the unique `{ id: "asc" }` tiebreaker', (_label, orderBy) => {
    expect(Array.isArray(orderBy)).toBe(true);
    expect(orderBy.at(-1)).toEqual({ id: 'asc' });
  });
});

// ---------------------------------------------------------------------------
// AECI-99 — behavioral proof: paging over tied rows drops/duplicates nothing.
// ---------------------------------------------------------------------------

type Row = { id: string; createdAt: string; name: string };
type OrderClause = Record<string, 'asc' | 'desc'>;

/**
 * In-memory stand-in for Postgres pagination that reproduces the *unstable*
 * ordering of tied rows. It sorts by the multi-key `orderBy`; rows that tie on
 * every supplied key fall back to an `id` order whose direction flips per call.
 * That keeps each individual sort a valid, consistent total order, yet makes the
 * order of tied rows differ between queries — exactly like Postgres returning
 * tied rows in an arbitrary, query-dependent order. With a unique tiebreaker
 * present no two rows ever tie on all keys, so the flip never fires and
 * pagination is stable; without one, tied rows shuffle between page queries.
 */
function makeUnstablePaginator(rows: Row[]) {
  let call = 0;
  return ({ orderBy, skip, take }: { orderBy: OrderClause[]; skip: number; take: number }) => {
    const flip = call++ % 2 === 0 ? 1 : -1;
    const sorted = [...rows].sort((a, b) => {
      for (const clause of orderBy) {
        const [field, dir] = Object.entries(clause)[0];
        const av = (a as Record<string, string>)[field];
        const bv = (b as Record<string, string>)[field];
        if (av < bv) return dir === 'asc' ? -1 : 1;
        if (av > bv) return dir === 'asc' ? 1 : -1;
      }
      // All supplied keys tie → query-dependent order: a consistent comparator
      // within this call (id asc or desc), but reversed on the next call.
      return flip * (a.id < b.id ? -1 : 1);
    });
    return sorted.slice(skip, skip + take);
  };
}

function pageThrough(paginator: ReturnType<typeof makeUnstablePaginator>, orderBy: OrderClause[]) {
  const perPage = 3;
  const page1 = paginator({ orderBy, skip: 0, take: perPage });
  const page2 = paginator({ orderBy, skip: perPage, take: perPage });
  return [...page1, ...page2].map((r) => r.id);
}

describe('AECI-99 pagination stability', () => {
  // Six rows bulk-promoted with one timestamp (the issue's scenario): the
  // primary `created`/`name` columns tie on every row, so only `id` separates them.
  const tiedByCreatedAt: Row[] = Array.from({ length: 6 }, (_, i) => ({
    id: `id-${i}`,
    createdAt: '2026-06-01T00:00:00.000Z',
    name: `Product ${i}`,
  }));
  const tiedByName: Row[] = Array.from({ length: 6 }, (_, i) => ({
    id: `id-${i}`,
    createdAt: `2026-06-0${i + 1}T00:00:00.000Z`,
    name: 'Identical Name',
  }));
  const allIds = tiedByCreatedAt.map((r) => r.id).sort();

  it('drops/duplicates nothing across pages when sorting tied `createdAt` rows (default sort)', () => {
    const seen = pageThrough(makeUnstablePaginator(tiedByCreatedAt), resolveProductSort('created'));
    expect(new Set(seen).size).toBe(6); // no duplicates
    expect([...seen].sort()).toEqual(allIds); // no drops — every row exactly once
  });

  it('drops/duplicates nothing across pages when sorting tied `name` rows', () => {
    const seen = pageThrough(makeUnstablePaginator(tiedByName), resolveProductSort('name'));
    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort()).toEqual(allIds);
  });

  it('control: the same paginator DOES drop/duplicate without the tiebreaker', () => {
    // Proves the simulator has teeth and that the test would fail on pre-AECI-99
    // single-key code: a bare `[{ createdAt: 'desc' }]` lets tied rows shuffle.
    const seen = pageThrough(makeUnstablePaginator(tiedByCreatedAt), [{ createdAt: 'desc' }]);
    const unique = new Set(seen);
    const dropped = allIds.filter((id) => !unique.has(id));
    expect(unique.size < 6 || dropped.length > 0).toBe(true);
  });
});
