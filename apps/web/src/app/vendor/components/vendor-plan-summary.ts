import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { VendorEntitlementBlock, VendorProduct } from '@aeci/shared';

import { VendorAccountBadge } from '../../shared/vendor-account-badge/vendor-account-badge';
import { isCatalogueSeat } from '../vendor-capabilities';
import { daysRemaining, isManaged, noPlanChangesLine, planState } from '../vendor-plan';

/**
 * The vendor-level plan line on Vendor Overview (AECI-1218,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18). Decision 2 allows one line at vendor
 * level: how many products are on each plan. Each product page carries its own
 * plan panel.
 *
 * The counts read each product's own `plan` (§13.7), so the line stays right
 * when per-product plans land. The "Active on AECi" label is a vendor fact (the
 * public account label, `STAGE_2_PAID_TIERS_SPEC.md` §8.1), so it reads the
 * vendor's block, which this vendor screen may do.
 *
 * Carries decision 10's line, as every plan panel does (§13.1).
 */
@Component({
  selector: 'aec-vendor-plan-summary',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, VendorAccountBadge],
  template: `
    <section
      aria-labelledby="vendor-plan-summary-h"
      class="block rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-5 md:p-6"
    >
      <div class="flex flex-wrap items-start justify-between gap-3">
        <h2
          id="vendor-plan-summary-h"
          class="font-display text-xl font-semibold text-(--text-primary)"
          i18n="@@vendor.plan.summary.heading"
        >
          Your plan
        </h2>
        @if (accountActive()) {
          <aec-vendor-account-badge [active]="true" variant="portal" />
        }
      </div>
      <p class="mt-3 text-base font-semibold text-(--text-primary)" data-testid="plan-summary-line">
        {{ line() }}
      </p>
      @if (catalogueSeat()) {
        <!--
          AECI-1083: where the catalogue seat's work is. Navigation, not a call
          to action, so a plain link per connector product.
        -->
        @for (p of connectorProducts(); track p.slug) {
          <p class="mt-2 text-sm">
            <a
              [routerLink]="['..', 'products', p.slug, 'catalogue']"
              [class]="linkClass"
              data-catalogue-link
              >{{ catalogueLinkLabel(p.name) }}</a
            >
          </p>
        }
      } @else if (products().length > 0) {
        <p class="mt-1.5 text-sm leading-relaxed text-(--text-secondary)">
          <span i18n="@@vendor.plan.summary.perProduct"
            >Plans are per product. Each product page shows what its plan includes.</span
          >
          {{ ' ' }}
          <a routerLink="../products" [class]="linkClass" i18n="@@vendor.plan.summary.seeProducts"
            >See plans by product</a
          >
        </p>
      }
      <p
        class="mt-4 border-t border-(--border-default) pt-3 text-xs leading-relaxed text-(--text-secondary)"
        data-testid="plan-decision10"
      >
        {{ decision10 }}
      </p>
    </section>
  `,
  styles: [':host { display: block; }'],
})
export class VendorPlanSummary {
  /** The vendor's own block, for the account label only. */
  readonly entitlement = input.required<VendorEntitlementBlock>();
  readonly products = input.required<readonly VendorProduct[]>();
  readonly now = input<number>(Date.now());

  protected readonly decision10 = noPlanChangesLine();

  protected readonly accountActive = computed(() => isManaged(this.entitlement()));

  /** The §8.9 connector catalogue seat (AECI-724). */
  protected readonly catalogueSeat = computed(() =>
    isCatalogueSeat(this.entitlement().status, this.products()),
  );
  protected readonly connectorProducts = computed(() =>
    this.products().filter((p) => p.product_role === 'connector'),
  );
  protected catalogueLinkLabel(name: string): string {
    return $localize`:@@vendor.plan.catalogue.link:Open the ${name}:PRODUCT: catalogue`;
  }

  protected readonly line = computed<string>(() => {
    const products = this.products();
    const n = products.length;
    if (isCatalogueSeat(this.entitlement().status, products)) {
      return $localize`:@@vendor.plan.summary.catalogue:Connector catalogue seat, with the Free edits on every product`;
    }
    if (n === 0) return $localize`:@@vendor.plan.summary.none:No products listed yet`;
    const managed = products.filter((p) => isManaged(p.plan)).length;
    const free = n - managed;
    let counts: string;
    if (managed === 0) {
      counts =
        n === 1
          ? $localize`:@@vendor.plan.summary.allFree.one:1 product, on Free`
          : $localize`:@@vendor.plan.summary.allFree:${n}:COUNT: products, all on Free`;
    } else if (free === 0) {
      counts =
        n === 1
          ? $localize`:@@vendor.plan.summary.allManaged.one:1 product, on Managed`
          : $localize`:@@vendor.plan.summary.allManaged:${n}:COUNT: products, all on Managed`;
    } else {
      counts = $localize`:@@vendor.plan.summary.mixed:${n}:COUNT: products: ${managed}:MANAGED: on Managed, ${free}:FREE: on Free`;
    }
    // The one deadline worth a clause: Managed running out soon.
    const expiring = products
      .filter((p) => planState(p.plan, this.now()) === 'expiring')
      .map((p) => daysRemaining(p.plan, this.now()) ?? 0);
    if (expiring.length === 0) return counts;
    const soonest = Math.min(...expiring);
    if (soonest === 0) {
      return $localize`:@@vendor.plan.summary.expiring.today:${counts}:COUNTS:. Managed ends today.`;
    }
    return soonest === 1
      ? $localize`:@@vendor.plan.summary.expiring.one:${counts}:COUNTS:. Managed ends in 1 day.`
      : $localize`:@@vendor.plan.summary.expiring:${counts}:COUNTS:. Managed ends in ${soonest}:DAYS: days.`;
  });

  protected readonly linkClass =
    'font-medium text-(--accent-primary) underline underline-offset-2 focus-visible:rounded-(--radius-sm) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
}
