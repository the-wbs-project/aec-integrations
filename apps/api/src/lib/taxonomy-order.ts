/**
 * In-memory display order for taxonomy terms on the product detail read
 * (AECI-1242). The D1 side of the same rule is `display-order.ts`; this is its
 * twin for lists that are already loaded.
 *
 * Two orders, chosen per facet by the caller:
 *  - {@link compareTermsByDisplayOrder}: curated `display_order` ascending, NULLs
 *    LAST, then name. Categories, trades and phases. For phases that is the
 *    project lifecycle, the same sequence as the header Phases menu.
 *  - {@link compareTermsByName}: name only. Audiences, whose curated order is
 *    disciplines then job titles and so is not alphabetical past position 210.
 *
 * Both break a name tie on `slug` in binary order, so the result never depends
 * on the order D1 returned the rows in.
 */

import { compareText } from '@aeci/shared/text-sort';

interface NamedTerm {
  slug: string;
  name: string;
}

export function compareTermsByName(a: NamedTerm, b: NamedTerm): number {
  return compareText(a.name, b.name) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
}

export function compareTermsByDisplayOrder(
  a: NamedTerm & { displayOrder: number | null },
  b: NamedTerm & { displayOrder: number | null },
): number {
  const oa = a.displayOrder;
  const ob = b.displayOrder;
  if (oa !== ob) {
    if (oa === null) return 1;
    if (ob === null) return -1;
    return oa - ob;
  }
  return compareTermsByName(a, b);
}
