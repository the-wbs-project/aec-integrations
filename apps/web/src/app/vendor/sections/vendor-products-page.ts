import { Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

import { vendorProductContext } from './vendor-product-context';

/**
 * `…/products/:productSlug` — the LAYOUT route for one product (AECI-666).
 *
 * ── WHY IT RENDERS ALMOST NOTHING (§6.11) ───────────────────────────────────
 * It used to carry the product's `h2`, its public link and a segmented product
 * nav, stacked under the vendor header and vendor tabs. The shell
 * (`vendor-dashboard-tabbed.ts`) now switches its whole header to the open
 * product — breadcrumb, `h1`, public link, tab row — so this page is the outlet
 * plus the one state the shell cannot express: a URL naming a product this
 * vendor does not own.
 *
 * The bare `…/products` path is a different component since §6.11
 * (`vendor-product-list-page.ts`). It used to redirect here, into the primary
 * product, which would have made the Products breadcrumb a trap.
 *
 * ── WHICH PRODUCT IS SHOWN ───────────────────────────────────────────────────
 * {@link vendorProductContext} owns that rule and is shared with the three
 * section components, so this page and its children can never disagree about
 * which product the page is about.
 */
@Component({
  selector: 'aec-vendor-products-page',
  imports: [RouterLink, RouterOutlet],
  template: `
    @if (ctx.unknownProduct()) {
      <p
        class="rounded-(--radius-md) border border-(--border-default)
          bg-(--surface-raised) p-4 text-sm leading-relaxed text-(--text-primary)"
      >
        <span i18n="@@vendor.products.unknown">That product isn't linked to your vendor.</span>
        {{ ' ' }}
        <a
          routerLink="../../products"
          class="text-(--accent-primary) underline underline-offset-2"
          i18n="@@vendor.products.unknownLink"
          >See your products</a
        >
      </p>
    } @else if (ctx.product()) {
      <router-outlet />
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorProductsPage {
  protected readonly ctx = vendorProductContext();
}
