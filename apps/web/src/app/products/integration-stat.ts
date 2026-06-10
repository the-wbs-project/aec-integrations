import { Component, computed, input } from '@angular/core';

/**
 * Renders a product's `integration_count` as a deliberate metric (the
 * directory's whole thesis is "which tools connect to what"), with graceful
 * zero handling: a `0` never renders as a stark digit — it becomes "Not yet
 * connected" so an empty product reads as a state, not a failure.
 *
 * Three visual weights via `variant`:
 *   - `inline`   — number stacked over its noun, right-aligned (table cell, card grid)
 *   - `badge`    — a bordered pill with a link glyph (card grid top-right)
 *   - `headline` — a large Forest figure (featured card)
 *
 * Pluralization is handled in the component (1 → "integration", n →
 * "integrations") rather than ICU in the template, keeping the markup readable.
 * Both themes via tokens (§11.4). The glyph is a hand-inlined Lucide "link" path
 * (DESIGN.md: Lucide only, no emoji) and is `aria-hidden` — the visible number +
 * noun carry the meaning for assistive tech.
 */
export type IntegrationStatVariant = 'inline' | 'badge' | 'headline';

@Component({
  selector: 'aec-integration-stat',
  template: `
    @if (count() > 0) {
      @switch (variant()) {
        @case ('headline') {
          <span class="flex items-baseline gap-2">
            <span
              class="font-display text-3xl font-semibold tabular-nums text-(--accent-primary)"
              >{{ count() }}</span
            >
            <span class="text-sm text-(--text-secondary)">{{ noun() }}</span>
          </span>
        }
        @case ('badge') {
          <span
            class="inline-flex items-center gap-1.5 rounded-(--radius-sm) border border-(--border-default)
              bg-(--surface-raised) px-2.5 py-1 text-xs font-medium text-(--text-secondary)"
          >
            <svg
              class="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            <span class="tabular-nums">{{ count() }}</span> {{ noun() }}
          </span>
        }
        @default {
          <span class="flex flex-col items-end leading-tight">
            <span class="font-display text-xl font-semibold tabular-nums text-(--text-primary)">{{
              count()
            }}</span>
            <span class="text-xs text-(--text-secondary)">{{ noun() }}</span>
          </span>
        }
      }
    } @else {
      <span class="text-xs text-(--text-secondary)" i18n="@@products.stat.none"
        >Not yet connected</span
      >
    }
  `,
})
export class IntegrationStat {
  readonly count = input.required<number>();
  readonly variant = input<IntegrationStatVariant>('inline');

  protected readonly noun = computed(() =>
    this.count() === 1
      ? $localize`:@@products.stat.noun.one:integration`
      : $localize`:@@products.stat.noun.other:integrations`,
  );
}
