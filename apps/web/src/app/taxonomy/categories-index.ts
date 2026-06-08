import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type { CategoriesListResponse, TaxonomyTermWithCount } from '@aeci/shared';

/**
 * AECI-61 — `/categories` flat list. Every category with its product count,
 * rendered as an editorial card grid (each card links to the
 * `/categories/:slug` browse page). Data is supplied by
 * `categoriesIndexResolver` via `route.data['categories']`.
 *
 * Not a sortable table (cf. `/products`, `/vendors`) — the taxonomy is small
 * (≈30 terms) and reads better as cards. Cache discipline: `cacheTagInputsForPath`
 * emits `route:index`, `index:categories`, `taxonomy`; nothing here triggers HTTP.
 */
@Component({
  selector: 'aec-categories-index',
  imports: [RouterLink],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <div class="mx-auto w-full max-w-7xl px-6 py-8 md:px-8 md:py-12">
        <header class="mb-8 border-b border-(--border-default) pb-6 md:mb-12 md:pb-8">
          <nav i18n-aria-label="@@categories.index.breadcrumbs.aria" aria-label="Breadcrumb">
            <ol
              class="flex items-center gap-2 text-xs tracking-wide uppercase text-(--text-secondary)"
            >
              <li>
                <a
                  routerLink="/"
                  class="rounded-sm transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  i18n="@@categories.index.breadcrumbs.home"
                  >Home</a
                >
              </li>
              <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
              <li
                class="text-(--text-primary)"
                aria-current="page"
                i18n="@@categories.index.breadcrumbs.current"
              >
                Categories
              </li>
            </ol>
          </nav>
          <h1
            class="mt-3 font-display text-4xl font-semibold tracking-tight md:text-5xl"
            i18n="@@categories.index.title"
          >
            Categories
          </h1>
          <p class="mt-3 max-w-prose text-(--text-secondary)" i18n="@@categories.index.lede">
            Browse AEC software by category. Each links to the products tagged with it.
          </p>
        </header>

        @if (categories().length > 0) {
          <ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            @for (category of categories(); track category.id) {
              <li>
                <a
                  [routerLink]="['/categories', category.slug]"
                  class="flex h-full flex-col rounded-(--radius-lg) border border-(--border-default)
                    bg-(--surface-raised) p-5 text-(--text-primary) no-underline transition-colors
                    hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2
                    focus-visible:outline-(--accent-primary)"
                >
                  <span class="font-display text-lg font-semibold tracking-tight">{{
                    category.name
                  }}</span>
                  @if (category.description) {
                    <span
                      class="mt-2 line-clamp-3 text-sm leading-relaxed text-(--text-secondary)"
                      >{{ category.description }}</span
                    >
                  }
                  <span class="mt-4 text-sm font-bold text-(--text-secondary) tabular-nums">{{
                    countLabel(category.product_count)
                  }}</span>
                </a>
              </li>
            }
          </ul>
        } @else {
          <p
            class="rounded-(--radius-lg) border border-dashed border-(--border-default)
              bg-(--surface-sunken) p-6 text-sm text-(--text-secondary)"
            i18n="@@categories.index.empty"
          >
            No categories yet. Check back soon.
          </p>
        }
      </div>
    </div>
  `,
})
export class CategoriesIndex {
  private readonly route = inject(ActivatedRoute);

  private readonly response = toSignal<
    CategoriesListResponse | null,
    CategoriesListResponse | null
  >(this.route.data.pipe(map((d) => (d['categories'] ?? null) as CategoriesListResponse | null)), {
    initialValue: (this.route.snapshot.data['categories'] ?? null) as CategoriesListResponse | null,
  });

  protected readonly categories = computed<ReadonlyArray<TaxonomyTermWithCount>>(
    () => this.response()?.data ?? [],
  );

  protected countLabel(count: number): string {
    return $localize`:@@categories.index.card.count:${count}:INTERPOLATION: products`;
  }
}
