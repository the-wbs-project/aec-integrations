import { Component } from '@angular/core';

import { BrowseLayout } from '../../layouts/browse-layout';

/**
 * Dev-only preview for `BrowseLayout`. Synthetic fixture content for visual
 * review by Impeccable and Playwright smoke. Filter sidebar is Phase 3 —
 * shown here as a placeholder so the layout's grid proportions render.
 *
 * Route: `/preview/layouts/browse`.
 */
@Component({
  selector: 'app-browse-layout-preview',
  imports: [BrowseLayout],
  template: `
    <aec-browse-layout>
      <div slot="header" class="space-y-3">
        <p class="font-mono text-xs tracking-widest text-(--text-secondary) uppercase">Browse</p>
        <h1 class="font-display text-4xl font-semibold tracking-tight md:text-5xl">Products</h1>
        <p class="text-(--text-secondary)">Showing 42 products. Filters apply Phase 3 onward.</p>
      </div>

      <div slot="filters" class="space-y-4 rounded-lg border border-(--border-default) p-6 text-sm">
        <p class="font-medium text-(--text-primary)">Filters</p>
        <p class="text-(--text-secondary)">
          Filter sidebar placeholder. Interactive behaviour ships in Phase 3.
        </p>
      </div>

      <div slot="grid" class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        @for (i of [1, 2, 3, 4, 5, 6]; track i) {
          <article class="rounded-lg border border-(--border-default) p-6">
            <p class="font-display text-lg font-semibold">Card {{ i }}</p>
            <p class="mt-2 text-sm text-(--text-secondary)">
              Card content goes here. Real browse pages project ProductCard / VendorCard /
              IntegrationCard primitives into this slot.
            </p>
          </article>
        }
      </div>
    </aec-browse-layout>
  `,
})
export class BrowseLayoutPreview {}
