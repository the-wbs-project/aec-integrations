import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { map } from 'rxjs';

import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { VendorProductsSection } from '../components/vendor-products-section';
import { vendorCan } from '../vendor-capabilities';
import { VendorPortalStore } from '../vendor-portal-store';

/**
 * `…/products` and `…/products/:productSlug` — the vendor's own catalog entries,
 * ONE at a time, chosen with the picker beside the heading.
 *
 * ── WHY A PICKER REPLACED THE STACK ──────────────────────────────────────────
 * The section used to render every owned product as a collapsed `<details>`.
 * That reads fine for the three-product vendor the fixtures were built from and
 * falls apart for the real ones: a vendor with a hundred products got a hundred
 * disclosures, with the one they came to edit somewhere in the middle and no way
 * to name it. A picker turns "find my product" from a scroll into a choice — and
 * because the choice is a URL segment, it is also a bookmark, a back button, and
 * a link a colleague can be sent.
 *
 * The control is the shared {@link AecSelect} (a non-editable Angular Aria
 * combobox over a listbox, ADR 0010), which brings listbox typeahead with it —
 * the thing that actually makes a hundred options navigable from the keyboard.
 * It is hidden for a single-product vendor, where a picker over one option is
 * noise; the product's name is rendered by the card either way, so nothing is
 * lost.
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
  imports: [AecSelect, VendorProductsSection],
  template: `
    @if (me(); as m) {
      <div>
        <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <h2
            class="font-display text-xl font-semibold text-(--text-primary)"
            i18n="@@vendor.section.products"
          >
            Your products
          </h2>
          @if (m.products.length > 1) {
            <aec-select
              i18n-label="@@vendor.products.picker.label"
              label="Product"
              idPrefix="vendor-product-picker"
              [options]="options()"
              [value]="selectedSlug()"
              [placeholder]="pickerPlaceholder"
              (changed)="select($event)"
            />
          }
        </div>

        @if (unknownProduct()) {
          <p
            class="mt-4 rounded-(--radius-md) border border-(--border-default)
              bg-(--surface-raised) p-4 text-sm leading-relaxed text-(--text-primary)"
            i18n="@@vendor.products.unknown"
          >
            That product isn't linked to your vendor. Pick one from the list above.
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
  private readonly router = inject(Router);

  protected readonly me = this.store.me;
  protected readonly canEdit = vendorCan(this.store, 'product.edit');
  protected readonly canEditTaxonomy = vendorCan(this.store, 'product.taxonomy.edit');

  /** Shown while `value` matches no option — only reachable in the unknown-slug
   *  state, where the picker is deliberately left showing nothing chosen. */
  protected readonly pickerPlaceholder = $localize`:@@vendor.products.picker.placeholder:Choose a product`;

  /** The `:productSlug` segment, or `null` on the bare path. Read reactively:
   *  picking a product is a same-route navigation, which changes params without
   *  re-creating this component. */
  private readonly routeSlug = toSignal(
    this.route.paramMap.pipe(map((p) => p.get('productSlug'))),
    { initialValue: this.route.snapshot.paramMap.get('productSlug') },
  );

  private readonly products = computed(() => this.me()?.products ?? []);

  /** The vendor's own catalog, alphabetical — the picker is a lookup, so it is
   *  ordered the way a reader would look something up, not by `is_primary`. */
  protected readonly options = computed<readonly AecSelectOption[]>(() =>
    [...this.products()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ value: p.slug, label: p.name })),
  );

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

  /**
   * Navigate relative to the PORTAL route, not to this one: the section is
   * mounted at two paths (`products` and `products/:productSlug`), so a link
   * relative to the active route would append on one and replace on the other.
   * The parent is the same route either way — `/vendor/:vendorSlug` on the real
   * surface, `/preview/vendor-dashboard` in the concept preview — which is also
   * what keeps the preview from navigating into the live portal.
   */
  protected select(slug: string | null): void {
    if (slug === null) return;
    void this.router.navigate(['products', slug], { relativeTo: this.route.parent });
  }
}
