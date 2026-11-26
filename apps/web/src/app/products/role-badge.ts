import { Component, computed, input } from '@angular/core';

import type { ProductRole } from '@aeci/shared';
import { connectorKindFor } from '@aeci/shared/api/connector-kind';

import { Chip } from '../shared/chip/chip';
import { connectorKindLabel } from './connector-kind-labels';

/**
 * A small chip for a product's `product_role`, rendered ONLY for `connector` /
 * `hybrid`. The default `application` role renders nothing: most products are
 * applications, so badging every one of them is noise — the chip earns
 * attention precisely because it appears selectively (an integration platform /
 * hybrid stands out).
 *
 * Bordered chip, not a fill (DESIGN.md "Borders-Not-Shadows"); sentence case;
 * `--text-secondary` so it never competes with the product name. Used by the
 * product card grid, the `/search` product card (AECI-1086) and the
 * product-detail hero.
 *
 * Since AECI-1763 it renders `aec-chip` (default density, quiet tone). Chip metrics
 * live in the one `.aec-chip` recipe in `styles.css`, not in this component, so the
 * role chip, the maintenance marker and every other chip share one height.
 *
 * Since AECI-2037 a `connector` reads its kind: "Integration platform", "Sync Service",
 * or "Connector" when the kind is blank or absent. The words come from
 * `connector-kind-labels.ts`. Since AECI-1662 the search card passes the hit's
 * `connector_kind`; a hit indexed before then has none and keeps "Connector".
 * `hybrid` keeps "Hybrid".
 */
@Component({
  selector: 'aec-role-badge',
  imports: [Chip],
  template: `
    @if (label(); as l) {
      <aec-chip tone="quiet">{{ l }}</aec-chip>
    }
  `,
})
export class RoleBadge {
  readonly role = input.required<ProductRole>();
  /** The stored `connector_kind`. Absent on an old search hit, which reads as "Connector". */
  readonly kind = input<string | null | undefined>(null);

  protected readonly label = computed<string | null>(() => {
    switch (this.role()) {
      case 'connector':
        return connectorKindLabel(connectorKindFor(this.role(), this.kind()));
      case 'hybrid':
        return $localize`:@@products.role.hybrid:Hybrid`;
      default:
        return null;
    }
  });
}
