import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type { CategoriesListResponse, TaxonomyTermWithCount } from '@aeci/shared';

import { KIND_PATH_SEGMENT } from '../core/api/taxonomy';
import { MailingListSignup } from '../shared/mailing-list-signup/mailing-list-signup';
import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

/**
 * AECI-157 — shared flat index for `/categories`, `/audiences`, and `/phases`.
 * One component drives all three routes; the facet `kind` arrives via static
 * `route.data` and the resolved list via `route.data['terms']` (populated by the
 * matching `*IndexResolver`). Generalizes the original AECI-61 `/categories`
 * page so the three facets share one template, mirroring `TaxonomyBrowsePage`.
 *
 * Every term renders as an editorial card linking to its `/{segment}/:slug`
 * browse page. Not a sortable table (cf. `/products`) — the taxonomy is small
 * (≈30 terms) and reads better as cards. Generic chrome uses shared
 * `@@taxonomy.index.*` ids; the facet-specific copy (title / lede / empty) is a
 * per-kind `$localize` switch, the same pattern `TaxonomyBrowsePage` uses for
 * its breadcrumb labels. Cache discipline: `cacheTagInputsForPath` emits
 * `route:index`, `index:{segment}`, `taxonomy`; nothing here triggers HTTP.
 */
@Component({
  selector: 'aec-taxonomy-index',
  imports: [RouterLink, MailingListSignup],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <div class="mx-auto w-full max-w-7xl px-6 py-8 md:px-8 md:py-12">
        <header class="mb-8 border-b border-(--border-default) pb-6 md:mb-12 md:pb-8">
          <nav i18n-aria-label="@@taxonomy.index.breadcrumbs.aria" aria-label="Breadcrumb">
            <ol
              class="flex items-center gap-2 text-xs tracking-wide uppercase text-(--text-secondary)"
            >
              <li>
                <a
                  routerLink="/"
                  class="rounded-sm transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  i18n="@@taxonomy.index.breadcrumbs.home"
                  >Home</a
                >
              </li>
              <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
              <li class="text-(--text-primary)" aria-current="page">{{ title() }}</li>
            </ol>
          </nav>
          <h1 class="mt-3 font-display text-4xl font-semibold tracking-tight md:text-5xl">
            {{ title() }}
          </h1>
          <p class="mt-3 max-w-prose text-(--text-secondary)">{{ lede() }}</p>
        </header>

        @if (terms().length > 0) {
          <ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            @for (term of terms(); track term.id) {
              <li>
                <a
                  [routerLink]="[basePath(), term.slug]"
                  class="flex h-full flex-col rounded-(--radius-lg) border border-(--border-default)
                    bg-(--surface-raised) p-5 text-(--text-primary) no-underline transition-colors
                    hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2
                    focus-visible:outline-(--accent-primary)"
                >
                  <span class="font-display text-lg font-semibold tracking-tight">{{
                    term.name
                  }}</span>
                  @if (term.description) {
                    <span
                      class="mt-2 line-clamp-3 text-sm leading-relaxed text-(--text-secondary)"
                      >{{ term.description }}</span
                    >
                  }
                  <span class="mt-4 text-sm font-bold text-(--text-secondary) tabular-nums">{{
                    countLabel(term.product_count)
                  }}</span>
                </a>
              </li>
            }
          </ul>
        } @else {
          <p
            class="rounded-(--radius-lg) border border-dashed border-(--border-default)
              bg-(--surface-sunken) p-6 text-sm text-(--text-secondary)"
          >
            {{ emptyLabel() }}
          </p>
        }
      </div>
    </div>

    <aec-mailing-list-signup />
  `,
})
export class TaxonomyIndexPage {
  private readonly route = inject(ActivatedRoute);

  /** Facet kind for this route — static `data: { kind }` in `app.routes.ts`. */
  protected readonly kind = computed<TaxonomyKind>(
    () => this.route.snapshot.data['kind'] as TaxonomyKind,
  );

  protected readonly basePath = computed(() => `/${KIND_PATH_SEGMENT[this.kind()]}`);

  private readonly response = toSignal<
    CategoriesListResponse | null,
    CategoriesListResponse | null
  >(this.route.data.pipe(map((d) => (d['terms'] ?? null) as CategoriesListResponse | null)), {
    initialValue: (this.route.snapshot.data['terms'] ?? null) as CategoriesListResponse | null,
  });

  protected readonly terms = computed<ReadonlyArray<TaxonomyTermWithCount>>(
    () => this.response()?.data ?? [],
  );

  /** Facet-specific page title (also the breadcrumb current label). */
  protected readonly title = computed(() => {
    switch (this.kind()) {
      case 'category':
        return $localize`:@@categories.index.title:Categories`;
      case 'audience':
        return $localize`:@@audiences.index.title:Audiences`;
      case 'phase':
        return $localize`:@@phases.index.title:Phases`;
    }
  });

  protected readonly lede = computed(() => {
    switch (this.kind()) {
      case 'category':
        return $localize`:@@categories.index.lede:Browse AEC software by category. Each links to the products tagged with it.`;
      case 'audience':
        return $localize`:@@audiences.index.lede:Browse AEC software by audience: the disciplines and roles each tool serves.`;
      case 'phase':
        return $localize`:@@phases.index.lede:Browse AEC software by project phase, from design through closeout.`;
    }
  });

  protected readonly emptyLabel = computed(() => {
    switch (this.kind()) {
      case 'category':
        return $localize`:@@categories.index.empty:No categories yet. Check back soon.`;
      case 'audience':
        return $localize`:@@audiences.index.empty:No audiences yet. Check back soon.`;
      case 'phase':
        return $localize`:@@phases.index.empty:No phases yet. Check back soon.`;
    }
  });

  protected countLabel(count: number): string {
    return $localize`:@@taxonomy.index.card.count:${count}:INTERPOLATION: products`;
  }
}
