/**
 * Where focus goes after a decision removes a row from a moderation queue
 * (AECI-2102). The four queues under `admin/reviews`, `admin/review-updates`,
 * `admin/review-responses` and `admin/contests` share this one rule.
 *
 * - The decided row was not on screen (the operator paged away while the request
 *   was in flight): focus stays where the operator put it.
 * - No row is left on screen: the queue heading.
 * - The page the row was on no longer exists (it was the only row on the last
 *   page, so the pager stepped back): the LAST row of the new last page, the row
 *   nearest to where the operator was.
 * - Otherwise: the row that took its place, or the new last row when it was last.
 */
export type QueueFocusTarget<T> =
  | { readonly kind: 'none' }
  | { readonly kind: 'heading' }
  | { readonly kind: 'row'; readonly row: T };

/**
 * @param index The decided row's index on screen before it was removed, or -1.
 * @param pageBefore The page on screen before the removal (1 for an unpaged queue).
 * @param pageAfter The page on screen after the removal.
 * @param rows The rows on screen after the removal.
 */
export function queueFocusAfterRemoval<T>(
  index: number,
  pageBefore: number,
  pageAfter: number,
  rows: readonly T[],
): QueueFocusTarget<T> {
  if (index < 0) return { kind: 'none' };
  if (rows.length === 0) return { kind: 'heading' };
  if (pageAfter !== pageBefore) return { kind: 'row', row: rows[rows.length - 1]! };
  return { kind: 'row', row: rows[Math.min(index, rows.length - 1)]! };
}
