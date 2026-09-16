import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Public account-status label driven by the legacy `vendors.verified` mirror.
 *
 * The field name predates the entitlement model. It now means that the vendor
 * has an active account arrangement and can manage its AECi profile. It does
 * not verify a product, an integration claim, or the quality of either.
 *
 * Both variants carry visible text. The compact label is shorter for product
 * and pair-page rows, but it never falls back to a glyph or an accessible name
 * that sighted readers cannot inspect.
 */
@Component({
  selector: 'aec-vendor-account-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (active()) {
      <span
        class="inline-flex w-fit items-center whitespace-nowrap rounded-(--radius-sm) border
          border-(--border-strong) bg-(--surface-base) font-semibold tracking-[0.01em]
          text-(--text-secondary)"
        [class]="sizeClass()"
        [title]="tooltip()"
      >
        @if (variant() === 'full') {
          <span i18n="@@vendor.accountBadge.full">Vendor account active</span>
        } @else {
          <span i18n="@@vendor.accountBadge.compact">Account active</span>
        }
      </span>
    }
  `,
  styles: `
    :host {
      display: contents;
    }
  `,
})
export class VendorAccountBadge {
  /** The legacy `vendors.verified` mirror. The label renders only when true. */
  readonly active = input.required<boolean>();
  readonly variant = input<'full' | 'compact'>('full');

  protected readonly tooltip = computed<string>(
    () =>
      $localize`:@@vendor.accountBadge.tooltip:This vendor has active access to manage its AECi profile. This does not verify product quality or integration accuracy, and it does not affect ranking or placement.`,
  );

  protected readonly sizeClass = computed<string>(() =>
    this.variant() === 'full' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-xs',
  );
}
