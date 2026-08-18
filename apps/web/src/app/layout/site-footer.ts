/**
 * Site footer.
 *
 * Anchor: Stripe (stripe.com) — structured footer with a brand-area column,
 * directory nav, legal nav, and company nav. Copyright lives on a bottom strip
 * separated by a thin border. The Directory column carries the primary section
 * links (Home, Products, and the three taxonomy facets) in server-rendered HTML,
 * since the header's flyout values render client-side and its overlay is a
 * click-mounted overlay that never reaches SSR (see `nav-menu.ts`). Vendors /
 * Integrations were pulled from the nav and footer (AECI-160, PO decision);
 * AECI-165 then removed the `/vendors` and `/integrations` index pages entirely
 * (they now 301-redirect to `/products`). Their DETAIL pages stay reachable via
 * product → vendor / integration links, `sitemap.xml`, and direct URL / search.
 *
 * Layout: the brand area and the nav group are two flex regions. The nav group
 * is its own responsive grid (2 cols on mobile → 3 cols from `sm`) so the three
 * navs stay balanced instead of the brand eating a full quarter-column and
 * leaving a dead zone at tablet widths. From `lg` the brand sits left and the
 * nav group right (Stripe anchor).
 *
 * Year is frozen at class init so SSR and client render the same value (no
 * `new Date()` in the template — see ANGULAR_STYLE_GUIDE.md §8, §16).
 */
import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { BrandLogo } from './brand-logo';

@Component({
  selector: 'aec-site-footer',
  imports: [RouterLink, BrandLogo],
  template: `
    <footer class="border-t border-(--border-default) bg-(--surface-raised)">
      <div
        class="mx-auto flex max-w-7xl flex-col gap-10 px-8 py-12 lg:flex-row lg:justify-between lg:gap-16"
      >
        <div class="lg:max-w-xs">
          <aec-brand-logo [height]="28" />
          <p class="mt-3 max-w-xs text-sm text-(--text-secondary)" i18n="@@app.footer.tagline">
            The independent directory of AEC software integrations.
          </p>
        </div>
        <div class="grid grid-cols-2 gap-x-10 gap-y-8 sm:grid-cols-3">
          <nav class="text-sm" i18n-aria-label="@@app.footer.directory.aria" aria-label="Directory">
            <p
              class="mb-3 text-xs uppercase tracking-wide text-(--text-secondary)"
              i18n="@@app.footer.directory.eyebrow"
            >
              Directory
            </p>
            <ul class="space-y-2">
              <li>
                <a
                  routerLink="/"
                  class="text-(--text-secondary) hover:text-(--text-primary)"
                  i18n="@@app.nav.home"
                >
                  Home
                </a>
              </li>
              <li>
                <a
                  routerLink="/products"
                  class="text-(--text-secondary) hover:text-(--text-primary)"
                  i18n="@@app.nav.products"
                >
                  Products
                </a>
              </li>
              <li>
                <a
                  routerLink="/categories"
                  class="text-(--text-secondary) hover:text-(--text-primary)"
                >
                  <!-- Tight i18n wrap so the source matches taxonomy-nav-copy.ts's
                       $localize (shared @@app.nav.* id): avoids a duplicate-id
                       collision in extraction (mirrors the AECI-67 fix). The
                       Legal + Company links below carry the same wrap for the
                       same reason: the header's "More" menu renders them from
                       more-menu-links.ts under these same @@app.footer.* ids. -->
                  <ng-container i18n="@@app.nav.categories">Categories</ng-container>
                </a>
              </li>
              <li>
                <a
                  routerLink="/audiences"
                  class="text-(--text-secondary) hover:text-(--text-primary)"
                >
                  <ng-container i18n="@@app.nav.audiences">Audiences</ng-container>
                </a>
              </li>
              <li>
                <a routerLink="/trades" class="text-(--text-secondary) hover:text-(--text-primary)">
                  <ng-container i18n="@@app.nav.trades">Trades</ng-container>
                </a>
              </li>
              <li>
                <a routerLink="/phases" class="text-(--text-secondary) hover:text-(--text-primary)">
                  <ng-container i18n="@@app.nav.phases">Phases</ng-container>
                </a>
              </li>
            </ul>
          </nav>
          <nav class="text-sm" i18n-aria-label="@@app.footer.legal.aria" aria-label="Legal">
            <p class="mb-3 text-xs uppercase tracking-wide text-(--text-secondary)">
              <ng-container i18n="@@app.footer.legal.eyebrow">Legal</ng-container>
            </p>
            <ul class="space-y-2">
              <li>
                <a
                  routerLink="/legal/terms"
                  class="text-(--text-secondary) hover:text-(--text-primary)"
                  ><ng-container i18n="@@app.footer.legal.terms">Terms</ng-container></a
                >
              </li>
              <li>
                <a
                  routerLink="/legal/privacy"
                  class="text-(--text-secondary) hover:text-(--text-primary)"
                  ><ng-container i18n="@@app.footer.legal.privacy">Privacy</ng-container></a
                >
              </li>
              <li>
                <a
                  routerLink="/legal/review-guidelines"
                  class="text-(--text-secondary) hover:text-(--text-primary)"
                  ><ng-container i18n="@@app.footer.legal.reviewGuidelines"
                    >Review guidelines</ng-container
                  ></a
                >
              </li>
              <li>
                <a
                  routerLink="/legal/listing-accuracy"
                  class="text-(--text-secondary) hover:text-(--text-primary)"
                  ><ng-container i18n="@@app.footer.legal.listingAccuracy"
                    >Listing accuracy</ng-container
                  ></a
                >
              </li>
            </ul>
          </nav>
          <nav class="text-sm" i18n-aria-label="@@app.footer.company.aria" aria-label="Company">
            <p
              class="mb-3 text-xs uppercase tracking-wide text-(--text-secondary)"
              i18n="@@app.footer.company.eyebrow"
            >
              Company
            </p>
            <ul class="space-y-2">
              <li>
                <a routerLink="/about" class="text-(--text-secondary) hover:text-(--text-primary)"
                  ><ng-container i18n="@@app.footer.about">About</ng-container></a
                >
              </li>
              <li>
                <a routerLink="/contact" class="text-(--text-secondary) hover:text-(--text-primary)"
                  ><ng-container i18n="@@app.footer.contact">Contact</ng-container></a
                >
              </li>
            </ul>
          </nav>
        </div>
      </div>
      <div class="border-t border-(--border-default) px-8 py-4 text-xs text-(--text-secondary)">
        <p class="mx-auto max-w-7xl" i18n="@@app.footer.copyright">
          © {{ year }} AEC Integrations.
        </p>
      </div>
    </footer>
  `,
})
export class SiteFooter {
  protected readonly year = new Date().getFullYear();
}
