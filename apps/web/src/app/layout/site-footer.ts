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
      <div class="mx-auto grid max-w-7xl gap-10 px-8 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <aec-brand-logo [height]="28" />
          <p class="mt-3 max-w-xs text-sm text-(--text-secondary)" i18n="@@app.footer.tagline">
            Vendor-verified reviews for AEC software integrations.
          </p>
        </div>
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
                     collision in extraction (mirrors the AECI-67 fix). -->
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
              <a routerLink="/phases" class="text-(--text-secondary) hover:text-(--text-primary)">
                <ng-container i18n="@@app.nav.phases">Phases</ng-container>
              </a>
            </li>
          </ul>
        </nav>
        <nav class="text-sm" i18n-aria-label="@@app.footer.legal.aria" aria-label="Legal">
          <p
            class="mb-3 text-xs uppercase tracking-wide text-(--text-secondary)"
            i18n="@@app.footer.legal.eyebrow"
          >
            Legal
          </p>
          <ul class="space-y-2">
            <li>
              <a
                routerLink="/legal/terms"
                class="text-(--text-secondary) hover:text-(--text-primary)"
                i18n="@@app.footer.legal.terms"
              >
                Terms
              </a>
            </li>
            <li>
              <a
                routerLink="/legal/privacy"
                class="text-(--text-secondary) hover:text-(--text-primary)"
                i18n="@@app.footer.legal.privacy"
              >
                Privacy
              </a>
            </li>
            <li>
              <a
                routerLink="/legal/review-guidelines"
                class="text-(--text-secondary) hover:text-(--text-primary)"
                i18n="@@app.footer.legal.reviewGuidelines"
              >
                Review guidelines
              </a>
            </li>
            <li>
              <a
                routerLink="/legal/listing-accuracy"
                class="text-(--text-secondary) hover:text-(--text-primary)"
                i18n="@@app.footer.legal.listingAccuracy"
              >
                Listing accuracy
              </a>
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
              <a
                routerLink="/contact"
                class="text-(--text-secondary) hover:text-(--text-primary)"
                i18n="@@app.footer.contact"
              >
                Contact
              </a>
            </li>
          </ul>
        </nav>
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
