import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

import { VendorProductsSection } from '../components/vendor-products-section';
import { vendorCan } from '../vendor-capabilities';
import { VendorPortalStore } from '../vendor-portal-store';

/**
 * `…/products` and `…/products/:productSlug` — the vendor's own catalog entries,
 * ONE at a time, chosen from the Products menu in the portal nav.
 *
 * ── WHY A PICKER REPLACED THE STACK, AND WHY IT THEN MOVED ──────────────────
 * The section used to render every owned product as a collapsed `<details>`.
 * That reads fine for the three-product vendor the fixtures were built from and
 * falls apart for the real ones: a vendor with a hundred products got a hundred
 * disclosures, with the one they came to edit somewhere in the middle and no way
 * to name it. A picker turned "find my product" from a scroll into a choice — and
 * because the choice is a URL segment, it is also a bookmark, a back button, and
 * a link a colleague can be sent.
 *
 * That picker lived here, beside the heading, as an `<aec-select>`. It now lives
 * in the portal nav (`vendor/vendor-products-menu.ts`), with a search box on top
 * of it: a vendor had to be ON this page to change which product they were
 * editing, and a non-editable listbox gives a hundred-product catalog nothing but
 * first-letter typeahead. One control, in the nav, reachable from every section.
 * This page keeps everything that decides WHICH product is shown; it just no
 * longer owns the control that changes it.
 *
 * ── WHICH PRODUCT IS SHOWN ───────────────────────────────────────────────────
 * The `:productSlug` segment when it names a product this vendor owns; otherwise
 * the primary product, else the first. The nav links to the bare path (it has no
 * product in hand), so the bare path must resolve to something real rather than
 * to an empty frame.
 *
 * A slug that names NO owned product is called out rather than silently
 * redirected to the default: the URL asserts a specific product, and quietly
 * rendering a different one under it is how a vendor edits the wrong listing.
 * Ownership is enforced server-side regardless — `PATCH /api/vendor/products/:id`
 * proves it against the session — so this is a clarity guard, not the gate.
 */
@Component({
  selector: 'aec-vendor-products-page',
  imports: [VendorProductsSection],
  template: `
    @if (me(); as m) {
      <div>
        <h2
          class="font-display text-xl font-semibold text-(--text-primary)"
          i18n="@@vendor.section.products"
        >
          Your products
        </h2>

        @if (unknownProduct()) {
          <p
            class="mt-4 rounded-(--radius-md) border border-(--border-default)
              bg-(--surface-raised) p-4 text-sm leading-relaxed text-(--text-primary)"
            i18n="@@vendor.products.unknown"
          >
            That product isn't linked to your vendor. Pick one from the Products menu.
          </p>
        } @else {
          <div class="mt-4">
            <aec-vendor-products-section
              [products]="m.products"
              [selectedSlug]="selectedSlug()"
              [canEdit]="canEdit()"
              [canEditTaxonomy]="canEditTaxonomy()"
            />
          </div>
        }
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorProductsPage {
  private readonly store = inject(VendorPortalStore);
  private readonly route = inject(ActivatedRoute);

  protected readonly me = this.store.me;
  protected readonly canEdit = vendorCan(this.store, 'product.edit');
  protected readonly canEditTaxonomy = vendorCan(this.store, 'product.taxonomy.edit');

  /** The `:productSlug` segment, or `null` on the bare path. Read reactively:
   *  picking a product is a same-route navigation, which changes params without
   *  re-creating this component. */
  private readonly routeSlug = toSignal(
    this.route.paramMap.pipe(map((p) => p.get('productSlug'))),
    { initialValue: this.route.snapshot.paramMap.get('productSlug') },
  );

  private readonly products = computed(() => this.me()?.products ?? []);

  /** A URL that names a product this vendor does not own. */
  protected readonly unknownProduct = computed(() => {
    const wanted = this.routeSlug();
    return wanted !== null && !this.products().some((p) => p.slug === wanted);
  });

  protected readonly selectedSlug = computed<string | null>(() => {
    const wanted = this.routeSlug();
    const products = this.products();
    if (wanted !== null) return products.some((p) => p.slug === wanted) ? wanted : null;
    return (products.find((p) => p.is_primary) ?? products[0])?.slug ?? null;
  });
}
