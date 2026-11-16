import { Component, input, signal } from '@angular/core';

import { AecButton } from '../button/button';
import { AecIcon } from '../icon/icon';

/**
 * The responsive chrome around a listing's filter rail, shared by the
 * API-backed `aec-facet-sidebar` (`/products` + taxonomy browse pages) and the
 * Algolia-backed rail on `/search`. Extracted so the two surfaces cannot drift
 * again: `/search` shipped with its own hand-rolled rail and never received the
 * mobile disclosure below.
 *
 * On `< md` the host `aside` stacks *above* the results (`BrowseLayout`'s
 * single-column collapse), so a fully-expanded rail forces the reader to scroll
 * past every checkbox to reach the list. Below `md` the projected groups
 * therefore live behind a "Filters" disclosure (collapsed by default, with an
 * active-filter count badge). At `md+` the trigger is removed and the panel is
 * always shown. Default-collapsed keeps SSR / edge-cached HTML
 * visitor-state-neutral: the panel's `hidden`/`md:flex` is pure CSS the client
 * never has to reconcile. Matches the disclosure idiom in `nav-menu.ts`.
 *
 * Mock-up 10 (AECI-1793): the trigger is the secondary button, 44px on the
 * strong edge. The badge is drawn for the eye and the same count is read out
 * as visually hidden text, so the trigger's name says how many filters are on.
 * `orderNote` is the line under the groups that states how the terms are
 * ordered (rulings 5 and 6 of 2026-11-16). Each host passes its own words,
 * because `/products` and `/search` order their terms differently.
 *
 * The host projects the facet groups and any "Clear filters" action; this
 * component owns only the trigger, the panel, the desktop heading and the
 * order note.
 */
@Component({
  selector: 'aec-facet-panel',
  imports: [AecButton, AecIcon],
  host: { class: 'block' },
  template: `
    <button
      aecButton
      variant="secondary"
      type="button"
      class="w-full md:hidden"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="panelId()"
      (click)="toggle()"
    >
      <span class="flex w-full items-center justify-between gap-3 text-(--text-primary)">
        <span class="inline-flex items-center">
          <span i18n="@@listing.filters.title">Filters</span>
          @if (activeCount(); as n) {
            <span class="sr-only" i18n="@@listing.filters.activeCount">, {{ n }} active</span>
            <span
              class="ms-2 inline-grid h-5.5 min-w-5.5 place-items-center rounded-pill bg-(--accent-primary) px-1.5 text-t-13 font-semibold tabular-nums text-(--surface-base)"
              aria-hidden="true"
              >{{ n }}</span
            >
          }
        </span>
        <!-- The rotation sits on a wrapper: aec-icon's host is display:contents. -->
        <span
          class="inline-flex text-(--text-secondary) transition-transform duration-fast ease-standard"
          [class.rotate-180]="open()"
        >
          <aec-icon name="chevron-down" decorative [size]="4" />
        </span>
      </span>
    </button>

    <!--
      flex+gap (not space-y-*): each facet group is a custom element, which
      defaults to display:inline, and space-y's margin-top is ignored on inline
      boxes. As flex items they're blockified and gap-6 spaces them reliably.
    -->
    <div
      [id]="panelId()"
      class="mt-4 min-w-0 flex-col gap-6 md:mt-0 md:flex"
      [class.flex]="open()"
      [class.hidden]="!open()"
    >
      <h2 class="aec-overline hidden text-(--text-primary) md:block" i18n="@@listing.filters.title">
        Filters
      </h2>
      <ng-content />
      @if (orderNote(); as note) {
        <p class="text-t-13 text-(--text-secondary)">{{ note }}</p>
      }
    </div>
  `,
})
export class FacetPanel {
  /** Selected-term count, shown as a badge on the mobile trigger. 0 hides it. */
  readonly activeCount = input<number>(0);
  /** DOM id of the panel, the trigger's `aria-controls` target. */
  readonly panelId = input<string>('aec-facet-panel');
  /** The localized line that states how the terms are ordered. Empty hides it. */
  readonly orderNote = input<string>('');

  /** Mobile-only disclosure state (the panel is always shown at md+). */
  protected readonly open = signal(false);

  protected toggle(): void {
    this.open.update((value) => !value);
  }
}
