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
 * **This is the overflow home.** The header's `More▾` menu was retired: the
 * primary row is public-directory-only and closed, so a secondary destination
 * comes here rather than into a header menu (DESIGN.md §Navigation → The
 * Overflow Rule). The footer already carried ten of that menu's twelve links;
 * Updates and Roadmap were the two it lacked and now sit in Company. Nothing was
 * lost to crawlers in the move — the old panel was `[hidden]`, not unmounted, so
 * those links were server-rendered there and are server-rendered here.
 *
 * Because the footer is now load-bearing for secondary navigation, its columns
 * are pinned by `site-footer.component.spec.ts`: a link silently dropping out is
 * a regression, not a tidy-up.
 *
 * Layout: the brand area and the nav group are two flex regions. The nav group
 * is its own responsive grid (2 cols below `md` → 4 cols from `md`) so the four
 * navs stay balanced: a 2×2 block on phones and small tablets, one row from
 * `md`. Three columns at `sm` would orphan the fourth on a second row. From
 * `lg` the brand sits left and the nav group right (Stripe anchor). The nav
 * group is `shrink-0`: at 1024px the brand's tagline gives up width, so no link
 * label wraps ("How ranking works" did before).
 *
 * The Help column (AECI-1252) is the footer-only entry into `/docs`
 * (STAGE_2_PRODUCT_DOCS_SPEC.md §7 question 3). "Vendor guide" (AECI-1253) is
 * its last link, to `/docs/vendors/overview`, the vendor guide's first page.
 *
 * The Company column's "For vendors" (AECI-1283) is the public vendor landing page,
 * `/vendor-program` (VENDOR_PROGRAM_PAGE_SPEC.md §2.4). It sits after Methodology.
 * The header gets no link (that spec's §13 question 3). The Help column's link
 * is labelled "Vendor guide" so no two footer links share a name.
 *
 * AECI-1776: the footer sits on the Forest footer ground (`--surface-footer`, DESIGN.md
 * §5 "The footer"). Links are Bone and underline on hover, labels are overlines in
 * `--text-on-footer-secondary`. Columns, links and order are unchanged, plus one
 * "Third-party notices" link to the static `/third-party-notices.txt` (a plain href,
 * not a route).
 *
 * Year is frozen at class init so SSR and client render the same value (no
 * `new Date()` in the template — see ANGULAR_STYLE_GUIDE.md §8, §16).
 */
import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ACCESSIBILITY_STATEMENT_PUBLISHED } from '../accessibility/accessibility-published';
import { BrandLogo } from './brand-logo';

@Component({
  selector: 'aec-site-footer',
  imports: [RouterLink, BrandLogo],
  template: `
    <footer class="bg-(--surface-footer) text-(--text-on-brand)">
      <div
        class="mx-auto flex max-w-7xl flex-col gap-10 px-8 pb-12 pt-16 lg:flex-row lg:justify-between lg:gap-16"
      >
        <div class="lg:max-w-xs">
          <aec-brand-logo tone="on-dark" [height]="28" [priority]="false" />
          <p
            class="mt-3 max-w-xs text-sm text-(--text-on-footer-secondary)"
            i18n="@@app.footer.tagline"
          >
            The independent directory of AEC software integrations.
          </p>
        </div>
        <div class="grid shrink-0 grid-cols-2 gap-x-10 gap-y-8 md:grid-cols-[repeat(4,auto)]">
          <nav i18n-aria-label="@@app.footer.directory.aria" aria-label="Directory">
            <p
              class="aec-overline mb-4 text-(--text-on-footer-secondary)"
              i18n="@@app.footer.directory.eyebrow"
            >
              Directory
            </p>
            <ul class="space-y-3">
              <li>
                <a routerLink="/" [class]="linkClass" i18n="@@app.nav.home"> Home </a>
              </li>
              <li>
                <a routerLink="/products" [class]="linkClass" i18n="@@app.nav.products">
                  Products
                </a>
              </li>
              <li>
                <a routerLink="/categories" [class]="linkClass">
                  <!-- Tight i18n wrap so the source matches taxonomy-nav-copy.ts's
                       $localize (shared @@app.nav.* id): avoids a duplicate-id
                       collision in extraction (mirrors the AECI-67 fix). The
                       Legal + Company links below keep the same wrap: several
                       reuse @@app.nav.* / @@app.footer.* ids that other surfaces
                       also emit, and an identical source string is one
                       translation unit rather than a collision. -->
                  <ng-container i18n="@@app.nav.categories">Categories</ng-container>
                </a>
              </li>
              <li>
                <a routerLink="/audiences" [class]="linkClass">
                  <ng-container i18n="@@app.nav.audiences">Audiences</ng-container>
                </a>
              </li>
              <li>
                <a routerLink="/trades" [class]="linkClass">
                  <ng-container i18n="@@app.nav.trades">Trades</ng-container>
                </a>
              </li>
              <li>
                <a routerLink="/phases" [class]="linkClass">
                  <ng-container i18n="@@app.nav.phases">Phases</ng-container>
                </a>
              </li>
            </ul>
          </nav>
          <nav i18n-aria-label="@@app.footer.help.aria" aria-label="Help">
            <p class="aec-overline mb-4 text-(--text-on-footer-secondary)">
              <ng-container i18n="@@app.footer.help.eyebrow">Help</ng-container>
            </p>
            <ul class="space-y-3">
              <li>
                <a routerLink="/docs" [class]="linkClass"
                  ><ng-container i18n="@@app.footer.help.helpCenter">Help center</ng-container></a
                >
              </li>
              <li>
                <a routerLink="/docs/getting-started" [class]="linkClass"
                  ><ng-container i18n="@@app.footer.help.gettingStarted"
                    >Getting started</ng-container
                  ></a
                >
              </li>
              <li>
                <a routerLink="/docs/trust/how-ranking-works" [class]="linkClass"
                  ><ng-container i18n="@@app.footer.help.howRankingWorks"
                    >How ranking works</ng-container
                  ></a
                >
              </li>
              <li>
                <a routerLink="/docs/vendors/overview" [class]="linkClass"
                  ><ng-container i18n="@@app.footer.help.vendorGuide">Vendor guide</ng-container></a
                >
              </li>
            </ul>
          </nav>
          <nav i18n-aria-label="@@app.footer.legal.aria" aria-label="Legal">
            <p class="aec-overline mb-4 text-(--text-on-footer-secondary)">
              <ng-container i18n="@@app.footer.legal.eyebrow">Legal</ng-container>
            </p>
            <ul class="space-y-3">
              <li>
                <a routerLink="/legal/terms" [class]="linkClass"
                  ><ng-container i18n="@@app.footer.legal.terms">Terms</ng-container></a
                >
              </li>
              <li>
                <a routerLink="/legal/privacy" [class]="linkClass"
                  ><ng-container i18n="@@app.footer.legal.privacy">Privacy</ng-container></a
                >
              </li>
              <li>
                <a routerLink="/legal/review-guidelines" [class]="linkClass"
                  ><ng-container i18n="@@app.footer.legal.reviewGuidelines"
                    >Review guidelines</ng-container
                  ></a
                >
              </li>
              <li>
                <a routerLink="/legal/listing-accuracy" [class]="linkClass"
                  ><ng-container i18n="@@app.footer.legal.listingAccuracy"
                    >Listing accuracy</ng-container
                  ></a
                >
              </li>
              <li>
                <a routerLink="/legal/vendor-terms" [class]="linkClass"
                  ><ng-container i18n="@@app.footer.legal.vendorTerms"
                    >Vendor terms</ng-container
                  ></a
                >
              </li>
              <li>
                <a routerLink="/legal/managed-plan-agreement" [class]="linkClass"
                  ><ng-container i18n="@@app.footer.legal.managedPlanAgreement"
                    >Managed plan agreement</ng-container
                  ></a
                >
              </li>
              <!-- Hidden until AECI-1687 (accessibility-published.ts). -->
              @if (accessibilityPublished) {
                <li>
                  <a routerLink="/accessibility" [class]="linkClass"
                    ><ng-container i18n="@@app.footer.legal.accessibility"
                      >Accessibility</ng-container
                    ></a
                  >
                </li>
              }
              <!-- A static text file, not an app route: a plain href, same tab. -->
              <li>
                <a
                  href="/third-party-notices.txt"
                  [class]="linkClass"
                  i18n="@@app.footer.legal.thirdPartyNotices"
                  >Third-party notices</a
                >
              </li>
            </ul>
          </nav>
          <nav i18n-aria-label="@@app.footer.company.aria" aria-label="Company">
            <p
              class="aec-overline mb-4 text-(--text-on-footer-secondary)"
              i18n="@@app.footer.company.eyebrow"
            >
              Company
            </p>
            <ul class="space-y-3">
              <li>
                <a routerLink="/about" [class]="linkClass"
                  ><ng-container i18n="@@app.footer.about">About</ng-container></a
                >
              </li>
              <li>
                <a routerLink="/methodology" [class]="linkClass"
                  ><ng-container i18n="@@app.footer.methodology">Methodology</ng-container></a
                >
              </li>
              <li>
                <a routerLink="/vendor-program" [class]="linkClass"
                  ><ng-container i18n="@@app.footer.vendorProgram">For vendors</ng-container></a
                >
              </li>
              <li>
                <a routerLink="/contact" [class]="linkClass"
                  ><ng-container i18n="@@app.footer.contact">Contact</ng-container></a
                >
              </li>
              <!-- The forward-looking pair, moved here when the header's "More"
                   menu was retired. They keep their @@app.nav.* ids: the string
                   is unchanged, so it stays one translation unit. -->
              <li>
                <a routerLink="/updates" [class]="linkClass"
                  ><ng-container i18n="@@app.nav.updates">Updates</ng-container></a
                >
              </li>
              <li>
                <a routerLink="/roadmap" [class]="linkClass"
                  ><ng-container i18n="@@app.nav.roadmap">Roadmap</ng-container></a
                >
              </li>
            </ul>
          </nav>
        </div>
      </div>
      <div class="aec-on-brand-rule border-t">
        <p
          class="mx-auto max-w-7xl px-8 pb-8 pt-6 text-sm text-(--text-on-brand)"
          i18n="@@app.footer.copyright"
        >
          © {{ year }} AEC Integrations.
        </p>
      </div>
    </footer>
  `,
})
export class SiteFooter {
  /**
   * Bone ink, a Bone underline on hover and focus, never a colour change:
   * `--text-on-footer-secondary` fails on a hover fill (DESIGN.md §5 The footer).
   * 24px line box meets the 24px target size (WCAG 2.5.8).
   */
  protected readonly linkClass =
    'inline-block rounded-(--radius-sm) text-base leading-6 text-(--text-on-brand) underline-offset-[3px] hover:underline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--focus-ring-on-brand)';
  protected readonly year = new Date().getFullYear();
  protected readonly accessibilityPublished = ACCESSIBILITY_STATEMENT_PUBLISHED;
}
