import { Component, computed, input } from '@angular/core';

import { connectorKindFor } from '@aeci/shared/api/connector-kind';

import { Chip } from '../shared/chip/chip';

import { connectorZeroStatLabel } from './connector-kind-labels';

/**
 * Renders a product's `integration_count` as a deliberate metric (the
 * directory's whole thesis is "which tools connect to what"), with graceful
 * zero handling: a `0` never renders as a stark digit — it becomes "Not yet
 * connected" so an empty product reads as a state, not a failure.
 *
 * Two visual weights via `variant`:
 *   - `inline` the number and its noun on one line (table cells, the wide
 *     lead card), so every table row is the same height (AECI-1793)
 *   - `badge`  a quiet chip with a link glyph (card grid top-right). At zero
 *     the words take the chip's 32px line, so the card's top row keeps its height
 *
 * A `connector` at zero reads "No integrations delivered yet" or "No integrations powered
 * yet" by kind (`connectorZeroStatLabel`, QA pass on AECI-2035): "Not yet connected" is
 * false of a product whose job is to connect others. A caller that knows the role passes
 * `role` and `kind`. Without them the words are the application's.
 *
 * Pluralization is handled in the component (1 → "integration", n →
 * "integrations") rather than ICU in the template, keeping the markup readable.
 * Both themes via tokens (§11.4). The glyph is the `aec-icon` "link" drawing
 * (DESIGN.md: the aec-icon set, no emoji) and is `aria-hidden` — the visible number +
 * noun carry the meaning for assistive tech.
 */
export type IntegrationStatVariant = 'inline' | 'badge';

@Component({
  selector: 'aec-integration-stat',
  imports: [Chip],
  template: `
    @if (count() > 0) {
      @if (variant() === 'badge') {
        <aec-chip tone="quiet" icon="link">
          <span class="tabular-nums">{{ count() }}</span> {{ noun() }}
        </aec-chip>
      } @else {
        <span class="inline-flex items-baseline gap-2 leading-[1.2] whitespace-nowrap">
          <span
            class="font-display text-t-20 leading-[1.1] font-semibold tabular-nums text-(--text-primary)"
            >{{ count() }}</span
          >&ngsp;<span class="text-t-13 text-(--text-secondary)">{{ noun() }}</span>
        </span>
      }
    } @else if (connectorZero(); as words) {
      <span class="text-t-13 text-(--text-secondary)" [class.leading-8]="variant() === 'badge'">{{
        words
      }}</span>
    } @else {
      <span
        class="text-t-13 text-(--text-secondary)"
        [class.leading-8]="variant() === 'badge'"
        i18n="@@products.stat.none"
        >Not yet connected</span
      >
    }
  `,
})
export class IntegrationStat {
  readonly count = input.required<number>();
  readonly variant = input<IntegrationStatVariant>('inline');

  /** The product's role and kind, when the caller knows them. */
  readonly role = input<string | null | undefined>(null);
  readonly kind = input<string | null | undefined>(null);

  protected readonly noun = computed(() => integrationNoun(this.count()));

  /** A connector's zero words, or `null` for every other product. */
  protected readonly connectorZero = computed(() => {
    const role = this.role();
    if (role !== 'connector') return null;
    return connectorZeroStatLabel(connectorKindFor(role, this.kind()));
  });
}

/**
 * "integration" or "integrations" for a count. One definition, so the stat and the
 * product facts card (AECI-1779) print the same words from the same message ids.
 */
export function integrationNoun(count: number): string {
  return count === 1
    ? $localize`:@@products.stat.noun.one:integration`
    : $localize`:@@products.stat.noun.other:integrations`;
}
