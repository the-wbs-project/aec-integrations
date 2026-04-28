import type { GridComponent } from '@syncfusion/ej2-angular-grids';

/**
 * Syncfusion's column wrapper swaps (x, y) before invoking our `sortComparer`
 * for descending sorts, then returns the result to Array.sort as-is. That
 * means a "blanks return +1" rule lands blanks at the bottom in ascending
 * but at the top in descending — the opposite of what we want.
 *
 * This factory reads the column's *current* sort direction off the grid
 * (set on the column by Syncfusion before our comparer runs) and flips the
 * blank-vs-non-blank sign accordingly, so blanks pin to the bottom of the
 * visible list in both directions.
 */
export type GridSortComparer = (a: unknown, b: unknown) => number;

const isBlank = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/**
 * Build a Syncfusion grid sortComparer that always sorts blanks to the bottom.
 *
 * @param gridGetter   Returns the GridComponent (typically `() => this.grid`).
 * @param field        The column's `field` — used to look up its direction.
 * @param baseCompare  Optional comparison for non-blank values. Defaults to
 *                     a natural compare (numeric or locale string).
 */
export function blanksLastComparer(
  gridGetter: () => GridComponent | undefined,
  field: string,
  baseCompare?: (a: unknown, b: unknown) => number,
): GridSortComparer {
  return (a, b) => {
    const aBlank = isBlank(a);
    const bBlank = isBlank(b);
    if (aBlank && bBlank) return 0;
    if (aBlank || bBlank) {
      const direction =
        gridGetter()
          ?.sortSettings.columns?.find((c) => c.field === field)?.direction ??
        'Ascending';
      const descending = direction === 'Descending';
      if (aBlank) return descending ? -1 : 1;
      return descending ? 1 : -1;
    }
    return baseCompare ? baseCompare(a, b) : naturalCompare(a, b);
  };
}

function naturalCompare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}
