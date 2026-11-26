import { Component, afterNextRender, computed, inject, input, signal } from '@angular/core';

import type { TaxonomyResponse, VendorProduct } from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import { VendorApi } from '../vendor-api';
import { VendorProductFacetEditor, type ProductFacetKind } from './vendor-product-facet-editor';
import { VendorProductForm } from './vendor-product-form';

/** Which product tab a section renders: the Profile form or one facet editor. */
export type VendorProductTab = 'profile' | ProductFacetKind;

/**
 * The "your products" editor of the vendor dashboard (AECI-522): the editable
 * form behind `PATCH /api/vendor/products/:id`. The taxonomy vocabulary that
 * powers the term pickers is fetched once here (browser-only, after hydration)
 * and shared by every form it renders, so a multi-product vendor makes a single
 * `GET /api/taxonomy` round-trip.
 *
 * ── ONE PRODUCT, ONE TAB ─────────────────────────────────────────────────────
 * `selectedSlug` names the ONE product whose form renders, with no disclosure
 * wrapper. The routed portal sets it from the URL (`sections/vendor-products-page.ts`):
 * a vendor with a hundred products reaches the one it came to edit by name.
 *
 * The old `null` mode, every product as a stacked `<details>`, is gone (AECI-1810).
 * Its one caller, the dev-only single-page concept, was deleted by AECI-1809. Both
 * callers (the Profile and facet pages) render inside `VendorProductsPage`'s
 * `@else if (ctx.product())`, so the slug they pass is never null in practice.
 *
 * A `selectedSlug` that is `null` or names no owned product renders nothing here.
 * The routed page detects that case first and says so, which is the right place
 * for it: the section has no idea whether the slug came from a URL or a stale link.
 */
@Component({
  selector: 'aec-vendor-products-section',
  imports: [AecButton, VendorProductForm, VendorProductFacetEditor],
  host: { class: 'block' },
  template: `
    @if (products().length === 0) {
      <p
        class="text-sm leading-relaxed text-(--text-secondary)"
        i18n="@@vendor.products.sectionEmpty"
      >
        Your company has no products listed yet. An account owner can add one from the Products tab.
      </p>
    } @else {
      @if (taxonomyFailed()) {
        <div class="mb-4 flex flex-wrap items-center gap-3">
          <p class="text-sm text-(--text-primary)" i18n="@@vendor.products.taxonomyError">
            Could not load the category options. You can still edit the other fields.
          </p>
          <button
            aecButton
            variant="secondary"
            compact
            type="button"
            (click)="loadTaxonomy()"
            i18n="@@vendor.products.retry"
          >
            Try again
          </button>
        </div>
      }
      @if (selectedProduct(); as product) {
        <!--
          No heading of its own: the form opens with its read-only identity
          block (name + slug + the rename-is-a-correction-request hint), so a
          card header would repeat the product name the page h1 already shows.
          No panel here either (AECI-1116): each form is its own portal form
          card (AECI-1810), with the identity block and its notes above it, the
          same shape as the vendor Profile form. A wrapper card here would nest
          that card inside a second one, which impeccable detect flags.
        -->
        <div class="space-y-10">
          @if (section() === 'profile') {
            <aec-vendor-product-form [product]="product" />
          }
          @for (facet of facets(); track facet) {
            <aec-vendor-product-facet-editor
              [product]="product"
              [facet]="facet"
              [taxonomy]="taxonomy()"
              [headingLevel]="2"
            />
          }
        </div>
      }
    }
  `,
})
export class VendorProductsSection {
  private readonly api = inject(VendorApi);

  readonly products = input.required<readonly VendorProduct[]>();

  /** Which product to render, by slug. `null` renders nothing (see the class doc). */
  readonly selectedSlug = input.required<string | null>();

  // No entitlement inputs (AECI-1214): each product form and facet editor gates
  // itself on its own product's `plan` through `productCan` (§13.7). The section
  // renders identically on every plan: every product and every value shows, and
  // only the controls a plan cannot use are read-only.

  /** Which product tab to render (AECI-994): the Profile form or one facet editor.
   *  The facet editor takes `h2` headings, under the shell's product-name `h1`. */
  readonly section = input.required<VendorProductTab>();

  protected readonly facets = computed<readonly ProductFacetKind[]>(() => {
    const section = this.section();
    return section === 'profile' ? [] : [section];
  });

  protected readonly selectedProduct = computed(() => {
    const slug = this.selectedSlug();
    return slug === null ? null : (this.products().find((p) => p.slug === slug) ?? null);
  });

  protected readonly taxonomy = signal<TaxonomyResponse | null>(null);
  protected readonly taxonomyFailed = signal(false);

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
