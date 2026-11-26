/**
 * About page (`/about`, AECI-238 / Phase 7.3). The trust-first story per
 * `PRODUCT.md`: why an independent directory exists, how AECi is different
 * (AEC-native taxonomy, dual reviews separating product from onboarding,
 * vendor-confirmed but never vendor-controlled), the three trust commitments, and
 * who it serves.
 *
 * **Static + edge-cache / SSR-safe.** No data fetch, no per-visitor state, and no
 * client JS — all copy renders into the cacheable, visitor-state-neutral HTML
 * (`/about` carries `Cache-Tag: route:index` with a 24h edge / 1h browser TTL via
 * `ROUTE_CACHE_PATTERNS` + `cacheTagInputsForPath`). The page is indexable, so
 * `setStaticPageMeta` sets title + description + canonical + OG (no `robots`).
 * Meta is set from the constructor (like `Home`) so it ships in the SSR head AND
 * refreshes on an in-app navigation onto `/about`.
 *
 * Voice per `PRODUCT.md`: editorial, sentence case, no hyperbole, no competitor
 * call-outs on the public site.
 *
 * **Layout (AECI-1800, the redesign language as built on the home page).** Four
 * bands, every one on the 1328px page wrap (`BAND_WRAP_CLASS`):
 *
 *   1. The hero on `aec-bone-band`, the page's one Bone band (clash 2). The h1 is
 *      the Headline role (the global h1 size), not Display: clash 7 allows Display
 *      on detail pages, and this is a content page.
 *   2. White: "Why we exist" and "How we're different".
 *   3. White, after a hairline: the three commitments (`<aec-home-trust-pillars>`).
 *      They left their full-bleed Forest band, because Forest may fill only the
 *      header, a detail page hero, the footer and one feature card. They are now
 *      the page's one Forest feature card (Chris, ruling 2026-11-17).
 *   4. White, after a hairline: "Who it's for" and "Start exploring".
 *
 * Each section row puts its heading left and its content right from `lg`, the
 * home argument band's 5:7 split, so the prose keeps its 70ch measure without a
 * blank right half. Section headings take the Section role (`--t-36`) on an inner
 * span. The onward links are standalone links (DESIGN.md "The Link Treatment
 * Rule"). The words, the headings and the section order are unchanged.
 *
 * Light theme only (Stage 1). All strings authored with `i18n`/`$localize`.
 */
import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { HomeTrustPillars } from '../home/home-trust-pillars';
import { BAND_WRAP_CLASS } from '../shared/band-wrap';
import { BoneBand } from '../shared/bone-band/bone-band';

@Component({
  selector: 'app-about',
  imports: [RouterLink, BoneBand, HomeTrustPillars],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <!-- 1. Hero: the page's one Bone band. -->
      <aec-bone-band>
        <div class="max-w-[70ch]">
          <p class="aec-overline text-(--text-secondary)" i18n="@@app.about.eyebrow">About</p>
          <h1 class="mt-4 text-(--text-primary)" i18n="@@app.about.headline">
            The directory AEC teams couldn't find anywhere else
          </h1>
          <p
            class="mt-6 max-w-[36em] text-t-20 leading-normal text-(--text-secondary)"
            i18n="@@app.about.lede"
          >
            AEC Integrations is an independent directory and review platform for the software
            integrations that architecture, engineering, and construction teams depend on. No
            pay-for-placement. Payment never changes the order of results.
          </p>
        </div>
      </aec-bone-band>

      <!-- 2. White: why we exist, then how we are different. -->
      <div class="py-16 md:py-24">
        <div [class]="wrap">
          <div class="flex flex-col gap-16 md:gap-24">
            <!-- Why we exist -->
            <section [class]="row">
              <h2 class="text-(--text-primary)">
                <span [class]="sectionTitle" i18n="@@app.about.why.heading">Why we exist</span>
              </h2>
              <div [class]="prose">
                <p i18n="@@app.about.why.p1">
                  Choosing software is one of the most consequential decisions an AEC firm makes,
                  and the sources meant to help are the least trustworthy part of the process.
                  General-purpose software directories sell ranking position, bury the few useful
                  signals under advertising, and treat a structural engineering platform the same as
                  a generic business app.
                </p>
                <p i18n="@@app.about.why.p2">
                  The questions that actually matter to AEC teams go unanswered: which tools connect
                  to what, whether an integration survives contact with a real project, and where
                  the onboarding hurts. We built AEC Integrations to answer them.
                </p>
              </div>
            </section>

            <!-- How we're different -->
            <section [class]="row">
              <h2 class="text-(--text-primary)">
                <span [class]="sectionTitle" i18n="@@app.about.different.heading"
                  >How we're different</span
                >
              </h2>
              <ul class="flex max-w-[70ch] flex-col gap-8">
                <li>
                  <h3 class="text-(--text-primary)" i18n="@@app.about.different.taxonomy.title">
                    AEC-native taxonomy
                  </h3>
                  <p [class]="itemBody" i18n="@@app.about.different.taxonomy.body">
                    Our categories, vocabulary, and editorial judgment come from inside the
                    industry. We take positions on what a category is and what is just marketing,
                    instead of flattening every tool into an identical grid.
                  </p>
                </li>
                <li>
                  <h3 class="text-(--text-primary)" i18n="@@app.about.different.reviews.title">
                    Reviews that separate the product from the onboarding
                  </h3>
                  <p [class]="itemBody" i18n="@@app.about.different.reviews.body">
                    Every integration is reviewed on two axes: how well the product works, and how
                    the onboarding actually felt. Most directories mash these together and lose the
                    part practitioners care about most.
                  </p>
                </li>
                <li>
                  <h3 class="text-(--text-primary)" i18n="@@app.about.different.curation.title">
                    Vendors maintain their integrations, never their ranking
                  </h3>
                  <p [class]="itemBody" i18n="@@app.about.different.curation.body">
                    We seed the catalog from public research. The vendor that offers an integration
                    can take it over and keep its details current, and every claim stays labeled
                    “Listed by AEC Integrations” until the vendors involved confirm it. Vendors
                    never pay to rank, never pay to remove a review, and never set the order of
                    results. Rankings are algorithmic, always.
                  </p>
                </li>
              </ul>
            </section>
          </div>
        </div>
      </div>

      <!-- 3. White: the three trust commitments. This page is the band's only mount. -->
      <div class="border-t py-16 md:py-24">
        <div [class]="wrap">
          <aec-home-trust-pillars />
        </div>
      </div>

      <!-- 4. White: who it is for, then the routes onward. -->
      <div class="border-t py-16 md:py-24">
        <div [class]="wrap">
          <div class="flex flex-col gap-16 md:gap-24">
            <!-- Who it's for -->
            <section [class]="row">
              <h2 class="text-(--text-primary)">
                <span [class]="sectionTitle" i18n="@@app.about.audience.heading">Who it's for</span>
              </h2>
              <div [class]="prose">
                <p i18n="@@app.about.audience.p1">
                  AEC Integrations is built for the people making and living with these decisions:
                  the technology directors and principals who have to defend a six- or seven-figure
                  choice to a steering committee, and the architects, engineers, and project
                  managers who will use the tool every day and whose experience feeds that choice.
                </p>
                <p i18n="@@app.about.audience.p2">
                  Software vendors get a fair hearing too, because the platform is editorially
                  neutral. An accurate, well-represented profile is never something you have to pay
                  for.
                </p>
              </div>
            </section>

            <!-- Closing: route onward to the directory or to contact. -->
            <section [class]="row">
              <h2 class="text-(--text-primary)">
                <span [class]="sectionTitle" i18n="@@app.about.next.heading">Start exploring</span>
              </h2>
              <div class="max-w-[70ch]">
                <p
                  class="text-t-16 leading-relaxed text-(--text-secondary)"
                  i18n="@@app.about.next.body"
                >
                  Browse the directory to see which tools connect to what, read how the catalog is
                  built and checked, or get in touch if you have a question or a correction.
                </p>
                <!-- Standalone links. The negative margin lines their text up with
                     the paragraph above. -->
                <div class="-mx-3 mt-4 flex flex-wrap gap-x-2 gap-y-1">
                  <a routerLink="/products" [class]="standaloneLink" i18n="@@app.about.next.browse">
                    Browse the directory
                  </a>
                  <a
                    routerLink="/methodology"
                    [class]="standaloneLink"
                    i18n="@@app.about.next.methodology"
                  >
                    How we work
                  </a>
                  <a routerLink="/contact" [class]="standaloneLink" i18n="@@app.about.next.contact">
                    Contact us
                  </a>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  `,
})
export class AboutPage {
  private readonly meta = inject(MetaService);

  /** The 1328px page wrap the header, footer and bands share. */
  protected readonly wrap = BAND_WRAP_CLASS;

  /** One section row: heading left and content right from `lg` (5:7, as `home-why.ts`). */
  protected readonly row = 'grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16';

  /** The Section role on an inner span, so the unlayered h2 rule cannot beat it. */
  protected readonly sectionTitle = 'block text-t-36 leading-[1.1] tracking-[-0.02em]';

  /** Section prose at the Body role, capped at the reading measure. */
  protected readonly prose =
    'grid max-w-[70ch] gap-4 text-t-16 leading-relaxed text-(--text-secondary)';

  /** The body under each "How we're different" item. */
  protected readonly itemBody = 'mt-2 text-t-16 leading-relaxed text-(--text-secondary)';

  /** The standalone link recipe (DESIGN.md "The Link Treatment Rule"). */
  protected readonly standaloneLink =
    'rounded-(--radius-md) px-3 py-2 text-t-14 font-semibold text-(--text-secondary) underline decoration-(--border-strong) underline-offset-4 hover:text-(--text-primary)';

  constructor() {
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.aboutTitle:About · AEC Integrations`,
      description: $localize`:@@meta.aboutDescription:AEC Integrations is the independent directory of AEC software integrations. Trust-first, with no pay-for-placement.`,
      canonical: canonicalUrl('/about'),
    });
  }
}
