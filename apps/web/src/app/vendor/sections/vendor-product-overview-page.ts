import { Component, PLATFORM_ID, computed, effect, inject, untracked } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';

import { AecButton } from '../../shared/button/button';
import { AecCard } from '../../shared/card/card';
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
  imports: [AecButton, AecCard, VendorChecklist, VendorPlanPanel],
  template: `
    @if (product(); as p) {
      <!-- AECI-1810: the checklist and the plan panel as two white cards, the plan
           in a 400px column (432px from 1280px), the overview's own split. -->
      <div
        class="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,25rem)] xl:grid-cols-[minmax(0,1fr)_minmax(0,27rem)] xl:gap-12"
      >
        <div class="min-w-0">
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
            <div aecCard class="p-6">
              <p
                class="text-sm text-(--text-primary)"
                role="alert"
                i18n="@@vendor.checklist.failed"
              >
                The checklist could not be loaded.
              </p>
              <button
                aecButton
                variant="secondary"
                type="button"
                class="mt-4"
                (click)="retry()"
                i18n="@@vendor.checklist.retry"
              >
                Try again
              </button>
            </div>
          } @else {
            <div aecCard class="p-6" aria-busy="true">
              <p class="text-sm text-(--text-secondary)" i18n="@@vendor.checklist.loading">
                Loading the checklist…
              </p>
            </div>
          }
        </div>
        <aec-vendor-plan-panel
          [plan]="p.plan"
          [productRole]="p.product_role"
          [connectorKind]="p.connector_kind"
          [connectorCatalogManagedBy]="p.connector_catalog_managed_by"
          [billingLink]="billingLink()"
          [electionProductId]="store.me()?.seat_owner === true ? p.id : null"
          headingId="vendor-product-plan-h"
        />
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorProductOverviewPage {
  protected readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly ctx = vendorProductContext();
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));

  protected readonly product = this.ctx.product;

  /**
   * The Billing tab's URL for an owner seat, `null` for a member (AECI-1408,
   * ruling 4). Built from the portal route above the product route, so it is
   * `/vendor/:slug/billing` on the portal and the preview's own Billing path
   * in the preview, with no "am I previewing" branch.
   */
  private readonly billingUrl = billingUrlFrom(inject(Router), inject(ActivatedRoute));
  protected readonly billingLink = computed(() =>
    this.store.me()?.seat_owner === true ? this.billingUrl : null,
  );

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

  /** The lede counts the steps that count. Since AECI-2038 all four count on every
   *  plan, so it names no plan. */
  protected readonly checklistLede = computed(() => {
    const c = this.checklist();
    if (!c) return null;
    return c.steps.some((s) => s.key === 'confirm_data_flows' && s.counts)
      ? $localize`:@@vendor.checklist.product.lede.all:Four checks for this product. All four count.`
      : $localize`:@@vendor.checklist.product.lede.three:Three checks for this product.`;
  });

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

/**
 * The Billing tab under the portal route: the parent of the route that declares
 * `:productSlug`. `null` when no such route is above this one (a spec host).
 */
function billingUrlFrom(router: Router, route: ActivatedRoute): string | null {
  for (let r: ActivatedRoute | null = route; r; r = r.parent) {
    if (r.routeConfig?.path?.includes(':productSlug') && r.parent) {
      return router.serializeUrl(router.createUrlTree(['billing'], { relativeTo: r.parent }));
    }
  }
  return null;
}
