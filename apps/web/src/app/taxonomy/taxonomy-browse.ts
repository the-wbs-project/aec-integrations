import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

import type { TaxonomyTermDetail } from '../core/api/taxonomy';
import { BrowseLayout } from '../layouts/browse-layout';
import { NotFound } from '../not-found/not-found';
import { ProductCard } from '../products/product-card';

/**
 * AECI-61 — shared browse page for `/categories/:slug`, `/audiences/:slug`,
 * and `/phases/:slug`. One component drives all three routes; the taxonomy
 * `kind` arrives via static `route.data` and the resolved term via
 * `route.data['term']` (populated by the matching `*BrowseResolver`).
 *
 *   - `term === null` → the global `aec-not-found` shell (the resolver already
 *     set `RESPONSE_INIT.status = 404` + noindex meta).
 *   - `term` set → `BrowseLayout` with a header strip (breadcrumb + name +
 *     description + count), a Phase 3 filter-sidebar placeholder, and the
 *     matching products rendered as the same `tr[aec-product-card]` table the
 *     `/products` index uses (visual parity — AECI-61 reuses, doesn't fork).
 *
 * Cache discipline: the path matcher emits `route:browse` + `{kind}:{slug}`;
 * the resolver pushes `product:{slug}` for each shown product onto
 * `ctx.embedded`. Nothing here triggers HTTP — hydration reads `route.data`.
 */
@Component({
  selector: 'aec-taxonomy-browse',
  imports: [BrowseLayout, NotFound, ProductCard, RouterLink],
  template: `
    @let t = term();
    @if (t === null) {
      <aec-not-found />
    } @else {
      <aec-browse-layout>
        <div slot="header" class="space-y-4">
          <nav i18n-aria-label="@@taxonomy.browse.breadcrumbs.aria" aria-label="Breadcrumb">
            <ol
              class="flex flex-wrap items-center gap-2 text-xs tracking-wide uppercase text-(--text-secondary)"
            >
              <li>
                <a
                  routerLink="/"
                  class="rounded-sm transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  i18n="@@taxonomy.browse.breadcrumbs.home"
                  >Home</a
                >
              </li>
              <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
              <li>
                @if (parentLink(); as link) {
                  <a
                    [routerLink]="link"
                    class="rounded-sm transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                    >{{ parentLabel() }}</a
                  >
                } @else {
                  <span>{{ parentLabel() }}</span>
                }
              </li>
              <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
              <li class="text-(--text-primary)" aria-current="page">{{ t.name }}</li>
            </ol>
          </nav>

          <h1 class="font-display text-4xl font-semibold tracking-tight md:text-5xl">
            {{ t.name }}
          </h1>

          @if (t.description) {
            <p class="max-w-prose text-(--text-secondary)">{{ t.description }}</p>
          }

          <p class="text-sm text-(--text-tertiary)">{{ productCountLabel() }}</p>
        </div>

        <div slot="filters">
          <div
            class="rounded-(--radius-lg) border border-dashed border-(--border-default) bg-(--surface-sunken) p-4 text-sm text-(--text-tertiary)"
            aria-hidden="true"
          >
            <p class="font-bold text-(--text-secondary)" i18n="@@taxonomy.browse.filters.title">
              Filters
            </p>
            <p class="mt-1" i18n="@@taxonomy.browse.filters.placeholder">Coming soon.</p>
          </div>
        </div>

        <div slot="grid" class="overflow-x-auto">
          <table
            class="w-full min-w-[40rem] border-collapse text-left text-sm"
            i18n-aria-label="@@taxonomy.browse.table.aria"
            aria-label="Products"
          >
            <thead
              class="border-b border-(--border-default) text-xs font-medium tracking-wide text-(--text-secondary) uppercase"
            >
              <tr>
                <th scope="col" class="px-4 py-3 font-medium" i18n="@@taxonomy.browse.col.name">
                  Name
                </th>
                <th scope="col" class="px-4 py-3 font-medium" i18n="@@taxonomy.browse.col.vendor">
                  Vendor
                </th>
                <th scope="col" class="px-4 py-3 font-medium" i18n="@@taxonomy.browse.col.category">
                  Primary category
                </th>
                <th
                  scope="col"
                  class="px-4 py-3 text-right font-medium"
                  i18n="@@taxonomy.browse.col.integrations"
                >
                  Integrations
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-(--border-default)">
              @for (product of t.products; track product.id) {
                <tr aec-product-card [product]="product"></tr>
              } @empty {
                <tr>
                  <td
                    colspan="4"
                    class="px-4 py-12 text-center text-(--text-secondary)"
                    i18n="@@taxonomy.browse.empty"
                  >
                    No products tagged with this term yet. Check back soon.
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </aec-browse-layout>
    }
  `,
})
export class TaxonomyBrowsePage {
  private readonly route = inject(ActivatedRoute);

  /** Taxonomy kind for this route — static `data: { kind }` in `app.routes.ts`. */
  protected readonly kind = computed<TaxonomyKind>(
    () => this.route.snapshot.data['kind'] as TaxonomyKind,
  );

  /**
   * Resolved term. `*BrowseResolver` runs server-side and on hydration reads
   * from `TransferState`; the snapshot value is the SSR-resolved term (or null
   * on NOT_FOUND).
   */
  protected readonly term = toSignal<TaxonomyTermDetail | null, TaxonomyTermDetail | null>(
    this.route.data.pipe(map((d) => (d['term'] ?? null) as TaxonomyTermDetail | null)),
    { initialValue: (this.route.snapshot.data['term'] ?? null) as TaxonomyTermDetail | null },
  );

  /** Breadcrumb ancestor label per kind (e.g. "Categories"). */
  protected readonly parentLabel = computed(() => {
    switch (this.kind()) {
      case 'category':
        return $localize`:@@taxonomy.browse.breadcrumbs.categories:Categories`;
      case 'audience':
        return $localize`:@@taxonomy.browse.breadcrumbs.audiences:Audiences`;
      case 'phase':
        return $localize`:@@taxonomy.browse.breadcrumbs.phases:Phases`;
    }
  });

  /**
   * Breadcrumb ancestor link. Only categories have an index page (`/categories`)
   * in Stage 1; audience / phase ancestors render as plain text.
   */
  protected readonly parentLink = computed(() =>
    this.kind() === 'category' ? '/categories' : null,
  );

  protected readonly productCountLabel = computed(() => {
    const count = this.term()?.product_count ?? 0;
    return $localize`:@@taxonomy.browse.products.count:${count}:INTERPOLATION: products`;
  });
}
