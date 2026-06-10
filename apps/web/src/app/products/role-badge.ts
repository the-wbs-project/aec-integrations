import { Component, computed, input } from '@angular/core';

import type { ProductRole } from '@aeci/shared';

/**
 * A small chip for a product's `product_role`, rendered ONLY for `connector` /
 * `hybrid`. The default `application` role renders nothing: most products are
 * applications, so badging every one of them is noise — the chip earns
 * attention precisely because it appears selectively (an integration platform /
 * hybrid stands out).
 *
 * Bordered chip, not a fill (DESIGN.md "Borders-Not-Shadows"); sentence case;
 * `--text-secondary` so it never competes with the product name. Both themes via
 * tokens. Used by the product card grid.
 */
@Component({
  selector: 'aec-role-badge',
  template: `
    @if (label(); as l) {
      <span
        class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default)
          bg-(--surface-raised) px-2 py-0.5 text-xs font-medium tracking-[0.01em]
          text-(--text-secondary)"
        >{{ l }}</span
      >
    }
  `,
})
export class RoleBadge {
  readonly role = input.required<ProductRole>();

  protected readonly label = computed<string | null>(() => {
    switch (this.role()) {
      case 'connector':
        return $localize`:@@products.role.connector:Connector`;
      case 'hybrid':
        return $localize`:@@products.role.hybrid:Hybrid`;
      default:
        return null;
    }
  });
}
