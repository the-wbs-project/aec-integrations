import { Component, afterNextRender, inject, input, signal } from '@angular/core';

import type { TaxonomyResponse, VendorProduct } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VendorProductForm } from './vendor-product-form';

/**
 * The "your products" section of the vendor dashboard (AECI-522): one editable
 * form per owned product (`PATCH /api/vendor/products/:id`). The taxonomy
 * vocabulary that powers the term pickers is fetched once here (browser-only,
 * after hydration) and shared by every product form, so a multi-product vendor
 * makes a single `GET /api/taxonomy` round-trip.
 *
 * Products beyond the first are collapsed into native `<details>` disclosures so
 * a vendor with many products isn't faced with a wall of forms. The primary
 * product (or the first) opens by default.
 */
@Component({
  selector: 'aec-vendor-products-section',
  imports: [VendorProductForm],
  template: `
    @if (products().length === 0) {
      <p class="text-sm leading-relaxed text-(--text-secondary)" i18n="@@vendor.products.empty">
        No products are linked to your vendor yet. New products are added by AEC Integrations.
      </p>
    } @else {
      @if (taxonomyFailed()) {
        <div class="mb-4 flex flex-wrap items-center gap-3">
          <p class="text-sm text-(--text-primary)" i18n="@@vendor.products.taxonomyError">
            Could not load the category options. You can still edit the other fields.
          </p>
          <button
            type="button"
            [class]="retryClass"
            (click)="loadTaxonomy()"
            i18n="@@vendor.products.retry"
          >
            Try again
          </button>
        </div>
      }
      <div class="space-y-4">
        @for (product of products(); track product.id; let first = $first) {
          <details
            [open]="first || product.is_primary"
            class="group rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised)"
          >
            <summary
              class="flex cursor-pointer items-center justify-between gap-3 rounded-(--radius-md) px-5 py-4 text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            >
              <span class="font-display text-lg">{{ product.name }}</span>
              <span class="text-xs text-(--text-secondary)" aria-hidden="true">
                <span class="hidden group-open:inline" i18n="@@vendor.products.collapse"
                  >Collapse</span
                >
                <span class="group-open:hidden" i18n="@@vendor.products.expand">Edit</span>
              </span>
            </summary>
            <div class="border-t border-(--border-default) p-5">
              <aec-vendor-product-form
                [product]="product"
                [taxonomy]="taxonomy()"
                [canEdit]="canEdit()"
                [canEditTaxonomy]="canEditTaxonomy()"
              />
            </div>
          </details>
        }
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorProductsSection {
  private readonly api = inject(VendorApi);

  readonly products = input.required<readonly VendorProduct[]>();

  /** Pass-through of the §8 entitlement gate to every product form (AECI-614).
   *  The section itself renders identically either way: a downgraded vendor still
   *  sees every product and every value, just not the controls to change them. */
  readonly canEdit = input<boolean>(true);
  readonly canEditTaxonomy = input<boolean>(true);

  protected readonly taxonomy = signal<TaxonomyResponse | null>(null);
  protected readonly taxonomyFailed = signal(false);

  protected readonly retryClass =
    'rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-label text-(--text-primary) transition-colors hover:bg-(--surface-raised) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  constructor() {
    // Browser-only: the taxonomy is a public read, fetched after hydration so the
    // forms' term pickers populate without blocking first paint.
    afterNextRender(() => void this.loadTaxonomy());
  }

  protected async loadTaxonomy(): Promise<void> {
    this.taxonomyFailed.set(false);
    try {
      this.taxonomy.set(await this.api.getTaxonomy());
    } catch {
      this.taxonomyFailed.set(true);
    }
  }
}
