import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { VendorListItem } from '@aeci/shared';

/**
 * Row representation of a `VendorListItem`, slotted into `IndexLayout`'s
 * `table-body` slot. Uses an attribute selector on `<tr>` so the rendered
 * markup is a valid `<tr>` child of `<tbody>` (per HTML parsing rules a
 * custom element directly inside `<tbody>` would be moved out by the
 * browser's tree builder — same pattern as Angular CDK's `tr[cdk-row]`).
 *
 * Phase 2 Spec §11.2 calls this primitive `VendorCard` (parallel to
 * `ProductCard`). Renders four cells: company name (linked to
 * `/vendors/:slug`), headquarters (free text or `—`), founded year (or
 * `—`), product count.
 */
@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'tr[aec-vendor-card]',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'text-(--text-primary) transition-colors hover:bg-(--surface-muted) focus-within:bg-(--surface-muted)',
  },
  template: `
    <td class="px-4 py-3 font-medium">
      <a
        [routerLink]="['/vendors', vendor().slug]"
        class="rounded-sm transition-colors hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        >{{ vendor().company_name }}</a
      >
    </td>
    <td class="px-4 py-3 text-(--text-secondary)">
      @if (headquarters()) {
        {{ headquarters() }}
      } @else {
        <span
          class="text-(--text-tertiary)"
          i18n="@@vendors.card.hq.none"
          i18n-aria-label="@@vendors.card.hq.none.aria"
          aria-label="Headquarters not listed"
          >—</span
        >
      }
    </td>
    <td class="px-4 py-3 text-(--text-secondary) tabular-nums">
      @if (foundedYear() !== null) {
        {{ foundedYear() }}
      } @else {
        <span
          class="text-(--text-tertiary)"
          i18n="@@vendors.card.founded.none"
          i18n-aria-label="@@vendors.card.founded.none.aria"
          aria-label="Founded year not listed"
          >—</span
        >
      }
    </td>
    <td class="px-4 py-3 text-right text-(--text-secondary) tabular-nums">
      {{ vendor().product_count }}
    </td>
  `,
})
export class VendorCard {
  readonly vendor = input.required<VendorListItem>();

  protected readonly headquarters = computed(() => this.vendor().headquarters);
  protected readonly foundedYear = computed(() => this.vendor().founded_year);
}
