import { Component, afterNextRender, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { compareText } from '@aeci/shared/text-sort';

import { AecCard } from '../../shared/card/card';
import { Chip } from '../../shared/chip/chip';
import { AecIcon } from '../../shared/icon/icon';
import { LogoOrInitial } from '../../shared/logo-or-initial/logo-or-initial';
import { VendorPlanBadge } from '../components/vendor-plan-badge';
import { VendorProductCreate } from '../components/vendor-product-create';
import { VendorPortalStore } from '../vendor-portal-store';

/**
 * `…/products` — the vendor's product list (§6.11).
 *
 * One row per owned product, linking into that product's own context
 * (`…/products/:productSlug`). Since AECI-1218 each row also carries the
 * product's plan badge and its checklist score (`STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §6.18), read from `product.plan` and `GET /api/vendor/checklist`. The plan is
 * a word, never colour alone.
 *
 * Since AECI-1424 an owner seat can add a product here ({@link VendorProductCreate},
 * `?create=open` starts it open). A member seat sees who can instead.
 *
 * Sorted by name through `compareText`, never a bare `.sort()` (AECI-825: case
 * must not decide an alphabetical order). Primary first, because it is the
 * product a vendor most often came to edit.
 */
@Component({
  selector: 'aec-vendor-product-list-page',
  imports: [
    RouterLink,
    AecCard,
    AecIcon,
    Chip,
    LogoOrInitial,
    VendorPlanBadge,
    VendorProductCreate,
  ],
  template: `
    @if (me(); as m) {
      <div>
        <h2>
          <span i18n="@@vendor.section.products">Products</span>
          <span class="ms-1 text-(--text-secondary)">({{ products().length }})</span>
        </h2>
        <!-- AECI-1424: an owner seat adds a product. A member is told who can. -->
        @if (m.seat_owner) {
          <aec-vendor-product-create class="mt-4" [deepLink]="true" />
        } @else {
          <p
            class="mt-4 text-sm text-(--text-secondary)"
            data-testid="product-create-member"
            i18n="@@vendor.productCreate.memberLine"
          >
            Only account owners can add a product. Ask an owner on the Seats tab.
          </p>
        }
        @if (products().length === 0) {
          <!-- Claimed vendor, empty catalog. Not an error: promote has simply not
               landed a product against this vendor yet. -->
          <p
            aecCard
            class="mt-6 p-6 text-sm leading-relaxed text-(--text-primary)"
            i18n="@@vendor.products.empty"
          >
            {{ m.vendor.company_name }} has no products listed yet.
          </p>
        } @else {
          <!-- AECI-1810: the portal's own list on the shared white card, rows divided
               by hairlines. Not the admin table recipe. -->
          <ul
            aecCard
            class="m-0 mt-6 list-none divide-y divide-(--border-default) overflow-hidden p-0"
          >
            @for (p of products(); track p.id) {
              <li>
                <a
                  [routerLink]="[p.slug]"
                  class="group/row flex min-h-16 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-(--text-primary)
                    no-underline transition-colors hover:bg-(--surface-sunken) focus-visible:outline-3
                    focus-visible:-outline-offset-3 focus-visible:outline-(--accent-primary) sm:px-6"
                >
                  <aec-logo-or-initial
                    [claimStatus]="'stored'"
                    [src]="p.logo_url"
                    [name]="p.name"
                    size="sm"
                  />
                  <span class="flex min-w-40 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                    <span
                      class="min-w-0 font-semibold break-words group-hover/row:text-(--accent-primary)"
                      >{{ p.name }}</span
                    >
                    @if (p.is_primary) {
                      <aec-chip density="dense" i18n="@@vendor.products.primary">Primary</aec-chip>
                    }
                  </span>
                  <!--
                    AECI-1218 (section 6.18): the checklist score and the plan, per
                    row. The score waits on GET /api/vendor/checklist; until it lands
                    the column is empty rather than a guess.
                  -->
                  <span class="ms-auto flex shrink-0 items-center gap-3">
                    @if (scores().get(p.id); as sc) {
                      <span
                        class="text-end text-t-12 text-(--text-secondary)"
                        data-testid="product-checklist-score"
                      >
                        <span class="block">{{ scoreLabel(sc.complete) }}</span>
                        <span class="block text-sm font-semibold text-(--text-primary)">{{
                          scoreValue(sc.done, sc.total)
                        }}</span>
                      </span>
                    }
                    <!-- A fixed column, so Free and Managed line up down a long list. -->
                    <span class="flex w-20"><aec-vendor-plan-badge [plan]="p.plan" /></span>
                    <span class="flex text-(--text-tertiary)">
                      <aec-icon name="chevron-right" decorative [size]="4" [mirrorRtl]="true" />
                    </span>
                  </span>
                </a>
              </li>
            }
          </ul>
        }
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorProductListPage {
  private readonly store = inject(VendorPortalStore);

  protected readonly me = this.store.me;

  /** Checklist summaries by product id, from `GET /api/vendor/checklist`. */
  protected readonly scores = computed(
    () => new Map((this.store.checklist()?.products ?? []).map((s) => [s.product_id, s])),
  );

  protected scoreLabel(complete: boolean): string {
    return complete
      ? $localize`:@@vendor.products.checklist.done:Checklist done`
      : $localize`:@@vendor.products.checklist:Checklist`;
  }

  /** "2 of 3", spoken in full. */
  protected scoreValue(done: number, total: number): string {
    return $localize`:@@vendor.products.checklist.score:${done}:DONE: of ${total}:TOTAL:`;
  }

  constructor() {
    afterNextRender(() => void this.store.ensureChecklist());
  }

  protected readonly products = computed(() =>
    [...(this.store.me()?.products ?? [])].sort(
      (a, b) => Number(b.is_primary) - Number(a.is_primary) || compareText(a.name, b.name),
    ),
  );
}
