import { Component, afterNextRender, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { compareText } from '@aeci/shared/text-sort';

import { LogoOrInitial } from '../../shared/logo-or-initial/logo-or-initial';
import { VendorPlanBadge } from '../components/vendor-plan-badge';
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
 * Sorted by name through `compareText`, never a bare `.sort()` (AECI-825: case
 * must not decide an alphabetical order). Primary first, because it is the
 * product a vendor most often came to edit.
 */
@Component({
  selector: 'aec-vendor-product-list-page',
  imports: [RouterLink, LogoOrInitial, VendorPlanBadge],
  template: `
    @if (me(); as m) {
      <div>
        <h2 class="font-display text-xl font-semibold text-(--text-primary)">
          <span i18n="@@vendor.section.products">Products</span>
          <span class="ms-1 text-(--text-secondary)">({{ products().length }})</span>
        </h2>
        @if (products().length === 0) {
          <!-- Claimed vendor, empty catalog. Not an error: promote has simply not
               landed a product against this vendor yet. -->
          <p
            class="mt-4 rounded-(--radius-md) border border-(--border-default)
              bg-(--surface-raised) p-4 text-sm leading-relaxed text-(--text-primary)"
            i18n="@@vendor.products.empty"
          >
            {{ m.vendor.company_name }} has no products listed yet.
          </p>
        } @else {
          <ul
            class="m-0 mt-4 list-none divide-y divide-(--border-default) rounded-(--radius-md)
              border border-(--border-default) bg-(--surface-raised) p-0"
          >
            @for (p of products(); track p.id) {
              <li>
                <a
                  [routerLink]="[p.slug]"
                  class="flex items-center gap-4 px-4 py-3 text-(--text-primary) no-underline
                    hover:bg-(--surface-sunken) focus-visible:outline-2
                    focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
                >
                  <aec-logo-or-initial [src]="p.logo_url" [name]="p.name" size="sm" />
                  <span class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                    <span class="min-w-0 font-medium break-words">{{ p.name }}</span>
                    @if (p.is_primary) {
                      <span
                        class="rounded-(--radius-sm) bg-(--surface-sunken) px-2 py-0.5 text-xs
                          text-(--text-secondary)"
                        i18n="@@vendor.products.primary"
                        >Primary</span
                      >
                    }
                  </span>
                  <!--
                    AECI-1218 (section 6.18): the checklist score and the plan, per
                    row. The score waits on GET /api/vendor/checklist; until it lands
                    the column is empty rather than a guess.
                  -->
                  <span class="flex shrink-0 items-center gap-3">
                    @if (scores().get(p.id); as sc) {
                      <span
                        class="text-end text-xs leading-tight text-(--text-secondary)"
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
                    <svg
                      aria-hidden="true"
                      class="h-4 w-4 text-(--text-secondary) rtl:-scale-x-100"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="m9 18 6-6-6-6" />
                    </svg>
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
