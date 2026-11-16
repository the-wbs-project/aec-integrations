/**
 * `aec-home-trust-pillars` — the shared "three trust commitments" band. AECi's
 * positioning is trust-first, so the band states the three commitments that
 * protect it, drawn from the pitch deck ("Trust Is the Product", Slide 10):
 * never sell rankings, always be transparent, never review products ourselves.
 *
 * Since AECI-273 the home no longer mounts this band, and since AECI-1558 the
 * home's argument lives in one band, `home-why.ts`. This band is now shown on
 * the **About page** (`/about`), where
 * the standalone trust commitments belong on the dedicated trust-first page. The
 * component, selector, and `@@home.trust.*` ids are kept unchanged so `/about`
 * (and its tests) are untouched.
 *
 * **Static + edge-cache / SSR-safe.** No data fetch, no per-visitor state, and no
 * client JS — all three pillars render into cacheable, visitor-state-neutral HTML,
 * identical for every visitor. Cards are a real `<ul>`/`<li>` list with a visible
 * `<h3>` each, keeping a valid heading order under the section `<h2>`.
 *
 * **Design (AECI-1800).** A bare `<section>`: `/about` owns the white band and the
 * page wrap around it. Forest may fill only the header, a detail page hero, the
 * footer and one feature card (DESIGN.md §2), so the band left its mid-page Forest
 * ground. The head row is the home argument band's 5:7 split (overline and the
 * Section-role `<h2>` left, the lede right). The three commitments are shared
 * `aecCard`s in the shared `aec-card-grid`. They are not links, so they do not
 * lift, and the Clay top stripe is gone (Clay is a stroke, and a stripe needs a
 * text label it would mark).
 *
 * Light theme only (Stage 1). Copy is authored with `$localize` so it stays
 * i18n-extractable in one place.
 */
import { ChangeDetectionStrategy, Component } from '@angular/core';

import { AecCard } from '../shared/card/card';

/** One trust commitment: the mantra and the one-line explanation. */
interface Pillar {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

@Component({
  selector: 'aec-home-trust-pillars',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  imports: [AecCard],
  template: `
    <section>
      <div class="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
        <div>
          <p class="aec-overline text-(--text-secondary)" i18n="@@home.trust.eyebrow">
            Our commitment
          </p>
          <h2 class="mt-3 text-(--text-primary)">
            <span
              class="block text-t-36 leading-[1.1] tracking-[-0.02em]"
              i18n="@@home.trust.headline"
              >Trust is the product</span
            >
          </h2>
        </div>
        <p class="max-w-[36em] text-t-20 leading-normal text-(--text-secondary)">
          {{ lede }}
        </p>
      </div>

      <ul class="aec-card-grid mt-12">
        @for (p of pillars; track p.id) {
          <li aecCard class="flex flex-col p-6 md:p-8">
            <h3 class="text-(--text-primary)">{{ p.title }}</h3>
            <p class="mt-3 text-t-16 leading-relaxed text-(--text-secondary)">{{ p.body }}</p>
          </li>
        }
      </ul>

      <p class="mt-8 max-w-[70ch] text-t-14 leading-relaxed text-(--text-secondary)">
        {{ closing }}
      </p>
    </section>
  `,
})
export class HomeTrustPillars {
  /** Framing line under the headline. */
  protected readonly lede = $localize`:@@home.trust.lede:Every decision we make, especially how we make money, must protect trust. If we break that trust, we have nothing.`;

  /** The three commitments. Source: pitch deck Slide 10 ("Trust Is the Product"). */
  protected readonly pillars: readonly Pillar[] = [
    {
      id: 'rankings',
      title: $localize`:@@home.trust.rankings.title:Never sell rankings`,
      body: $localize`:@@home.trust.rankings.body:Search results and listings are earned, not bought. Payment never influences position. Ever.`,
    },
    {
      id: 'transparent',
      title: $localize`:@@home.trust.transparent.title:Always be transparent`,
      body: $localize`:@@home.trust.transparent.body:When we earn money from something, you will know. No hidden incentives, no blurred line between editorial and revenue.`,
    },
    {
      id: 'independent',
      title: $localize`:@@home.trust.independent.title:Never review products ourselves`,
      body: $localize`:@@home.trust.independent.body:We cover trends, categories, and market shifts, but never promote a specific brand. The user reviews speak, we don't.`,
    },
  ];

  /** Closing reinforcement (no competitor call-outs on the public site). */
  protected readonly closing = $localize`:@@home.trust.closing:We will earn revenue from vendors who want to be found, never from changing what you see.`;
}
