/**
 * AECI-1882 check 3 (WCAG 3.2.2): the controls allowed to change the page when
 * they change. Every other form control must leave the page where it was, with
 * focus on the control. `judgeOnInput` in `./interaction-rules.ts` applies it.
 *
 * An entry says what the control does on change and why it is listed. Status:
 *   - `allowed`: ruled. The control may change the page on change. Every
 *     entry today: Chris ruled on 2026-11-26 that facet filters, listing sort
 *     and the portal integration filters may act on change.
 *   - `pending-ruling`: waiting for Chris. The test passes, and
 *     `docs/TESTING_STRATEGY.md` §8.4.7 lists it as pending. None today. The
 *     status stays so a future entry that needs a ruling has a home.
 *
 * An entry that stops matching (the control no longer changes the page) turns
 * the test red, so the list stays true.
 */
import type { OnInputEntry } from './interaction-rules';

/** The listing pages: `/products` and the three browse pages. `/vendors` and `/integrations` answer 301 to `/products`. */
const LISTINGS = new Set([
  'product-index',
  'vendor-index',
  'integration-index',
  'category-browse',
  'audience-browse',
  'phase-browse',
]);

const RULED =
  'A filter or sort updates the results in place and writes its state to the address. Allowed on change: ruled by Chris, 2026-11-26.';

export const ON_INPUT_LIST: readonly OnInputEntry[] = [
  {
    id: 'facet-filters',
    surfaces: (id) => LISTINGS.has(id),
    control: (c) => c.host === 'aec-search-refinement-list' && c.role === 'checkbox',
    effect: 'url-query',
    status: 'allowed',
    does: 'A facet box filters the results at once and writes the filter to the address (?categories=…). Focus stays on the box.',
    why: RULED,
  },
  {
    id: 'listing-sort',
    surfaces: (id) => LISTINGS.has(id),
    control: (c) => c.host === 'aec-listing-sort-select' && c.role === 'combobox',
    effect: 'url-query',
    status: 'allowed',
    does: 'Choosing a sort reorders the results at once and writes it to the address (?sort=…). Focus returns to the sort button.',
    why: RULED,
  },
  {
    id: 'portal-integration-filters',
    surfaces: (id) => id === 'vendor-integrations',
    control: (c) =>
      c.host === 'aec-vendor-integrations-section' && (c.role === 'textbox' || c.role === 'select'),
    effect: 'url-query',
    status: 'allowed',
    does: 'The Search box filters as you type, and "Integrates with" filters on change. Both write the filter to the address. Focus stays on the control.',
    why: RULED,
  },
];
