import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import { KIND_PATH_SEGMENT } from '../core/api/taxonomy';
import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

/**
 * Presentational list of taxonomy values for one facet section of the mobile
 * overlay (`nav-menu.ts`, AECI-159). Each value links to its browse page
 * (`/{segment}/{slug}`), name only, followed by a "See all" link to the facet
 * index (`/{segment}`). The desktop Browse panel (`browse-menu.ts`, AECI-1774)
 * draws its own columns, with counts. AECI-1775 rebuilds the mobile menu on the
 * Browse menu's design and decides whether this component stays.
 *
 * Pure inputs only: the caller supplies the already-ranked `items` (from
 * `TaxonomyNavStore.browse`) and the localized `viewAllLabel`, so this component
 * owns no data fetching and no i18n ids. The value names come from the API
 * (localized-as-data), so they carry no `i18n` markers. `KIND_PATH_SEGMENT` is
 * the single source of truth for facet pluralization (shared with the resolver
 * and route table). AECI-156.
 *
 * Every link is a panel destination, so every link is weight 400, pinned rather
 * than inherited (DESIGN.md §5 "Panel type").
 */
@Component({
  selector: 'aec-nav-flyout-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <ul class="flex flex-col gap-0.5">
      @for (item of items(); track item.id) {
        <li>
          <a
            [routerLink]="[basePath(), item.slug]"
            (click)="navigate.emit()"
            class="block rounded-(--radius-sm) px-3 py-1.5 text-sm font-normal text-(--text-primary) no-underline transition-colors hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            >{{ item.name }}</a
          >
        </li>
      }
    </ul>
    <a
      [routerLink]="basePath()"
      (click)="navigate.emit()"
      class="mt-1 block border-t border-(--border-default) px-3 pt-2 pb-1 text-sm font-normal text-(--text-secondary) no-underline transition-colors hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      >{{ viewAllLabel() }}</a
    >
  `,
})
export class NavFlyoutList {
  readonly items = input.required<readonly TaxonomyTermWithCount[]>();
  readonly kind = input.required<TaxonomyKind>();
  readonly viewAllLabel = input.required<string>();

  /**
   * Emits when any link (a value or "See all") is activated. The mobile overlay
   * (`nav-menu.ts`) wires this to close the menu after navigation.
   */
  readonly navigate = output<void>();

  protected readonly basePath = computed(() => `/${KIND_PATH_SEGMENT[this.kind()]}`);
}
