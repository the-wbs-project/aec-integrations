import { Component } from '@angular/core';

import type { IntegrationListItem, ProductListItem } from '@aeci/shared';

import { RecentIntegrationsSection } from '../../home/recent-integrations-section';
import { TrendingProductsSection } from '../../home/trending-products-section';

/**
 * Dev-only preview for the AECI-185 home modules (`RecentIntegrationsSection` +
 * `TrendingProductsSection`). Synthetic fixtures exercise every state — recent
 * populated/empty, and trending populated / recently-added fallback / both-empty
 * — so the modules can be reviewed (both themes) and axe-scanned in isolation
 * before the 4.11 assembly issue wires them into `/` with the real resolver.
 *
 * The host `<h1>` exists so the page satisfies axe's `page-has-heading-one`
 * (each module renders an `<h2>`). Route: `/preview/home/sections`, production-
 * blocked by `isPreviewPath` (see `server-runtime.ts`). Don't link to it from
 * product navigation. Preview copy is intentionally not i18n-wrapped (matches the
 * other preview harnesses).
 */
@Component({
  selector: 'app-home-sections-preview',
  imports: [RecentIntegrationsSection, TrendingProductsSection],
  template: `
    <main class="mx-auto max-w-7xl space-y-10 px-6 py-12">
      <h1 class="font-display text-3xl font-semibold tracking-tight text-(--text-primary)">
        Home sections preview (AECI-185)
      </h1>

      <p class="text-xs tracking-wide text-(--text-secondary) uppercase">
        Recently added integrations: populated
      </p>
      <aec-recent-integrations-section class="block" [integrations]="integrations" />

      <p class="text-xs tracking-wide text-(--text-secondary) uppercase">
        Recently added integrations: empty
      </p>
      <aec-recent-integrations-section class="block" [integrations]="empty" />

      <p class="text-xs tracking-wide text-(--text-secondary) uppercase">
        Trending products: populated
      </p>
      <aec-trending-products-section
        class="block"
        [products]="trending"
        [recentlyAdded]="recentlyAdded"
      />

      <p class="text-xs tracking-wide text-(--text-secondary) uppercase">
        Trending products: fallback (empty trending, falls back to recently added)
      </p>
      <aec-trending-products-section
        class="block"
        [products]="emptyProducts"
        [recentlyAdded]="recentlyAdded"
      />

      <p class="text-xs tracking-wide text-(--text-secondary) uppercase">
        Trending products: empty (both empty)
      </p>
      <aec-trending-products-section
        class="block"
        [products]="emptyProducts"
        [recentlyAdded]="emptyProducts"
      />
    </main>
  `,
})
export class HomeSectionsPreview {
  protected readonly empty: readonly IntegrationListItem[] = [];
  protected readonly emptyProducts: readonly ProductListItem[] = [];

  protected readonly integrations: readonly IntegrationListItem[] = [
    this.integration(1, 'Revit', 'Navisworks', 'native', 'bidirectional'),
    this.integration(2, 'Procore', 'QuickBooks', 'api', 'one-way'),
    this.integration(3, 'Bluebeam', 'SharePoint', 'marketplace-app', null),
    this.integration(4, 'AutoCAD', 'BIM 360', null, 'one-way'),
  ];

  protected readonly trending: readonly ProductListItem[] = [
    this.product(1, 'Procore', 'Procore Technologies', 'Project Management', 24),
    this.product(2, 'Autodesk Construction Cloud', 'Autodesk', 'BIM', 18),
    this.product(3, 'Bluebeam Revu', 'Bluebeam', 'Document Control', 9),
    this.product(4, 'PlanGrid', 'Autodesk', 'Field Reporting', 0),
  ];

  protected readonly recentlyAdded: readonly ProductListItem[] = [
    this.product(5, 'Fieldwire', 'Hilti', 'Field Reporting', 3),
    this.product(6, 'Newforma', 'Newforma', 'Project Information', 2),
    this.product(7, 'Buildertrend', 'Buildertrend', 'Construction Management', 1),
  ];

  private integration(
    n: number,
    source: string,
    target: string,
    mechanism_kind: IntegrationListItem['mechanism_kind'],
    direction: IntegrationListItem['direction'],
  ): IntegrationListItem {
    const slug = (name: string) => name.toLowerCase().replace(/\s+/g, '-');
    return {
      id: `00000000-0000-4000-8000-0000000900${String(n).padStart(2, '0')}`,
      name: `${source} → ${target}`,
      mechanism_kind,
      mechanism_name: null,
      direction,
      source: { id: `s${n}`, slug: slug(source), name: source, logo_url: null },
      target: { id: `t${n}`, slug: slug(target), name: target, logo_url: null },
      // Preview fixtures model `integrations` rows, so no connector (AECI-721).
      via: null,
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
    };
  }

  private product(
    n: number,
    name: string,
    vendor: string,
    category: string,
    integration_count: number,
  ): ProductListItem {
    const slug = (s: string) => s.toLowerCase().replace(/\s+/g, '-');
    return {
      id: `00000000-0000-4000-8000-0000000901${String(n).padStart(2, '0')}`,
      slug: slug(name),
      name,
      logo_url: null,
      product_role: 'application',
      vendor: { id: `v${n}`, slug: slug(vendor), name: vendor, logo_url: null, verified: false },
      primary_category: { id: `c${n}`, slug: slug(category), name: category },
      integration_count,
      review_count: 0,
      rating_overall_avg: null,
      rating_onboarding_avg: null,
      created_at: '2026-05-20T00:00:00.000Z',
      updated_at: '2026-06-05T00:00:00.000Z',
    };
  }
}
