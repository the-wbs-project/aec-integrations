import { ChangeDetectionStrategy, Component } from '@angular/core';

import { DetailLayout } from '../../layouts/detail-layout';

/**
 * Dev-only preview for `DetailLayout`. Fixture content is fully synthetic and
 * exists so Impeccable + Playwright have a real URL to render against.
 *
 * Route: `/preview/layouts/detail` (blocked in production by
 * `apps/web/src/server-runtime.ts` `isPreviewPath`).
 */
@Component({
  selector: 'app-detail-layout-preview',
  imports: [DetailLayout],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <aec-detail-layout>
      <ol slot="breadcrumbs" class="flex gap-2 text-sm text-(--text-secondary)">
        <li><a href="#" class="hover:text-(--accent-primary)">Products</a></li>
        <li aria-hidden="true">/</li>
        <li class="text-(--text-primary)">Example Product</li>
      </ol>

      <div slot="hero" class="space-y-4">
        <p class="font-mono text-xs tracking-widest text-(--text-secondary) uppercase">Product</p>
        <h1 class="font-display text-4xl font-semibold tracking-tight md:text-5xl">
          Example Product
        </h1>
        <p class="text-lg text-(--text-secondary)">
          A short hero strapline that describes the entity at a glance. Real pages will project
          richer hero blocks here.
        </p>
      </div>

      <dl slot="metadata" class="space-y-4 rounded-lg border border-(--border-default) p-6 text-sm">
        <div>
          <dt class="text-xs tracking-wide text-(--text-secondary) uppercase">Vendor</dt>
          <dd class="mt-1 text-(--text-primary)">Acme Software</dd>
        </div>
        <div>
          <dt class="text-xs tracking-wide text-(--text-secondary) uppercase">Category</dt>
          <dd class="mt-1 text-(--text-primary)">Design coordination</dd>
        </div>
        <div>
          <dt class="text-xs tracking-wide text-(--text-secondary) uppercase">Last updated</dt>
          <dd class="mt-1 text-(--text-primary)">2026-05-01</dd>
        </div>
      </dl>

      <article slot="body" class="prose-section space-y-6">
        <h2 class="font-display text-2xl font-semibold">Overview</h2>
        <p class="text-(--text-secondary)">
          Body sections stack vertically in the main column. The metadata sidebar sticks alongside
          on tablets and up, and folds below the hero on phones.
        </p>
        <h2 class="font-display text-2xl font-semibold">Integrations</h2>
        <p class="text-(--text-secondary)">
          Real detail pages defer heavy sub-sections. The layout itself doesn't care what's
          projected; it just guarantees the structural slots.
        </p>
      </article>
    </aec-detail-layout>
  `,
})
export class DetailLayoutPreview {}
