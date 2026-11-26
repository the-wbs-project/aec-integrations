import {
  Component,
  PLATFORM_ID,
  afterNextRender,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';

import { countOwnerFlowsAwaitingAnswer } from '@aeci/shared';
import { isPlatformBrowser } from '@angular/common';

import { VendorIntegrationsSection } from '../components/vendor-integrations-section';
import { VendorDeliveredPairs } from '../components/vendor-delivered-pairs';
import {
  VendorOwnedIntegrations,
  ownedRowsForProduct,
  ownedRowsInScope,
} from '../components/vendor-owned-integrations';
import { VendorProductConnectors } from '../components/vendor-product-connectors';
import {
  VendorSyncServicePairCreate,
  offersSyncServicePairCreate,
} from '../components/vendor-sync-service-pair-create';
import {
  VendorReviewStrip,
  reviewStepState,
  reviewStripShown,
} from '../components/vendor-review-strip';
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
 * AECI-2040 adds, on a Sync Service product only, the form that adds a pair the Sync
 * Service delivers (`vendor-sync-service-pair-create.ts`). The new pair then shows in
 * the owned rows below it, with its data flows panel.
 *
 * AECI-2045 QA (the Same-Behavior Rule, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.13b). A Sync
 * Service product's tab leads with the pairs it delivers: the create's heading, one
 * summary line (pairs, rows of data, rows waiting for the owner's answer, counted with
 * the product checklist's rule) and the pairs themselves. A pure Sync Service
 * (`connector`) offers one "Add an integration", its own. The endpoint list follows
 * under its own heading only where the product is an endpoint: always on a `hybrid`,
 * whose two triggers say what each adds, and on a `connector` only once it has an
 * integration of its own. So a Sync Service never reads "0 rows" or "No integrations"
 * above the pairs it offers.
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
    VendorDeliveredPairs,
    VendorProductConnectors,
    VendorReviewStrip,
    VendorSyncServicePairCreate,
  ],
  template: `
    @if (me(); as m) {
      <div>
        <!-- AECI-1218: "Looks right" on this product's integration list (13.8).
             AECI-1241: only while the step is not done at load. -->
        @if (ctx.product(); as p) {
          @if (showStrip()) {
            <aec-vendor-review-strip
              class="mb-4"
              target="integrations"
              [productId]="p.id"
              [productName]="p.name"
              [done]="listStep() === 'done'"
            />
          }
        }
        @if (syncServiceProduct(); as sync) {
          <!-- AECI-2045 QA: a Sync Service's tab leads with what it has, the pairs it
               delivers, under one heading with one count and its one create. -->
          <aec-vendor-sync-service-pair-create [product]="sync" [hybrid]="isHybridSync()">
            @if (integrationsReady()) {
              <p class="text-sm text-(--text-secondary)" data-testid="sync-summary">
                {{ syncSummary() }}
              </p>
            }
          </aec-vendor-sync-service-pair-create>
          <aec-vendor-owned-integrations
            [contextProductId]="contextProductId()"
            scope="delivered"
            labelledBy="vendor-sync-create-heading"
          />
          @if (integrationsReady() && deliveredRows().length === 0) {
            <p
              class="mt-4 max-w-prose text-sm text-(--text-secondary)"
              data-testid="sync-empty"
              i18n="@@vendor.syncTab.empty"
            >
              No integrations are on record through {{ sync.name }} yet. Add one with the button
              above. The pairs it delivers that AEC Integrations finds are listed here too.
            </p>
          }
          <!-- The endpoint list only where the product is an endpoint of something: always
               on a hybrid, and on a connector once it has an integration of its own. -->
          @if (showEndpointSection()) {
            <div class="mt-12">
              <aec-vendor-integrations-section
                [canAuthor]="canAuthor()"
                [vendorName]="m.vendor.company_name"
                [contextProductId]="contextProductId()"
                [urlState]="true"
                [heading]="endpointHeading()"
                [offerCreate]="isHybridSync()"
                [createWithName]="isHybridSync() ? sync.name : null"
              />
            </div>
          }
          <!-- The owner's other rows on this tab, under their own heading. -->
          <aec-vendor-owned-integrations [contextProductId]="contextProductId()" scope="others" />
          <!-- AECI-2045: the pairs it delivers under another owner. -->
          <aec-vendor-delivered-pairs class="mt-10" [productId]="contextProductId()" />
        } @else {
          <div>
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
        }
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
  // `me().entitlement`. AECI-1355: the section opens a row on this product's tab
  // when the caller's other endpoint is licensed (`integrationCanAuthor`).
  protected readonly canAuthor = computed(() =>
    productCan(this.ctx.product(), 'attestation.author'),
  );

  /** The "Check the integration list" step on this product's checklist. `unknown` until it loads. */
  protected readonly listStep = computed(() => {
    const id = this.ctx.product()?.id;
    return reviewStepState(id ? this.store.productChecklists().get(id) : null, 'integration_list');
  });
  /** AECI-1241: the strip shows only for a step not done when the page loaded. */
  protected readonly showStrip = reviewStripShown(() => ({
    record: this.ctx.product()?.id ?? null,
    state: this.listStep(),
  }));

  constructor() {
    // The endpoint list asks for these when it renders. A pure Sync Service's tab may
    // not render it, and its pairs ride the same read, so the page asks too.
    afterNextRender(() => {
      void this.store.ensure('integrations');
      void this.store.ensure('contests');
    });
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
   * because there is a state that reaches it. `''` matches no row, so the section
   * lists nothing rather than flashing every product's integrations onto one
   * product's tab. The section has no unscoped mode since AECI-1811.
   */
  protected readonly contextProductId = computed(() => this.ctx.product()?.id ?? '');

  /** The tab's product when it is a Sync Service (AECI-2040), else `null`. */
  protected readonly syncServiceProduct = computed(() => {
    const product = this.ctx.product();
    return product && offersSyncServicePairCreate(product) ? product : null;
  });

  /** A Sync Service that is also an endpoint (`hybrid`): it keeps the ordinary create. */
  protected readonly isHybridSync = computed(
    () => this.syncServiceProduct()?.product_role === 'hybrid',
  );

  protected readonly integrationsReady = computed(
    () => !this.store.integrationsLoading() && !this.store.integrationsFailed(),
  );

  /** The tab product's endpoint integrations (the list's own scope). */
  private readonly endpointIntegrations = computed(() =>
    this.store.integrations().filter((i) => i.context_product.id === this.contextProductId()),
  );

  /** The pairs this Sync Service delivers that the vendor owns. */
  protected readonly deliveredRows = computed(() => {
    const id = this.contextProductId();
    const mine = new Set((this.me()?.products ?? []).map((p) => p.id));
    return ownedRowsInScope(
      ownedRowsForProduct(this.store.ownedIntegrations(), id, mine),
      id,
      'delivered',
    );
  });

  /** "2 integrations · 3 rows of data on record · 1 needs your answer". */
  protected readonly syncSummary = computed(() => {
    const rows = this.deliveredRows();
    const pairs = rows.length;
    const flows = rows.reduce((n, row) => n + row.flows.length, 0);
    const awaiting = rows.reduce((n, row) => n + countOwnerFlowsAwaitingAnswer(row), 0);
    const parts = [
      pairs === 1
        ? $localize`:@@vendor.syncTab.summary.pairs.one:1 integration`
        : $localize`:@@vendor.syncTab.summary.pairs:${pairs}:count: integrations`,
      flows === 1
        ? $localize`:@@vendor.syncTab.summary.rows.one:1 row of data on record`
        : $localize`:@@vendor.syncTab.summary.rows:${flows}:count: rows of data on record`,
      awaiting === 1
        ? $localize`:@@vendor.syncTab.summary.awaiting.one:1 needs your answer`
        : $localize`:@@vendor.syncTab.summary.awaiting:${awaiting}:count: need your answer`,
    ];
    return parts.join(' · ');
  });

  /** The endpoint list on a Sync Service's tab: always on a hybrid, and on a connector
   *  once it is an endpoint of an integration (or when the read failed, to say so). */
  protected readonly showEndpointSection = computed(
    () =>
      this.isHybridSync() ||
      this.store.integrationsFailed() ||
      (this.integrationsReady() && this.endpointIntegrations().length > 0),
  );

  protected readonly endpointHeading = computed(() => {
    const name = this.ctx.product()?.name ?? '';
    return $localize`:@@vendor.syncTab.endpointHeading:Integrations that connect to ${name}:name:`;
  });
}
