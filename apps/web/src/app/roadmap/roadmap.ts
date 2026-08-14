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
 * can't keep. Layout per `DESIGN.md`: a warm Bone (`accent-warm`) hero band,
 * body measure capped at 70ch, Source Serif display for headings.
 */
import { Component, inject } from '@angular/core';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { MailingListSignup } from '../shared/mailing-list-signup/mailing-list-signup';

@Component({
  selector: 'app-roadmap',
  imports: [MailingListSignup],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <section class="border-b border-(--border-default) bg-(--accent-warm)">
        <div class="mx-auto max-w-7xl px-6 py-16 md:px-8 md:py-20">
          <div class="max-w-[70ch]">
            <p class="aec-overline text-(--accent-primary)" i18n="@@app.roadmap.eyebrow">Roadmap</p>
            <h1
              class="mt-3 font-display text-4xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-5xl"
              i18n="@@app.roadmap.headline"
            >
              What we're building next
            </h1>
            <p
              class="mt-5 text-lg leading-relaxed text-(--text-secondary)"
              i18n="@@app.roadmap.lede"
            >
              A public roadmap is coming soon. It will show what's in progress, what's queued, and
              what we've decided not to build, so you can see where the directory is heading before
              it gets there.
            </p>
          </div>
        </div>
      </section>

      <div class="mx-auto max-w-7xl px-6 py-12 md:px-8 md:py-16">
        <div class="max-w-[70ch]">
          <h2
            class="font-display text-2xl font-normal leading-snug text-(--text-primary) md:text-3xl"
            i18n="@@app.roadmap.meantime.heading"
          >
            In the meantime
          </h2>
          <p
            class="mt-4 text-base leading-relaxed text-(--text-secondary)"
            i18n="@@app.roadmap.meantime.body"
          >
            The directory grows every week as new products, integrations, and reviews are verified.
            Add your email below and we'll tell you what shipped instead of asking you to check
            back.
          </p>
        </div>
      </div>

      <aec-mailing-list-signup source="roadmap_page" />
    </div>
  `,
})
export class RoadmapPage {
  private readonly meta = inject(MetaService);

  constructor() {
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.roadmapTitle:Roadmap · AEC Integrations`,
      description: $localize`:@@meta.roadmapDescription:A public roadmap for AEC Integrations is coming soon. Join the mailing list for updates as the directory grows.`,
      canonical: canonicalUrl('/roadmap'),
      noindex: true,
    });
  }
}
