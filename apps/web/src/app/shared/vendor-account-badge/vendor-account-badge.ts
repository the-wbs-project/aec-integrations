import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Account-status label driven by the legacy `vendors.verified` mirror.
 *
 * The field name predates the entitlement model. It now means that the vendor
 * has an active account arrangement and can manage its AECi profile. It does
 * not verify a product, an integration claim, or the quality of either.
 *
 * The label reads "Active on AECi" everywhere (AECI-1131), so the vendor's plan
 * panel shows exactly what the public sees (`STAGE_2_PAID_TIERS_SPEC.md` §8.1).
 * - `public` (vendor detail hero) follows it with a visible "What this means"
 *   link to the help article. The link replaces the hover-only `title` tooltip
 *   that touch and keyboard readers never saw.
 * - `portal` (the vendor's own plan panel) omits the link, because the panel
 *   carries the framing sentence itself.
 *
 * The label renders nowhere else. Pair rails, the product-page vendor card and
 * vendor search cards dropped it, because a reader comparing products gains
 * nothing from a vendor's plan state.
 */
@Component({
  selector: 'aec-vendor-account-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    @if (active()) {
      <span class="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          class="inline-flex w-fit items-center whitespace-nowrap rounded-(--radius-sm) border
            border-(--border-strong) bg-(--surface-base) px-2.5 py-1 text-xs font-semibold
            tracking-[0.01em] text-(--text-secondary)"
        >
          <span i18n="@@vendor.accountBadge.label">Active on AECi</span>
        </span>
        @if (variant() === 'public') {
          <a
            routerLink="/docs/vendors/plans-and-the-account-label"
            class="rounded-(--radius-sm) text-xs text-(--text-secondary) underline
              underline-offset-2 transition-colors hover:text-(--text-primary)
              focus-visible:outline-2 focus-visible:outline-offset-2
              focus-visible:outline-(--accent-primary)"
            i18n="@@vendor.accountBadge.explain"
            >What this means<span class="sr-only">: the Active on AECi label</span></a
          >
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
  readonly variant = input<'public' | 'portal'>('public');
}
