/**
 * About page (`/about`, AECI-238 / Phase 7.3). The trust-first story per
 * `PRODUCT.md`: why an independent directory exists, how AECi is different
 * (AEC-native taxonomy, dual reviews separating product from onboarding,
 * vendor-verified but never vendor-controlled), the three trust commitments, and
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
 * call-outs on the public site. Layout per `DESIGN.md`: a warm Bone (`accent-warm`)
 * hero band (never a page background), body measure capped at 70ch on long-form
 * prose, Source Serif display/headline for headings, Atkinson body for prose.
 * The three commitments use the shared `<aec-home-trust-pillars>` band. (Since
 * AECI-273 the home no longer mounts this band — its differentiation moved to
 * `home-differentiation.ts`, which folds the same promise into its closing line —
 * so this page is now its only mount, but the positioning still reads identically
 * across the home's differentiation band and here.)
 *
 * Light theme only (Stage 1). All strings authored with `i18n`/`$localize`.
 */
import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { HomeTrustPillars } from '../home/home-trust-pillars';

@Component({
  selector: 'app-about',
  imports: [RouterLink, HomeTrustPillars],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <!-- Hero: warm Bone accent band with a thin bottom border (the
           Surfaces-Are-Neutral accent-band treatment, not a page background). -->
      <section class="border-b border-(--border-default) bg-(--accent-warm)">
        <div class="mx-auto max-w-7xl px-6 py-16 md:px-8 md:py-20">
          <div class="max-w-[70ch]">
            <p class="aec-overline text-(--accent-primary)" i18n="@@app.about.eyebrow">About</p>
            <h1
              class="mt-3 font-display text-4xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-5xl"
              i18n="@@app.about.headline"
            >
              The directory AEC teams couldn't find anywhere else
            </h1>
            <p class="mt-5 text-lg leading-relaxed text-(--text-secondary)" i18n="@@app.about.lede">
              AEC Integrations is an independent directory and review platform for the software
              integrations that architecture, engineering, and construction teams depend on. No
              vendor marketing, no pay-for-placement, no blurred line between editorial and revenue.
            </p>
          </div>
        </div>
      </section>

      <div class="mx-auto max-w-7xl px-6 py-12 md:px-8 md:py-16">
        <div class="flex max-w-[70ch] flex-col gap-12">
          <!-- Why we exist -->
          <section>
            <h2
              class="font-display text-2xl font-normal leading-snug text-(--text-primary) md:text-3xl"
              i18n="@@app.about.why.heading"
            >
              Why we exist
            </h2>
            <p
              class="mt-4 text-base leading-relaxed text-(--text-secondary)"
              i18n="@@app.about.why.p1"
            >
              Choosing software is one of the most consequential decisions an AEC firm makes, and
              the sources meant to help are the least trustworthy part of the process.
              General-purpose software directories sell ranking position, bury the few useful
              signals under advertising, and treat a structural engineering platform the same as a
              generic business app.
            </p>
            <p
              class="mt-4 text-base leading-relaxed text-(--text-secondary)"
              i18n="@@app.about.why.p2"
            >
              The questions that actually matter to AEC teams go unanswered: which tools connect to
              what, whether an integration survives contact with a real project, and where the
              onboarding hurts. We built AEC Integrations to answer them.
            </p>
          </section>

          <!-- How we're different -->
          <section>
            <h2
              class="font-display text-2xl font-normal leading-snug text-(--text-primary) md:text-3xl"
              i18n="@@app.about.different.heading"
            >
              How we're different
            </h2>
            <ul class="mt-6 flex flex-col gap-6">
              <li>
                <h3
                  class="font-display text-xl leading-snug text-(--text-primary)"
                  i18n="@@app.about.different.taxonomy.title"
                >
                  AEC-native taxonomy
                </h3>
                <p
                  class="mt-2 text-base leading-relaxed text-(--text-secondary)"
                  i18n="@@app.about.different.taxonomy.body"
                >
                  Our categories, vocabulary, and editorial judgment come from inside the industry.
                  We take positions on what a category is and what is just marketing, instead of
                  flattening every tool into an identical grid.
                </p>
              </li>
              <li>
                <h3
                  class="font-display text-xl leading-snug text-(--text-primary)"
                  i18n="@@app.about.different.reviews.title"
                >
                  Reviews that separate the product from the onboarding
                </h3>
                <p
                  class="mt-2 text-base leading-relaxed text-(--text-secondary)"
                  i18n="@@app.about.different.reviews.body"
                >
                  Every integration is reviewed on two axes: how well the product works, and how the
                  onboarding actually felt. Most directories mash these together and lose the part
                  practitioners care about most.
                </p>
              </li>
              <li>
                <h3
                  class="font-display text-xl leading-snug text-(--text-primary)"
                  i18n="@@app.about.different.curation.title"
                >
                  Curated by us, never controlled by vendors
                </h3>
                <p
                  class="mt-2 text-base leading-relaxed text-(--text-secondary)"
                  i18n="@@app.about.different.curation.body"
                >
                  Integration details are researched and published by AEC Integrations, and every
                  claim stays labeled “Unverified” until the vendors involved confirm it. Vendors
                  never pay to rank, never pay to remove a review, and never set their own position.
                  Rankings are algorithmic, always.
                </p>
              </li>
            </ul>
          </section>
        </div>
      </div>

      <!-- The three trust commitments: the shared band (AECI-273: the home's
           differentiation moved to home-differentiation, so this is its only
           mount; the positioning still reads identically across both). -->
      <aec-home-trust-pillars />

      <div class="mx-auto max-w-7xl px-6 py-12 md:px-8 md:py-16">
        <div class="flex max-w-[70ch] flex-col gap-12">
          <!-- Who it's for -->
          <section>
            <h2
              class="font-display text-2xl font-normal leading-snug text-(--text-primary) md:text-3xl"
              i18n="@@app.about.audience.heading"
            >
              Who it's for
            </h2>
            <p
              class="mt-4 text-base leading-relaxed text-(--text-secondary)"
              i18n="@@app.about.audience.p1"
            >
              AEC Integrations is built for the people making and living with these decisions: the
              technology directors and principals who have to defend a six- or seven-figure choice
              to a steering committee, and the architects, engineers, and project managers who will
              use the tool every day and whose experience feeds that choice.
            </p>
            <p
              class="mt-4 text-base leading-relaxed text-(--text-secondary)"
              i18n="@@app.about.audience.p2"
            >
              Software vendors get a fair hearing too, because the platform is editorially neutral.
              An accurate, well-represented profile is never something you have to pay for.
            </p>
          </section>

          <!-- Closing: route onward to the directory or to contact. -->
          <section>
            <h2
              class="font-display text-2xl font-normal leading-snug text-(--text-primary) md:text-3xl"
              i18n="@@app.about.next.heading"
            >
              Start exploring
            </h2>
            <p
              class="mt-4 text-base leading-relaxed text-(--text-secondary)"
              i18n="@@app.about.next.body"
            >
              Browse the directory to see which tools connect to what, or get in touch if you have a
              question or a correction.
            </p>
            <div class="mt-6 flex flex-wrap gap-x-6 gap-y-3">
              <a
                routerLink="/products"
                class="font-medium text-(--accent-primary) hover:text-(--accent-primary-hover)"
                i18n="@@app.about.next.browse"
              >
                Browse the directory
              </a>
              <a
                routerLink="/contact"
                class="font-medium text-(--accent-primary) hover:text-(--accent-primary-hover)"
                i18n="@@app.about.next.contact"
              >
                Contact us
              </a>
            </div>
          </section>
        </div>
      </div>
    </div>
  `,
})
export class AboutPage {
  private readonly meta = inject(MetaService);

  constructor() {
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.aboutTitle:About · AEC Integrations`,
      description: $localize`:@@meta.aboutDescription:AEC Integrations is the independent directory of AEC software integrations. Trust-first, vendor-verified, no pay-for-placement.`,
      canonical: canonicalUrl('/about'),
    });
  }
}
