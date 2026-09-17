import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { compareText } from '@aeci/shared/text-sort';

import { LogoOrInitial } from '../../shared/logo-or-initial/logo-or-initial';
import { VendorPortalStore } from '../vendor-portal-store';

/**
 * `…/products` — the vendor's product list (§6.11).
 *
 * Deliberately basic for now: one row per owned product, linking into that
 * product's own context (`…/products/:productSlug`). It exists so the Products
 * tab and the Products breadcrumb both land somewhere real. Before this the bare
 * path redirected into the primary product, so "Products" in a breadcrumb would
 * have bounced a vendor straight back into a product. A richer list is follow-up
 * work.
 *
 * Sorted by name through `compareText`, never a bare `.sort()` (AECI-825: case
 * must not decide an alphabetical order). Primary first, because it is the
 * product a vendor most often came to edit.
 */
@Component({
  selector: 'aec-vendor-product-list-page',
  imports: [RouterLink, LogoOrInitial],
  template: `
    @if (me()) {
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
            No products are linked to your vendor yet.
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
                  <span class="min-w-0 flex-1 font-medium break-words">{{ p.name }}</span>
                  @if (p.is_primary) {
                    <span
                      class="rounded-(--radius-sm) bg-(--surface-sunken) px-2 py-0.5 text-xs
                        text-(--text-secondary)"
                      i18n="@@vendor.products.primary"
                      >Primary</span
                    >
                  }
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

  protected readonly products = computed(() =>
    [...(this.store.me()?.products ?? [])].sort(
      (a, b) => Number(b.is_primary) - Number(a.is_primary) || compareText(a.name, b.name),
    ),
  );
}
