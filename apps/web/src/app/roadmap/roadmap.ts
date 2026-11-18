/**
 * Roadmap page (`/roadmap`) — a coming-soon placeholder reached from the header's
 * "More" overflow menu.
 *
 * Deliberately a placeholder, not an empty route: the nav entry ships now and
 * the page tells a visitor what the surface will be and offers the mailing list
 * as the interim subscription. When the real roadmap content lands, this file
 * gains the content and the head flips to indexable.
 *
 * **Noindex, and absent from `sitemap.xml`** — a placeholder is thin content and
 * shouldn't compete in the index (contrast `/about` and `/legal/*`, which are
 * real content and stay indexable). Flipping it later is `noindex: true` off
 * here plus a `sitemap.ts` entry.
 *
 * **Static + edge-cache / SSR-safe.** No data fetch and no per-visitor state, so
 * the whole page renders into cacheable, visitor-state-neutral HTML (`/roadmap`
 * carries `Cache-Tag: route:index` on the same 24h edge / 1h browser TTL as
 * `/about` and `/updates` via `ROUTE_CACHE_PATTERNS` + `cacheTagInputsForPath`).
 * The one interactive island is the shared `<aec-mailing-list-signup>` band,
 * which only POSTs from a user action against the non-cached `/api/*`.
 *
 * Voice per `PRODUCT.md`: editorial, sentence case, no hyperbole, no dates we
 * can't keep.
 *
 * **Layout (AECI-1801, the `/about` recipe of AECI-1800).** Three bands on the
 * 1328px page wrap (`BAND_WRAP_CLASS`): the hero on `aec-bone-band`, the page's
 * one Bone band, with the h1 at the Headline role (the global h1 size); a white
 * band whose one section is its heading over its prose at the 70ch measure (the
 * 5:7 split left a short heading about 200px from its text, so the AECI-1720
 * layout pass stacked them); and the signup on its white ground (`ground="white"`), so the
 * page no longer carries a second Bone band. The words and their order are
 * unchanged.
 */
import { Component, inject } from '@angular/core';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { BAND_WRAP_CLASS } from '../shared/band-wrap';
import { BoneBand } from '../shared/bone-band/bone-band';
import { MailingListSignup } from '../shared/mailing-list-signup/mailing-list-signup';

@Component({
  selector: 'app-roadmap',
  imports: [BoneBand, MailingListSignup],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <!-- 1. Hero: the page's one Bone band, as on /about. -->
      <aec-bone-band>
        <div class="max-w-[70ch]">
          <p class="aec-overline text-(--text-secondary)" i18n="@@app.roadmap.eyebrow">Roadmap</p>
          <h1 class="mt-4 text-(--text-primary)" i18n="@@app.roadmap.headline">
            What we're building next
          </h1>
          <p
            class="mt-6 max-w-[36em] text-t-20 leading-normal text-(--text-secondary)"
            i18n="@@app.roadmap.lede"
          >
            A public roadmap is coming soon. It will show what's in progress, what's queued, and
            what we've decided not to build, so you can see where the directory is heading before it
            gets there.
          </p>
        </div>
      </aec-bone-band>

      <!-- 2. White: one short section. The heading sits over its two lines, so they
           read as one block (AECI-1720 layout pass): a 5:7 split put the short
           heading about 200px from its text. -->
      <div class="py-16 md:py-24">
        <div [class]="wrap">
          <section [class]="block">
            <h2 class="text-(--text-primary)">
              <span [class]="sectionTitle" i18n="@@app.roadmap.meantime.heading"
                >In the meantime</span
              >
            </h2>
            <p
              class="max-w-[70ch] text-t-16 leading-relaxed text-(--text-secondary)"
              i18n="@@app.roadmap.meantime.body"
            >
              The directory grows every week as we add new products, integrations, and reviews. Add
              your email below and we'll tell you what shipped instead of asking you to check back.
            </p>
          </section>
        </div>
      </div>

      <!-- 3. White, after a hairline: the signup. White ground keeps the page to one
           Bone band (the hero), as on the product and vendor pages. -->
      <aec-mailing-list-signup source="roadmap_page" ground="white" />
    </div>
  `,
})
export class RoadmapPage {
  private readonly meta = inject(MetaService);

  /** The 1328px page wrap the header, footer and bands share. */
  protected readonly wrap = BAND_WRAP_CLASS;

  /**
   * The one section: the heading over its prose, both at the 70ch measure. Two
   * lines of prose are too short for `/about`'s heading-left split.
   */
  protected readonly block = 'grid max-w-[70ch] gap-6';

  /** The Section role on an inner span, so the unlayered h2 rule cannot beat it. */
  protected readonly sectionTitle = 'block text-t-36 leading-[1.1] tracking-[-0.02em]';

  constructor() {
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.roadmapTitle:Roadmap · AEC Integrations`,
      description: $localize`:@@meta.roadmapDescription:A public roadmap for AEC Integrations is coming soon. Join the mailing list for updates as the directory grows.`,
      canonical: canonicalUrl('/roadmap'),
      noindex: true,
    });
  }
}
