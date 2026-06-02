import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { IntegrationListItem } from '@aeci/shared';

/**
 * Row representation of an `IntegrationListItem`, slotted into `IndexLayout`'s
 * `table-body` slot. Uses an attribute selector on `<tr>` so the rendered
 * markup is a valid `<tr>` child of `<tbody>` (same pattern as `VendorCard` /
 * `ProductCard` and Angular CDK's `tr[cdk-row]`).
 *
 * AECI-60 — the third card primitive. Renders three cells: the
 * `"{source} → {target}"` headline (linked to `/integrations/:id`, since
 * integrations are keyed by ID not slug — Phase 2 Spec §6.5), the
 * `mechanism_kind` badge, and the direction label.
 */
@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'tr[aec-integration-card]',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'text-(--text-primary) transition-colors hover:bg-(--surface-muted) focus-within:bg-(--surface-muted)',
  },
  template: `
    <td class="px-4 py-3 font-medium">
      <a
        [routerLink]="['/integrations', integration().id]"
        class="rounded-sm transition-colors hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      >
        {{ integration().source.name }}
        <span class="text-(--text-tertiary)" aria-hidden="true">→</span>
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
          class="text-(--text-tertiary)"
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
          class="text-(--text-tertiary)"
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

  protected readonly mechanismKindLabel = computed(() => {
    switch (this.integration().mechanism_kind) {
      case 'native':
        return $localize`:@@integrations.mechanism.native:Native`;
      case 'iPaaS':
        return $localize`:@@integrations.mechanism.ipaas:iPaaS`;
      case 'marketplace-app':
        return $localize`:@@integrations.mechanism.marketplaceApp:Marketplace app`;
      case 'api':
        return $localize`:@@integrations.mechanism.api:API`;
      case 'webhook':
        return $localize`:@@integrations.mechanism.webhook:Webhook`;
      case 'partner':
        return $localize`:@@integrations.mechanism.partner:Partner`;
      default:
        return '';
    }
  });

  protected readonly directionLabel = computed(() => {
    switch (this.integration().direction) {
      case 'one-way':
        return $localize`:@@integrations.direction.oneWay:One-way`;
      case 'bidirectional':
        return $localize`:@@integrations.direction.bidirectional:Bidirectional`;
      default:
        return '';
    }
  });
}
