/**
 * Display order for the "How teams use it" groups on `GET /api/products/:slug`.
 *
 * The stored `products.usefulness` block keeps whatever group order its writer
 * sent: the review app's authoring order through promote, or the vendor
 * portal's, which appends a newly ticked term to the end. Neither is an order a
 * reader expects, so the public read sorts the GROUPS:
 *
 *  - **Audiences: alphabetical by name**, case-insensitive (`compareText`), slug
 *    as the tiebreaker. Deliberately not `display_order`: the audience
 *    vocabulary is disciplines then job titles, so its curated order is not
 *    alphabetical past position 210.
 *  - **Phases: project-lifecycle order**, the same rule as the header's Phases
 *    menu (`byDisplayOrder` in `apps/web/src/app/core/taxonomy/taxonomy-rank.ts`)
 *    and every D1 taxonomy read: `display_order` ascending, then name. A term
 *    with no `display_order` sorts last, per `display-order.ts`.
 *
 * The POINTS inside a group are never reordered. Their order is the writer's
 * choice, and the vendor editor exposes it as move-up / move-down.
 *
 * Sorting on read, not on write, covers both writers and every row already
 * stored with no data migration. The vendor portal reads the stored order
 * unchanged, so its order-sensitive dirty check (`groupsEqual` in the facet
 * editor) is unaffected.
 */

import type { ProductUsefulness, UsefulnessGroup } from '@aeci/shared';
import { inArray } from 'drizzle-orm';

import type { Db } from '../db/client';
import { taxonomyPhases } from '../db/schema';
import { compareTermsByDisplayOrder, compareTermsByName } from './taxonomy-order';

/** `display_order` for each phase slug the block names. Skips the read when
 *  there are no phase groups. */
export async function phaseDisplayOrders(
  db: Db,
  usefulness: ProductUsefulness | null,
): Promise<ReadonlyMap<string, number | null>> {
  const slugs = [...new Set(usefulness?.phases.map((g) => g.slug) ?? [])];
  if (slugs.length === 0) return new Map();
  const rows = await db
    .select({ slug: taxonomyPhases.slug, displayOrder: taxonomyPhases.displayOrder })
    .from(taxonomyPhases)
    .where(inArray(taxonomyPhases.slug, slugs));
  return new Map(rows.map((r) => [r.slug, r.displayOrder]));
}

/** Pure. Returns a new block with both group lists sorted; points untouched. */
export function orderUsefulness(
  usefulness: ProductUsefulness | null,
  phaseOrder: ReadonlyMap<string, number | null>,
): ProductUsefulness | null {
  if (!usefulness) return usefulness;
  // A slug missing from the map (a term deleted since the write) is uncurated.
  const withOrder = (g: UsefulnessGroup) => ({
    ...g,
    displayOrder: phaseOrder.get(g.slug) ?? null,
  });
  return {
    audiences: [...usefulness.audiences].sort(compareTermsByName),
    phases: usefulness.phases
      .map(withOrder)
      .sort(compareTermsByDisplayOrder)
      .map(({ displayOrder: _, ...g }) => g),
  };
}
