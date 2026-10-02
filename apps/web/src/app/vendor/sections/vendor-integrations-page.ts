import { Component, PLATFORM_ID, computed, effect, inject, untracked } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

import { VendorIntegrationsSection } from '../components/vendor-integrations-section';
import { VendorOwnedIntegrations } from '../components/vendor-owned-integrations';
import { VendorProductConnectors } from '../components/vendor-product-connectors';
import { VendorReviewStrip } from '../components/vendor-review-strip';
import { productCan } from '../vendor-capabilities';
import { VendorPortalStore } from '../vendor-portal-store';

import { vendorProductContext } from './vendor-product-context';

/**
 * `…/products/:productSlug/integrations` — the attestation surface (AECI-606 /
 * `docs/STAGE_2_ATTESTATIONS_SPEC.md` §6), scoped to ONE product since AECI-666.
 *
 * A routed section, which preserves the property the `@switch` gave it: the
 * heavier `GET /api/vendor/integrations` read only happens once a vendor asks for
 * this section, because the component is not instantiated until the route is.
 *
 * ── WHY IT MOVED UNDER THE PRODUCT ──────────────────────────────────────────
 * It was a vendor-wide list. An integration is a thing that happens *to a
 * product*, and a vendor with a dozen products was reading one flat list to
 * answer a per-product question. The read stays vendor-wide (one call, one cursor
 * scope — see `contextProductId` on the section); only the view narrows.
 *
 * The write gate is the `attestation.author` capability on THIS product's plan
 * (`productCan`, AECI-1218 / `STAGE_2_PAID_TIERS_SPEC.md` §13.7), the same
 * capability the server's `requireCapability` asserts on the attestation and
 * version writes (AECI-623; `STAGE_2_REALTIME_SPEC.md` §6.1). It used to be the
 * `vendors.verified` mirror; the client and server halves moved in one change so
 * enabled controls can never collect a 403.
 *
 * AECI-1089 adds the owner's own rows between the two: its evidenced pairs and any
 * row on which it holds no endpoint, with a Claim action
 * (`vendor-owned-integrations.ts`). They ride the same `GET /api/vendor/integrations`
 * read, so the live cursor covers them.
 *
 * AECI-1013 adds the read-only Connectors section below the list: the connectors
 * that deliver or reach this product. It is its own per-product read, outside the
 * live cursor, and it renders nothing when no connector reaches the product.
 */
@Component({
  selector: 'aec-vendor-integrations-page',
  imports: [
    VendorIntegrationsSection,
    VendorOwnedIntegrations,
    VendorProductConnectors,
    VendorReviewStrip,
  ],
  template: `
    @if (me(); as m) {
      <div>
        <!-- AECI-1218: "Looks right" on this product's integration list (13.8). -->
        @if (ctx.product(); as p) {
          <aec-vendor-review-strip
            target="integrations"
            [productId]="p.id"
            [productName]="p.name"
            [done]="listChecked()"
          />
        }
        <div class="mt-4">
          <aec-vendor-integrations-section
            [canAuthor]="canAuthor()"
            [vendorName]="m.vendor.company_name"
            [contextProductId]="contextProductId()"
            [urlState]="true"
          />
        </div>
        <!-- AECI-1089: the owner's rows the list above does not carry. It renders
             nothing, and so takes no space, when none touch this product. -->
        <aec-vendor-owned-integrations [contextProductId]="contextProductId()" />
        <div class="mt-10">
          <aec-vendor-product-connectors [productId]="contextProductId()" />
        </div>
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorIntegrationsPage {
  protected readonly ctx = vendorProductContext();
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly store = inject(VendorPortalStore);
  protected readonly me = this.store.me;
  // AECI-1218: a product screen reads THIS product's plan (section 13.7), never
  // `me().entitlement`. The same block today, so the gate is unchanged.
  protected readonly canAuthor = computed(() =>
    productCan(this.ctx.product(), 'attestation.author'),
  );

  /** The "Check the integration list" step on this product's checklist. */
  protected readonly listChecked = computed(() => {
    const id = this.ctx.product()?.id;
    const c = id ? this.store.productChecklists().get(id) : undefined;
    return c?.steps.some((s) => s.key === 'integration_list' && s.status === 'done') ?? false;
  });

  constructor() {
    effect(() => {
      const id = this.ctx.product()?.id;
      if (!id || !this.browser) return;
      untracked(() => void this.store.ensureProductChecklist(id));
    });
  }

  /**
   * In practice never `null`: the product shell only renders its outlet once
   * `ctx.product()` has resolved, so this page does not exist before the catalog
   * lands. The fallback is here because the signal's type says it can be, not
   * because there is a state that reaches it — and it deliberately does NOT fall
   * back to "unscoped", which is what `null` means to the section: a momentary
   * unscoped render would flash every product's integrations onto one product's
   * tab.
   */
  protected readonly contextProductId = computed(() => this.ctx.product()?.id ?? '');
}
