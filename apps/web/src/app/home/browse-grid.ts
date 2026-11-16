import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import { KIND_PATH_SEGMENT } from '../core/api/taxonomy';
import { TaxonomyBadge, type TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

/**
 * One labelled row of the home browse block (`home-browse-block.ts`): an `<h3>`
 * facet label, a "View all" link to the facet index, a caption that states the
 * row's order, and a flex-wrap of taxonomy count-chips (`TaxonomyBadge` with `[count]`). The block mounts it four times:
 * category, trade, project phase, audience. Every row uses the same chip.
 *
 * Purely presentational. `terms` arrives already ranked and sliced by the caller,
 * so this component does not rank or fetch. A count shows only when it is above
 * zero, so a thin corpus never prints a bare "0" (the §4.1 thin-corpus rule).
 * Projected content renders between the label row and the chips; every row uses
 * it for its one-sentence lede.
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
    <div class="border-t py-6 md:grid md:grid-cols-[15rem_minmax(0,1fr)] md:gap-8">
      <div class="flex flex-col items-start gap-1 text-t-14">
        <h3 class="text-(--text-primary)">
          <span class="block leading-tight">{{ label() }}</span>
        </h3>
        <a
          [routerLink]="indexPath()"
          class="rounded-sm text-(--text-secondary) underline decoration-(--border-field)
            underline-offset-4 transition-colors hover:text-(--accent-primary) hover:decoration-current
            focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
        >
          {{ viewAllLabel() }}
        </a>
        <span data-testid="browse-order" class="text-t-13 text-(--text-secondary)">{{
          orderLabel()
        }}</span>
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

  /**
   * How the row is ordered, printed under "View all" (mock-up 9, question 5). Every
   * list on the home states its order (no pay-for-placement). The words follow the
   * Browse menu's footer line (PLAN.md §4.8). The orders themselves are set by
   * `home.ts` (counts, `display_order`) and by the curated role list.
   */
  protected readonly orderLabel = computed(() => {
    switch (this.kind()) {
      case 'category':
        return $localize`:@@home.browse.category.order:Most products first`;
      case 'trade':
        return $localize`:@@home.browse.trade.order:Most products first`;
      case 'audience':
        return $localize`:@@home.browse.audience.order:Roles chosen by AEC Integrations`;
      case 'phase':
        return $localize`:@@home.browse.phase.order:In project order`;
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
