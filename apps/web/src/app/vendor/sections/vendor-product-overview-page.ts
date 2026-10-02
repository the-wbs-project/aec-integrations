import { Component, PLATFORM_ID, computed, effect, inject, untracked } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

import { productChecklistRows } from '../checklist-rows';
import { VendorChecklist } from '../components/vendor-checklist';
import { VendorPlanPanel } from '../components/vendor-plan-panel';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorPortalStore } from '../vendor-portal-store';

import { vendorProductContext } from './vendor-product-context';

/**
 * `…/products/:productSlug/overview` (AECI-1218, `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §6.18): one product's checklist beside its own plan panel. Plans and
 * checklists live at the product level (decision 2), so this is where a vendor
 * sees what this product's plan includes and what is left to check.
 *
 * The checklist is `GET /api/vendor/products/:id/checklist`, held in the store
 * so the live cursor refetches it when `profile`, `entitlement`, `products` or
 * `integrations` moves (`STAGE_2_REALTIME_SPEC.md` §2.3). It loads in the browser
 * only, after first paint: SSR paints the plan panel, which needs no request.
 *
 * The plan panel reads `product.plan` (§13.7), never `me().entitlement`.
 */
@Component({
  selector: 'aec-vendor-product-overview-page',
  imports: [VendorChecklist, VendorPlanPanel],
  template: `
    @if (product(); as p) {
      <div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div>
          @if (checklist(); as c) {
            <aec-vendor-checklist
              [heading]="checklistHeading"
              headingId="vendor-product-checklist-h"
              [lede]="checklistLede()"
              [rows]="rows()"
              [done]="c.done"
              [total]="c.total"
            />
          } @else if (failed()) {
            <div
              class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-5"
            >
              <p
                class="text-sm text-(--text-primary)"
                role="alert"
                i18n="@@vendor.checklist.failed"
              >
                The checklist could not be loaded.
              </p>
              <button
                type="button"
                [class]="retryClass"
                (click)="retry()"
                i18n="@@vendor.checklist.retry"
              >
                Try again
              </button>
            </div>
          } @else {
            <div
              class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-5"
              aria-busy="true"
            >
              <p class="text-sm text-(--text-secondary)" i18n="@@vendor.checklist.loading">
                Loading the checklist…
              </p>
            </div>
          }
        </div>
        <aec-vendor-plan-panel
          [plan]="p.plan"
          [productRole]="p.product_role"
          headingId="vendor-product-plan-h"
        />
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorProductOverviewPage {
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly ctx = vendorProductContext();
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));

  protected readonly product = this.ctx.product;

  protected readonly checklist = computed(() => {
    const p = this.product();
    return p ? (this.store.productChecklists().get(p.id) ?? null) : null;
  });

  protected readonly failed = computed(() => {
    const p = this.product();
    return p ? this.store.productChecklistStatusOf(p.id) === 'failed' : false;
  });

  protected readonly rows = computed(() => {
    const c = this.checklist();
    const p = this.product();
    return c && p ? productChecklistRows(c, p) : [];
  });

  protected readonly checklistHeading = $localize`:@@vendor.checklist.product.heading:Product checklist`;

  /** The steps that count differ by plan, so the lede says which. */
  protected readonly checklistLede = computed(() => {
    const c = this.checklist();
    if (!c) return null;
    return c.steps.some((s) => s.key === 'confirm_data_flows' && s.counts)
      ? $localize`:@@vendor.checklist.product.lede.managed:Four checks for this product on Managed. All four count.`
      : $localize`:@@vendor.checklist.product.lede.free:Three checks finish this product on Free. Confirming data flows is optional until Managed.`;
  });

  protected readonly retryClass =
    'mt-3 inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-3 py-1.5 text-sm font-semibold text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  constructor() {
    // Load per product. Moving between products reuses this component, so the
    // product id is tracked rather than read once. Browser only: the read needs
    // the session cookie, and SSR paints without it.
    effect(() => {
      const id = this.product()?.id;
      if (!id || !this.browser) return;
      untracked(() => void this.store.ensureProductChecklist(id));
    });
  }

  protected retry(): void {
    const id = this.product()?.id;
    if (!id) return;
    void this.store.reloadProductChecklist(id).then(() => {
      if (this.store.productChecklistStatusOf(id) !== 'failed') {
        this.announcer.announce(
          $localize`:@@vendor.checklist.reloaded:The checklist is up to date.`,
        );
      }
    });
  }
}
