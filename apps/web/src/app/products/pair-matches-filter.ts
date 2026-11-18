import type { PairAlternativeLane, PairAlternativeMatch } from '@aeci/shared';

import { normalizeFilterText } from './integration-filter';

/**
 * The empty pair page's closest-matches filter (AECI-1829, `STAGE_1_5_SPEC.md` §11.3).
 *
 * A match stays when it shares a category the reader left on, moves every data object
 * the reader picked, and, while the reader types a search, has the words in its product
 * or vendor name (the Integrations section's substring rule, `normalizeFilterText`). The
 * filter only removes: the lane keeps the API's A to Z order (ruling R1), and nothing
 * here reads a plan, a license, a rating, a count or a claim. The browser half of the
 * ordering firewall holds it to that
 * (`on-page-ordering-firewall.spec.ts`, `[surface:pair-page-closest-matches]`).
 */
export function filterPairMatches(
  lane: PairAlternativeLane,
  off: readonly string[],
  picked: readonly string[],
  query = '',
): PairAlternativeMatch[] {
  const offSet = new Set(off);
  const on = new Set(lane.anchors.filter((a) => !offSet.has(a.slug)).map((a) => a.slug));
  if (on.size === 0) return [];
  const needle = normalizeFilterText(query);
  const named = (text: string | null): boolean =>
    !!text && normalizeFilterText(text).includes(needle);
  return lane.matches.filter(
    (m) =>
      m.shared_categories.some((c) => on.has(c.slug)) &&
      picked.every((p) => m.data_objects.some((d) => d.slug === p)) &&
      (needle === '' || named(m.product.name) || named(m.vendor_name)),
  );
}
