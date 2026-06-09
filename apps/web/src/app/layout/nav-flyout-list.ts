import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import { KIND_PATH_SEGMENT } from '../core/api/taxonomy';
import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

/**
 * Presentational list of taxonomy values for a single facet, shared by the
 * desktop nav flyout (AECI-158) and the mobile overlay disclosure (AECI-159) so
 * the two surfaces can never drift. Each value links to its browse page
 * (`/{segment}/{slug}`) — name only, no count — followed by a "View all →" link
 * to the facet index (`/{segment}`).
 *
 * Pure inputs only: the caller supplies the already-ranked `items` (from
 * `TaxonomyNavStore`) and the localized `viewAllLabel`, so this component owns
 * no data fetching and no i18n ids. The value names come from the API
 * (localized-as-data), so they carry no `i18n` markers. `KIND_PATH_SEGMENT` is
 * the single source of truth for facet pluralization (shared with the resolver
 * and route table). AECI-156.
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
            class="block rounded-(--radius-sm) px-3 py-1.5 text-sm text-(--text-primary) no-underline transition-colors hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            >{{ item.name }}</a
          >
        </li>
      }
    </ul>
    <a
      [routerLink]="basePath()"
      class="mt-1 block border-t border-(--border-default) px-3 pt-2 pb-1 text-sm font-medium text-(--text-secondary) no-underline transition-colors hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      >{{ viewAllLabel() }}</a
    >
  `,
})
export class NavFlyoutList {
  readonly items = input.required<readonly TaxonomyTermWithCount[]>();
  readonly kind = input.required<TaxonomyKind>();
  readonly viewAllLabel = input.required<string>();

  protected readonly basePath = computed(() => `/${KIND_PATH_SEGMENT[this.kind()]}`);
}
