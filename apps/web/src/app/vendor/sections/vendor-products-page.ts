import { Component, computed, effect, inject, untracked } from '@angular/core';
import { ActivatedRoute, Router, RouterOutlet } from '@angular/router';

import { VendorProductNav } from '../vendor-product-nav';
import { VendorPortalStore } from '../vendor-portal-store';

import { vendorProductContext } from './vendor-product-context';

/**
 * `…/products/:productSlug` — the SHELL for one product (AECI-666), and the bare
 * `…/products` path that redirects into it.
 *
 * ── WHY THIS IS A SHELL NOW ─────────────────────────────────────────────────
 * It used to be a leaf that rendered one product's whole form. A product has more
 * than one thing to say about it — its listing copy, its taxonomy, and the
 * integrations that touch it — and stacking all of them on one page put the
 * integration list (the longest surface in the portal) below two forms. So the
 * product became a place rather than a parameter: heading, a nav row, an outlet,
 * exactly the shape the portal itself has one level up.
 *
 * ── WHY THE BARE PATH REDIRECTS RATHER THAN RENDERING ───────────────────────
 * The nav's Products item has no product in hand, so `…/products` has to resolve
 * to something real. It cannot be an Angular `redirectTo`: the target depends on
 * the vendor's catalog, which is only known after `GET /api/vendor/me` resolves.
 * So the redirect happens here, once `me` lands, with `replaceUrl` so the bare
 * path never becomes a Back-button stop the user bounces off.
 *
 * It is an `effect` rather than a resolver or guard for a specific reason: a
 * child `canActivate` runs BEFORE the parent route's resolver, so the store is
 * not seeded yet at guard time and a guard would have to re-fetch the very
 * payload the portal is built around fetching exactly once.
 *
 * ── WHICH PRODUCT IS SHOWN ───────────────────────────────────────────────────
 * {@link vendorProductContext} owns that rule and is shared with the three
 * section components, so the shell and its children can never disagree about
 * which product the page is about.
 */
@Component({
  selector: 'aec-vendor-products-page',
  imports: [RouterOutlet, VendorProductNav],
  template: `
    @if (me()) {
      <div>
        @if (ctx.unknownProduct()) {
          <p
            class="rounded-(--radius-md) border border-(--border-default)
              bg-(--surface-raised) p-4 text-sm leading-relaxed text-(--text-primary)"
            i18n="@@vendor.products.unknown"
          >
            That product isn't linked to your vendor. Pick one from the Products menu.
          </p>
        } @else if (ctx.product(); as product) {
          <h2
            class="font-display text-xl font-semibold text-(--text-primary)"
            i18n="@@vendor.section.product"
          >
            {{ product.name }}
          </h2>

          <aec-vendor-product-nav [productName]="product.name" />

          <router-outlet />
        } @else {
          <!-- Claimed vendor, empty catalog. Not an error: promote has simply not
               landed a product against this vendor yet. -->
          <p
            class="rounded-(--radius-md) border border-(--border-default)
              bg-(--surface-raised) p-4 text-sm leading-relaxed text-(--text-primary)"
            i18n="@@vendor.products.empty"
          >
            No products are linked to your vendor yet.
          </p>
        }
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorProductsPage {
  private readonly store = inject(VendorPortalStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly me = this.store.me;
  protected readonly ctx = vendorProductContext();

  /** The bare `…/products` path, once the catalog is known. */
  private readonly redirectTarget = computed(() => {
    if (this.ctx.routeSlug() !== null) return null;
    return this.ctx.product()?.slug ?? null;
  });

  constructor() {
    effect(() => {
      const slug = this.redirectTarget();
      if (!slug) return;
      // `..` is the portal's section-parent — `/vendor/:vendorSlug` on the real
      // surface, `/preview/vendor-dashboard` in the concept preview — so the one
      // expression serves both, the way every relative link in this feature does.
      //
      // `untracked` so the navigation's own param change cannot re-enter this
      // effect; `replaceUrl` so `…/products` is not a Back-button stop the user
      // bounces off on the way back out of the portal.
      untracked(() => {
        void this.router.navigate(['..', 'products', slug], {
          relativeTo: this.route,
          replaceUrl: true,
        });
      });
    });
  }
}
