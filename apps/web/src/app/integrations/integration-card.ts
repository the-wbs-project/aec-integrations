import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { defaultIntegrationContext, type IntegrationListItem } from '@aeci/shared';

import { directionLabel, mechanismKindLabel } from '../search/mechanism-labels';

/**
 * Row representation of an `IntegrationListItem`, slotted into `IndexLayout`'s
 * `table-body` slot. Uses an attribute selector on `<tr>` so the rendered
 * markup is a valid `<tr>` child of `<tbody>` (same pattern as `VendorCard` /
 * `ProductCard` and Angular CDK's `tr[cdk-row]`).
 *
 * AECI-60 — the third card primitive. Renders three cells: the
 * `"{source} → {target}"` headline, the `mechanism_kind` badge, and the
 * direction label. AECI-298 (Stage 1.5) — the headline links to the canonical
 * product-PAIR page `/products/:context/integrations/:other` (context =
 * alphabetically-first slug via `defaultIntegrationContext`), matching the
 * `IntegrationTile` precedent, rather than the retired `/integrations/:id`
 * detail route (which now 301-redirects to the same pair page).
 */
@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'tr[aec-integration-card]',
  imports: [RouterLink],
  host: {
    class:
      'text-(--text-primary) transition-colors hover:bg-(--surface-muted) focus-within:bg-(--surface-muted)',
  },
  template: `
    <td class="px-4 py-3 font-medium">
      <a
        [routerLink]="pairLink()"
        class="rounded-sm transition-colors hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      >
        {{ integration().source.name }}
        <span class="text-(--text-tertiary) inline-block rtl:-scale-x-100" aria-hidden="true"
          >→</span
        >
        {{ integration().target.name }}
      </a>
    </td>
    <td class="px-4 py-3 text-(--text-secondary)">
      @if (mechanismKindLabel(); as label) {
        <span
          class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default) bg-(--surface-raised) px-2.5 py-0.5 text-xs font-bold tracking-[0.01em]"
        >
          {{ label }}
        </span>
      } @else {
        <span
          class="text-(--text-secondary)"
          i18n="@@integrations.card.mechanism.none"
          i18n-aria-label="@@integrations.card.mechanism.none.aria"
          aria-label="Mechanism not listed"
          >–</span
        >
      }
    </td>
    <td class="px-4 py-3 text-(--text-secondary)">
      @if (directionLabel()) {
        {{ directionLabel() }}
      } @else {
        <span
          class="text-(--text-secondary)"
          i18n="@@integrations.card.direction.none"
          i18n-aria-label="@@integrations.card.direction.none.aria"
          aria-label="Direction not listed"
          >–</span
        >
      }
    </td>
  `,
})
export class IntegrationCard {
  readonly integration = input.required<IntegrationListItem>();

  /** RouterLink to the canonical product-PAIR page for this integration's two
   *  products (context = alphabetically-first slug). Matches `IntegrationTile`. */
  protected readonly pairLink = computed(() => {
    const i = this.integration();
    const context = defaultIntegrationContext(i.source.slug, i.target.slug);
    const other = context === i.source.slug ? i.target.slug : i.source.slug;
    return ['/products', context, 'integrations', other];
  });

  // Labels are shared with the /search integration hit card via
  // `search/mechanism-labels.ts` (AECI-142) so the `$localize` id set can't
  // drift between the two surfaces.
  protected readonly mechanismKindLabel = computed(() =>
    mechanismKindLabel(this.integration().mechanism_kind),
  );

  protected readonly directionLabel = computed(() => directionLabel(this.integration().direction));
}
