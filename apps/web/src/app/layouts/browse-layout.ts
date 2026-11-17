import { booleanAttribute, Component, computed, input } from '@angular/core';

import { BAND_WRAP_CLASS } from '../shared/band-wrap';

/**
 * Browse layout shell: `/products`, the four taxonomy term pages, the four
 * taxonomy index pages (no filter rail, AECI-1795) and `/search` (AECI-1793,
 * mock-up 10). Named slots only; no state. The header slot's parts are spelled
 * once in `browse-header.ts`.
 *
 * Two parts, both on the 1328px page wrap (`BAND_WRAP_CLASS`, ruling 3 of
 * 2026-11-16), so the content lines up with the header and footer:
 *
 *   - The page header: white, no hero, a hairline across the full width below
 *     it. List pages are not detail pages, so there is no Forest band and no
 *     Bone here. The `/search` tablist sits on that hairline by a negative
 *     bottom margin equal to this header's bottom padding (32px, 40px from
 *     `md`). Change one and you must change the other.
 *   - The body: the filter rail beside the results, 1 to 3 from `md`, with a
 *     48px gap. Below `md` the rail stacks above the results and
 *     `aec-facet-panel` turns it into a "Filters" disclosure.
 *
 * `filters` (default true) drops the rail and its landmark for a page that has
 * nothing to filter, such as a term with no products yet. The page keeps the
 * same header, wrap and spacing, so the two states of one page do not drift.
 *
 * Anchor: Stripe (inherited from AECi site chrome). See `DESIGN.md`
 * "The Anchor-Site Rule".
 *
 * Slots:
 *   - `header`  the breadcrumb, h1 and lede (required)
 *   - `filters` the filter panel (omitted when `filters` is false)
 *   - `grid`    the toolbar, the results and the pagination footer (required)
 */
@Component({
  selector: 'aec-browse-layout',
  host: { class: 'block bg-(--surface-base) text-(--text-primary)' },
  template: `
    <header class="border-b pt-6 pb-8 md:pt-8 md:pb-10">
      <div [class]="wrapClass">
        <ng-content select="[slot=header]" />
      </div>
    </header>

    <div [class]="bodyClass()">
      <!-- min-w-0 on both columns: a grid item defaults to min-width:auto, so
           one long facet label or card title would otherwise widen its track
           past the minmax(0, …) cap and clip against the viewport. -->
      @if (filters()) {
        <aside
          class="min-w-0 md:self-start"
          i18n-aria-label="@@app.layouts.browse.filters.aria"
          aria-label="Filters"
        >
          <ng-content select="[slot=filters]" />
        </aside>
      }

      <section
        class="min-w-0"
        i18n-aria-label="@@app.layouts.browse.grid.aria"
        aria-label="Results"
      >
        <ng-content select="[slot=grid]" />
      </section>
    </div>
  `,
})
export class BrowseLayout {
  /** Whether the page has a filter rail. False drops the rail and its landmark. */
  readonly filters = input(true, { transform: booleanAttribute });

  protected readonly wrapClass = BAND_WRAP_CLASS;

  protected readonly bodyClass = computed(() =>
    this.filters()
      ? `${BAND_WRAP_CLASS} ${BODY_SPACING} grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,3fr)] md:gap-12`
      : `${BAND_WRAP_CLASS} ${BODY_SPACING}`,
  );
}

/** 32px above the body and 64px below it, 40px and 96px from `md`. */
const BODY_SPACING = 'pt-8 pb-16 md:pt-10 md:pb-24';
