import { Component, afterNextRender, computed, inject, input, signal } from '@angular/core';

import type { TaxonomyResponse, VendorProduct } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VendorProductForm } from './vendor-product-form';

/**
 * The "your products" editor of the vendor dashboard (AECI-522): the editable
 * form behind `PATCH /api/vendor/products/:id`. The taxonomy vocabulary that
 * powers the term pickers is fetched once here (browser-only, after hydration)
 * and shared by every form it renders, so a multi-product vendor makes a single
 * `GET /api/taxonomy` round-trip.
 *
 * ── TWO MODES, AND WHY ───────────────────────────────────────────────────────
 * `selectedSlug` decides what this renders:
 *
 *   - **set** → that ONE product's form, no disclosure wrapper. This is what the
 *     routed portal uses (`sections/vendor-products-page.ts`), where the choice
 *     is a URL segment driven by the picker beside the heading. A vendor with a
 *     hundred products has no use for a hundred stacked disclosures, and the
 *     product they came to edit is reachable by name rather than by scrolling.
 *   - **null** (the default) → every product as a collapsed `<details>`, primary
 *     (or first) open. That is the original AECI-522 rendering, kept because the
 *     dev-only single-page concept (`vendor-dashboard-single.ts`) puts the whole
 *     surface on one scroll and has no picker to drive.
 *
 * A `selectedSlug` naming no owned product renders nothing here — the routed
 * page detects that case first and says so, which is the right place for it: the
 * section has no idea whether the slug came from a URL or a stale link.
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
      @if (selectedSlug() !== null) {
        @if (selectedProduct(); as product) {
          <!--
            No heading of its own: the form opens with its read-only identity
            block (name + slug + the rename-is-a-correction-request hint), so a
            card header would be the third place the same product name appears on
            this screen, after the picker's trigger. Same panel treatment as the
            list mode's <details> so the two renderings sit at the same depth.
          -->
          <div
            class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-5"
          >
            <aec-vendor-product-form
              [product]="product"
              [taxonomy]="taxonomy()"
              [canEdit]="canEdit()"
              [canEditTaxonomy]="canEditTaxonomy()"
            />
          </div>
        }
      } @else {
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
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorProductsSection {
  private readonly api = inject(VendorApi);

  readonly products = input.required<readonly VendorProduct[]>();

  /** Which product to render, by slug. `null` renders the full stacked list —
   *  see the mode note in the class doc. */
  readonly selectedSlug = input<string | null>(null);

  /** Pass-through of the §8 entitlement gate to every product form (AECI-614).
   *  The section itself renders identically either way: a downgraded vendor still
   *  sees every product and every value, just not the controls to change them. */
  readonly canEdit = input<boolean>(true);
  readonly canEditTaxonomy = input<boolean>(true);

  protected readonly selectedProduct = computed(() => {
    const slug = this.selectedSlug();
    return slug === null ? null : (this.products().find((p) => p.slug === slug) ?? null);
  });

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
