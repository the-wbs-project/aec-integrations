import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { AlgoliaVendorRecord } from '@aeci/shared/algolia-records';

/**
 * Grid hit card for a `vendors` search result (AECI-142). `<article>` tile bound
 * to the denormalized §7.1 vendor record. The company name is the single
 * stretched link to `/vendors/:slug`; headquarters / founded year / counts
 * render as supporting text with em-dash empty states (the record nullable
 * fields mirror the `/vendors` table card). Both themes via tokens; strings
 * `$localize`-wrapped.
 */
@Component({
  selector: 'aec-search-vendor-card',
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
              [routerLink]="['/vendors', record().slug]"
              class="rounded-sm transition-colors after:absolute after:inset-0 group-hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              >{{ record().company_name }}</a
            >
          </h3>
          @if (record().headquarters; as hq) {
            <p class="mt-0.5 truncate text-sm text-(--text-secondary)">{{ hq }}</p>
          }
        </div>
      </div>

      @if (record().description; as description) {
        <p class="mt-3 line-clamp-2 text-sm leading-relaxed text-(--text-secondary)">
          {{ description }}
        </p>
      }

      <dl class="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm text-(--text-secondary)">
        <div class="flex items-center gap-1.5">
          <dt i18n="@@search.vendor.products">Products</dt>
          <dd class="font-medium tabular-nums text-(--text-primary)">
            {{ record().product_count }}
          </dd>
        </div>
        <div class="flex items-center gap-1.5">
          <dt i18n="@@search.vendor.integrations">Integrations</dt>
          <dd class="font-medium tabular-nums text-(--text-primary)">
            {{ record().integration_count }}
          </dd>
        </div>
        @if (record().founded_year !== null) {
          <div class="flex items-center gap-1.5">
            <dt i18n="@@search.vendor.founded">Founded</dt>
            <dd class="font-medium tabular-nums text-(--text-primary)">
              {{ record().founded_year }}
            </dd>
          </div>
        }
      </dl>
    </article>
  `,
})
export class SearchVendorCard {
  readonly record = input.required<AlgoliaVendorRecord>();

  protected readonly initial = computed(
    () => [...this.record().company_name][0]?.toUpperCase() ?? '',
  );
}
