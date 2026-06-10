import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { AlgoliaProductRecord } from '@aeci/shared/algolia-records';

/**
 * Grid hit card for a `products` search result (AECI-142). Unlike the
 * `/products` table row (`products/product-card.ts`, a `<tr>`), this is an
 * `<article>` tile for the faceted `/search` results grid, bound to the
 * denormalized §7.1 Algolia record (no follow-up fetch — every display field is
 * on the hit).
 *
 * The product name is the single stretched link (`::after` overlay) to
 * `/products/:slug`, so the whole tile is one click target with one accessible
 * name. Vendor + taxonomy render as NON-link text: the records carry taxonomy
 * **names**, not slugs, so a chip can't link to `/categories/:slug` (a possible
 * follow-up). Both themes via tokens; every string is `$localize`-wrapped.
 */
@Component({
  selector: 'aec-search-product-card',
  imports: [RouterLink],
  host: { class: 'block h-full' },
  template: `
    <article
      class="group relative flex h-full flex-col rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-5 transition-colors hover:border-(--border-strong)"
    >
      <div class="flex items-start gap-3">
        <span
          class="flex h-9 w-9 shrink-0 items-center justify-center rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) font-display text-sm font-semibold text-(--text-secondary)"
          aria-hidden="true"
          >{{ initial() }}</span
        >
        <div class="min-w-0 flex-1">
          <h3 class="font-display text-base font-semibold tracking-tight text-(--text-primary)">
            <a
              [routerLink]="['/products', record().slug]"
              class="rounded-sm transition-colors after:absolute after:inset-0 group-hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              >{{ record().name }}</a
            >
          </h3>
          @if (record().vendor_name; as vendorName) {
            <p class="mt-0.5 truncate text-sm text-(--text-secondary)">{{ vendorName }}</p>
          }
        </div>
        <span
          class="shrink-0 rounded-(--radius-sm) bg-(--surface-base) px-2 py-0.5 text-xs font-medium tabular-nums text-(--text-secondary)"
          i18n="@@search.product.integrationCount"
          >{{ record().integration_count }} integrations</span
        >
      </div>

      @if (record().description; as description) {
        <p class="mt-3 line-clamp-2 text-sm leading-relaxed text-(--text-secondary)">
          {{ description }}
        </p>
      }

      @if (chips().length) {
        <ul class="mt-4 flex flex-wrap gap-1.5">
          @for (chip of chips(); track chip) {
            <li
              class="rounded-(--radius-sm) border border-(--border-default) px-2 py-0.5 text-xs text-(--text-secondary)"
            >
              {{ chip }}
            </li>
          }
        </ul>
      }
    </article>
  `,
})
export class SearchProductCard {
  readonly record = input.required<AlgoliaProductRecord>();

  protected readonly initial = computed(() => [...this.record().name][0]?.toUpperCase() ?? '');

  /** Up to four taxonomy names (categories first), for the chip row. */
  protected readonly chips = computed(() => {
    const r = this.record();
    return [...r.categories, ...r.audiences, ...r.phases].slice(0, 4);
  });
}
