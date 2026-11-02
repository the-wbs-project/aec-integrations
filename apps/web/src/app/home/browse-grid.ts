import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import { KIND_PATH_SEGMENT } from '../core/api/taxonomy';
import { TaxonomyBadge, type TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

/**
 * One labelled row of the home browse block (`home-browse-block.ts`): an `<h3>`
 * facet label, a "View all" link to the facet index, and a flex-wrap of taxonomy
 * count-chips (`TaxonomyBadge` with `[count]`). The block mounts it four times:
 * category, trade, project phase, audience. Every row uses the same chip.
 *
 * Purely presentational. `terms` arrives already ranked and sliced by the caller,
 * so this component does not rank or fetch. A count shows only when it is above
 * zero, so a thin corpus never prints a bare "0" (the §4.1 thin-corpus rule).
 * Projected content renders between the label row and the chips; the audience
 * row uses it for its one-sentence lede.
 *
 * Facet copy (label, view-all, empty) is owned here via a `kind` switch, keeping
 * the `@@home.browse.*` ids co-located, the same pattern `TaxonomyIndexPage` uses.
 */

/** The facets the home page browses: all four (trade joined in AECI-1573). */
export type HomeBrowseKind = TaxonomyKind;

/** The fields a chip needs. A full `TaxonomyTermWithCount` satisfies it. */
export type BrowseChipTerm = Pick<TaxonomyTermWithCount, 'slug' | 'name' | 'product_count'>;

@Component({
  selector: 'app-browse-grid',
  imports: [RouterLink, TaxonomyBadge],
  host: { class: 'block' },
  template: `
    <div
      class="border-t border-(--border-default) py-6 md:grid md:grid-cols-[12rem_minmax(0,1fr)] md:gap-8"
    >
      <div
        class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 md:flex-col md:justify-start"
      >
        <h3 class="font-display text-lg font-semibold tracking-tight text-(--text-primary)">
          {{ label() }}
        </h3>
        <a
          [routerLink]="indexPath()"
          class="rounded-sm text-sm text-(--text-secondary) underline decoration-(--border-strong)
            underline-offset-4 transition-colors hover:text-(--text-primary)
            focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        >
          {{ viewAllLabel() }}
        </a>
      </div>

      <div class="mt-4 md:mt-0">
        <ng-content />

        @if (terms().length > 0) {
          <ul class="flex flex-wrap gap-2">
            @for (term of terms(); track term.slug) {
              <li>
                <aec-taxonomy-badge
                  [kind]="kind()"
                  [slug]="term.slug"
                  [name]="term.name"
                  [count]="term.product_count > 0 ? term.product_count : undefined"
                />
              </li>
            }
          </ul>
        } @else {
          <p class="text-sm text-(--text-secondary)">{{ emptyLabel() }}</p>
        }
      </div>
    </div>
  `,
})
export class BrowseGrid {
  readonly kind = input.required<HomeBrowseKind>();
  /** Already ranked and sliced by the caller. */
  readonly terms = input.required<readonly BrowseChipTerm[]>();

  protected readonly indexPath = computed(() => `/${KIND_PATH_SEGMENT[this.kind()]}`);

  protected readonly label = computed(() => {
    switch (this.kind()) {
      case 'category':
        return $localize`:@@home.browse.category.label:Category`;
      case 'trade':
        return $localize`:@@home.browse.trade.label:Trade`;
      case 'audience':
        return $localize`:@@home.browse.audience.label:Audience`;
      case 'phase':
        return $localize`:@@home.browse.phase.label:Project phase`;
    }
  });

  protected readonly viewAllLabel = computed(() => {
    switch (this.kind()) {
      case 'category':
        return $localize`:@@home.browse.category.viewAll:View all categories`;
      case 'trade':
        return $localize`:@@home.browse.trade.viewAll:View all trades`;
      case 'audience':
        return $localize`:@@home.browse.audience.viewAll:View all audiences`;
      case 'phase':
        return $localize`:@@home.browse.phase.viewAll:View all phases`;
    }
  });

  protected readonly emptyLabel = computed(() => {
    switch (this.kind()) {
      case 'category':
        return $localize`:@@home.browse.category.empty:No categories to browse yet.`;
      case 'trade':
        return $localize`:@@home.browse.trade.empty:No trades to browse yet.`;
      case 'audience':
        return $localize`:@@home.browse.audience.empty:No audiences to browse yet.`;
      case 'phase':
        return $localize`:@@home.browse.phase.empty:No project phases to browse yet.`;
    }
  });
}
