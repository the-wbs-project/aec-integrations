import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import { KIND_PATH_SEGMENT } from '../core/api/taxonomy';
import { TaxonomyBadge, type TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

/**
 * AECI-184 — Phase 4.9. One "Browse by {facet}" home subsection: a labelled
 * `<h2>` + a flex-wrap of taxonomy count-chips (`TaxonomyBadge` with `[count]`)
 * + a "View all" link to the facet index page. Invoked three times by the home
 * page (category / audience / phase).
 *
 * Per `home-direction.md` §"Section rhythm", these are denser count-chips, NOT
 * the three-column card grid the `/categories` index uses — so the home does
 * not read as one repeating card. The chip itself is the shipped `TaxonomyBadge`
 * (reused, not rebuilt); this component is the section frame + ranking surface.
 *
 * `terms` arrives already sliced to the top-N by the home page (`topByCount`),
 * so this component is purely presentational — it does not rank or fetch.
 * Facet copy (heading / view-all / empty) is owned here via a `kind` switch,
 * keeping the `@@home.browse.*` ids co-located, the same pattern
 * `TaxonomyIndexPage` uses.
 */
@Component({
  selector: 'app-browse-grid',
  imports: [RouterLink, TaxonomyBadge],
  template: `
    <section>
      <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 class="font-display text-xl font-semibold tracking-tight text-(--text-primary)">
          {{ heading() }}
        </h2>
        <a
          [routerLink]="indexPath()"
          class="rounded-sm text-sm text-(--text-secondary) underline decoration-(--border-strong)
            underline-offset-4 transition-colors hover:text-(--text-primary)
            focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        >
          {{ viewAllLabel() }}
        </a>
      </div>

      @if (terms().length > 0) {
        <ul class="mt-4 flex flex-wrap gap-2">
          @for (term of terms(); track term.slug) {
            <li>
              <aec-taxonomy-badge
                [kind]="kind()"
                [slug]="term.slug"
                [name]="term.name"
                [count]="term.product_count"
              />
            </li>
          }
        </ul>
      } @else {
        <p class="mt-4 text-sm text-(--text-secondary)">{{ emptyLabel() }}</p>
      }
    </section>
  `,
})
export class BrowseGrid {
  readonly kind = input.required<TaxonomyKind>();
  /** Already ranked + sliced to the top-N by the home page (`topByCount`). */
  readonly terms = input.required<readonly TaxonomyTermWithCount[]>();

  protected readonly indexPath = computed(() => `/${KIND_PATH_SEGMENT[this.kind()]}`);

  protected readonly heading = computed(() => {
    switch (this.kind()) {
      case 'category':
        return $localize`:@@home.browse.category.heading:Browse by category`;
      case 'audience':
        return $localize`:@@home.browse.audience.heading:Browse by audience`;
      case 'phase':
        return $localize`:@@home.browse.phase.heading:Browse by project phase`;
    }
  });

  protected readonly viewAllLabel = computed(() => {
    switch (this.kind()) {
      case 'category':
        return $localize`:@@home.browse.category.viewAll:View all categories`;
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
      case 'audience':
        return $localize`:@@home.browse.audience.empty:No audiences to browse yet.`;
      case 'phase':
        return $localize`:@@home.browse.phase.empty:No project phases to browse yet.`;
    }
  });
}
