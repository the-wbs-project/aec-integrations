import { Component, input, signal } from '@angular/core';

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
 * The host projects the facet groups and any "Clear filters" action; this
 * component owns only the trigger, the panel, and the desktop heading.
 */
@Component({
  selector: 'aec-facet-panel',
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-4">
      <button
        type="button"
        class="flex w-full cursor-pointer items-center justify-between rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) px-4 py-2.5 text-start transition-colors hover:border-(--border-strong) hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) md:hidden"
        [attr.aria-expanded]="open()"
        [attr.aria-controls]="panelId()"
        (click)="toggle()"
      >
        <span class="aec-overline text-(--text-primary)" i18n="@@listing.filters.title"
          >Filters</span
        >
        <span class="inline-flex items-center gap-2">
          @if (activeCount(); as n) {
            <span
              class="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-(--accent-primary) px-1.5 text-xs font-medium tabular-nums text-(--surface-base)"
              aria-hidden="true"
              >{{ n }}</span
            >
          }
          <svg
            aria-hidden="true"
            class="h-4 w-4 text-(--text-secondary) transition-transform"
            [class.rotate-180]="open()"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>

      <!--
        flex+gap (not space-y-*): each facet group is a custom element, which
        defaults to display:inline, and space-y's margin-top is ignored on inline
        boxes. As flex items they're blockified and gap-6 spaces them reliably.
      -->
      <div
        [id]="panelId()"
        class="min-w-0 flex-col gap-6 md:flex"
        [class.flex]="open()"
        [class.hidden]="!open()"
      >
        <h2
          class="aec-overline hidden text-(--text-primary) md:block"
          i18n="@@listing.filters.title"
        >
          Filters
        </h2>
        <ng-content />
      </div>
    </div>
  `,
})
export class FacetPanel {
  /** Selected-term count, shown as a badge on the mobile trigger. 0 hides it. */
  readonly activeCount = input<number>(0);
  /** DOM id of the panel, the trigger's `aria-controls` target. */
  readonly panelId = input<string>('aec-facet-panel');

  /** Mobile-only disclosure state (the panel is always shown at md+). */
  protected readonly open = signal(false);

  protected toggle(): void {
    this.open.update((value) => !value);
  }
}
