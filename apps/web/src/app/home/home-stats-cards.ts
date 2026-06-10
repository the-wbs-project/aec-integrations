import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { MostActiveCategory, MostIntegratedProduct } from '@aeci/shared';

import { IntegrationStat } from '../products/integration-stat';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';

/**
 * AECI-183 (Phase 4.8) — the three above-the-fold home stats cards. Purely
 * presentational: it renders fields of `HomeStatsResponse` passed in as signal
 * inputs and does no fetching (the resolver is wired by the 4.11 page assembly).
 *
 * Treatment is fixed by `docs/design/home-direction.md` ("Three stats cards"):
 * the **score-display / spec-sheet** posture, NOT the banned hero-metric template
 * (DESIGN.md §6). Bordered cards (`--surface-raised`, `rounded-(--radius-lg)`,
 * border not shadow; `--border-strong` on hover for the two linked cards). Forest
 * (`--accent-primary`) carries every figure; Clay is spent nowhere on this surface.
 *
 * Cards 2 and 3 are whole-card links — the same single-`<a>` Faire vocabulary the
 * shipped `ProductCardGrid` uses (Anchor-Site Rule), so the front door reads as one
 * publication with `/products`. Counts reuse `IntegrationStat` `headline`; the
 * product monogram reuses `LogoOrInitial`. Nothing is reinvented.
 *
 * Empty / pre-launch states are first-class (the cache is sparse at launch): a
 * `0` total renders "No integrations indexed yet" (never a bare 0), the "+X"
 * delta line is suppressed at 0 (never "+0"), and a `null` product/category
 * renders a non-link "No … data yet" card. All small/label text uses
 * `--text-secondary` (AA-safe) — never `--text-tertiary`, which fails WCAG AA
 * (~2.6:1) and bit AECI-148/150/166. Both themes via tokens; i18n throughout.
 */
@Component({
  selector: 'aec-home-stats-cards',
  imports: [RouterLink, LogoOrInitial, IntegrationStat],
  template: `
    <section
      class="grid grid-cols-1 gap-4 md:grid-cols-3"
      aria-label="Directory at a glance"
      i18n-aria-label="@@home.stats.region.aria"
    >
      <!-- Card 1: total integrations indexed (+30d). Not a link. -->
      <div
        class="flex h-full flex-col gap-2 rounded-(--radius-lg) border border-(--border-default)
          bg-(--surface-raised) p-6"
      >
        <p class="text-sm text-(--text-secondary)" i18n="@@home.stats.total.label">
          Total integrations indexed
        </p>
        @if (totalIntegrations() > 0) {
          <p class="font-display text-5xl font-semibold tabular-nums text-(--accent-primary)">
            {{ totalIntegrations() }}
          </p>
          @if (integrationsAdded30d() > 0) {
            <p class="text-sm text-(--text-secondary)" i18n="@@home.stats.total.delta">
              +{{ integrationsAdded30d() }} in the last 30 days
            </p>
          }
        } @else {
          <p
            class="font-display text-2xl font-semibold text-(--text-primary)"
            i18n="@@home.stats.total.empty"
          >
            No integrations indexed yet
          </p>
        }
      </div>

      <!-- Card 2: most integrated product. Whole-card link to /products/:slug. -->
      @if (mostIntegratedProduct(); as mip) {
        <a
          [routerLink]="['/products', mip.product.slug]"
          class="flex h-full flex-col gap-3 rounded-(--radius-lg) border border-(--border-default)
            bg-(--surface-raised) p-6 no-underline transition-colors hover:border-(--border-strong)
            focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        >
          <p class="text-sm text-(--text-secondary)" i18n="@@home.stats.product.label">
            Most integrated product
          </p>
          <span class="flex items-center gap-3">
            <aec-logo-or-initial [src]="mip.product.logo_url" [name]="mip.product.name" size="sm" />
            <span class="min-w-0 truncate font-display text-xl font-semibold text-(--text-primary)">
              {{ mip.product.name }}
            </span>
          </span>
          <aec-integration-stat [count]="mip.integration_count" variant="headline" />
        </a>
      } @else {
        <div
          class="flex h-full flex-col gap-2 rounded-(--radius-lg) border border-(--border-default)
            bg-(--surface-raised) p-6"
        >
          <p class="text-sm text-(--text-secondary)" i18n="@@home.stats.product.label">
            Most integrated product
          </p>
          <p class="text-sm text-(--text-secondary)" i18n="@@home.stats.product.empty">
            No product data yet
          </p>
        </div>
      }

      <!-- Card 3: most active category. Whole-card link to /categories/:slug. -->
      @if (mostActiveCategory(); as mac) {
        <a
          [routerLink]="['/categories', mac.category.slug]"
          class="flex h-full flex-col gap-3 rounded-(--radius-lg) border border-(--border-default)
            bg-(--surface-raised) p-6 no-underline transition-colors hover:border-(--border-strong)
            focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        >
          <p class="text-sm text-(--text-secondary)" i18n="@@home.stats.category.label">
            Most active category
          </p>
          <span class="min-w-0 truncate font-display text-xl font-semibold text-(--text-primary)">
            {{ mac.category.name }}
          </span>
          <aec-integration-stat [count]="mac.integration_count" variant="headline" />
        </a>
      } @else {
        <div
          class="flex h-full flex-col gap-2 rounded-(--radius-lg) border border-(--border-default)
            bg-(--surface-raised) p-6"
        >
          <p class="text-sm text-(--text-secondary)" i18n="@@home.stats.category.label">
            Most active category
          </p>
          <p class="text-sm text-(--text-secondary)" i18n="@@home.stats.category.empty">
            No category data yet
          </p>
        </div>
      }
    </section>
  `,
})
export class HomeStatsCards {
  /** `HomeStatsResponse.total_integrations` — `0` renders the empty state, not a bare 0. */
  readonly totalIntegrations = input.required<number>();
  /** `HomeStatsResponse.integrations_added_30d` — the "+X" line is omitted at 0. */
  readonly integrationsAdded30d = input.required<number>();
  /** `HomeStatsResponse.most_integrated_product` — `null` renders the non-link empty card. */
  readonly mostIntegratedProduct = input.required<MostIntegratedProduct | null>();
  /** `HomeStatsResponse.most_active_category` — `null` renders the non-link empty card. */
  readonly mostActiveCategory = input.required<MostActiveCategory | null>();
}
