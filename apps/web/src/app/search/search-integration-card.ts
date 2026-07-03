import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { defaultIntegrationContext } from '@aeci/shared';
import type { AlgoliaIntegrationRecord } from '@aeci/shared/algolia-records';

import { directionLabel, mechanismKindLabel } from './mechanism-labels';

/**
 * Grid hit card for an `integrations` search result (AECI-142). `<article>` tile
 * bound to the denormalized §7.1 integration record. AECI-298 (Stage 1.5) — the
 * stretched link targets the canonical product-PAIR page
 * `/products/:context/integrations/:other` (context = alphabetically-first slug
 * via `defaultIntegrationContext`, from the record's endpoint slugs), not the
 * retired `/integrations/:objectID` detail route (which now 301-redirects to the
 * same pair page). The `"{source} → {target}"` headline + mechanism / direction
 * badges reuse the shared `mechanism-labels` so the labels match the `/integrations`
 * table exactly. The `/search` Integrations tab is hidden (STAGE_1_SPEC.md §7.5),
 * so this card is not currently surfaced. Both themes via tokens; strings
 * `$localize`-wrapped.
 */
@Component({
  selector: 'aec-search-integration-card',
  imports: [RouterLink],
  host: { class: 'block h-full' },
  template: `
    <article
      class="group relative flex h-full flex-col rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-5 transition-colors hover:border-(--border-strong)"
    >
      <h3 class="font-display text-base font-semibold tracking-tight text-(--text-primary)">
        <a
          [routerLink]="pairLink()"
          class="rounded-sm transition-colors after:absolute after:inset-0 group-hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        >
          {{ record().source_product_name }}
          <span class="inline-block text-(--text-secondary) rtl:-scale-x-100" aria-hidden="true"
            >→</span
          >
          {{ record().target_product_name }}
        </a>
      </h3>

      @if (record().description; as description) {
        <p class="mt-3 line-clamp-2 text-sm leading-relaxed text-(--text-secondary)">
          {{ description }}
        </p>
      }

      <div class="mt-4 flex flex-wrap items-center gap-2">
        @if (mechanismLabel(); as label) {
          <span
            class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-2.5 py-0.5 text-xs font-bold tracking-[0.01em] text-(--text-secondary)"
          >
            {{ label }}
          </span>
        }
        @if (direction(); as label) {
          <span class="text-xs text-(--text-secondary)">{{ label }}</span>
        }
      </div>
    </article>
  `,
})
export class SearchIntegrationCard {
  readonly record = input.required<AlgoliaIntegrationRecord>();

  /** RouterLink to the canonical product-PAIR page for this integration's two
   *  products (context = alphabetically-first slug). Matches `IntegrationTile`. */
  protected readonly pairLink = computed(() => {
    const r = this.record();
    const context = defaultIntegrationContext(r.source_product_slug, r.target_product_slug);
    const other = context === r.source_product_slug ? r.target_product_slug : r.source_product_slug;
    return ['/products', context, 'integrations', other];
  });

  protected readonly mechanismLabel = computed(() =>
    mechanismKindLabel(this.record().mechanism_kind),
  );
  protected readonly direction = computed(() => directionLabel(this.record().direction));
}
