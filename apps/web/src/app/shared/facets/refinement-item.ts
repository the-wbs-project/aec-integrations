/**
 * One value in a refinement-list facet. Neutral home (AECI-143) for a type that
 * started life in `app/search/search-controller.ts` (Algolia/InstantSearch) but
 * is also consumed by the API-backed listing filter sidebar
 * (`app/shared/facets/facet-sidebar.ts`). Lifting it here keeps the listing
 * surface from importing the Algolia controller just for a 4-field shape;
 * `search-controller` re-exports it so existing search imports are unchanged.
 *
 * The widget that renders these (`app/search/widgets/search-refinement-list.ts`)
 * is presentation-only and source-agnostic — it doesn't care whether `count`
 * came from Algolia's facet stats or a D1 aggregation.
 */
export interface RefinementItem {
  /** The facet value. For Algolia product records this is the display name; for
   *  the API-backed taxonomy sidebar it is the term UUID sent as `{kind}_id`. */
  readonly value: string;
  /** Human-readable label rendered in the checkbox row. */
  readonly label: string;
  /** Match count for this value under the current (scoped) filters. */
  readonly count: number;
  /** Whether this value is currently selected. */
  readonly isRefined: boolean;
}
