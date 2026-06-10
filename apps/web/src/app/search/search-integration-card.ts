import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { AlgoliaIntegrationRecord } from '@aeci/shared/algolia-records';

import { directionLabel, mechanismKindLabel } from './mechanism-labels';

/**
 * Grid hit card for an `integrations` search result (AECI-142). `<article>` tile
 * bound to the denormalized §7.1 integration record. Integrations are keyed by
 * record ID, not slug (Phase 2 Spec §6.5), so the stretched link targets
 * `/integrations/:objectID`. The `"{source} → {target}"` headline + mechanism /
 * direction badges reuse the shared `mechanism-labels` so the labels match the
 * `/integrations` table exactly. The index is empty until AECI-86 re-enables
 * integration seeding — until then this card simply never renders (the tab shows
 * its empty state). Both themes via tokens; strings `$localize`-wrapped.
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
          [routerLink]="['/integrations', record().objectID]"
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

  protected readonly mechanismLabel = computed(() =>
    mechanismKindLabel(this.record().mechanism_kind),
  );
  protected readonly direction = computed(() => directionLabel(this.record().direction));
}
