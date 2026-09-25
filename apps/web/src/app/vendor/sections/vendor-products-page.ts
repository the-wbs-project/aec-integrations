import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

import { VendorPortalStore } from '../vendor-portal-store';
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
      <h2
        class="font-display text-xl font-semibold text-(--text-primary)"
        i18n="@@vendor.products.unknownHeading"
      >
        Product not found
      </h2>
      <p
        class="mt-4 max-w-prose rounded-(--radius-md) border border-(--border-default)
          bg-(--surface-raised) p-4 text-sm leading-relaxed text-(--text-primary)"
      >
        <span i18n="@@vendor.products.unknown"
          >The link asks for “{{ ctx.routeSlug() }}”, which is not one of {{ companyName() }}'s
          products.</span
        >
        {{ ' ' }}
        <span i18n="@@vendor.products.unknownCause"
          >It may have been renamed, removed, or moved to another company.</span
        >
        {{ ' ' }}
        <a
          routerLink="../../products"
          [class]="inlineLinkClass"
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
  private readonly store = inject(VendorPortalStore);

  /**
   * The notice names the company and echoes the slug the URL asked for, so a
   * vendor holding a stale bookmark can tell which link was bad (AECI-1129). A
   * product renamed, retired or moved by promote leaves the old slug in every
   * saved link, which is why the notice names those causes too.
   */
  protected readonly companyName = computed(() => this.store.me()?.vendor.company_name ?? '');

  /**
   * The in-text link role (DESIGN.md, "The Link Treatment Rule"), spelled as in
   * `vendor-contest-protest.ts`. The underline is the non-colour cue axe's
   * `link-in-text-block` needs (AECI-1102).
   * The hover colour must be restated: a `text-*` utility overrides the base
   * layer's `a:hover`, so without it the link gives no hover feedback.
   */
  protected readonly inlineLinkClass =
    'text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) ' +
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
}
