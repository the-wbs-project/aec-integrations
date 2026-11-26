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
 * Section-role `<h2>` left, the lede right).
 *
 * **The page's one Forest feature card (Chris, ruling 2026-11-17).** The three
 * commitments are the three points of one Forest card, in their shipped order. The
 * card copies the recipe of the home page's "What we do instead" card in
 * `home-why.ts` (AECI-1792): `aec-card`, Forest fill, Bone ink, `shadow-card`,
 * `rounded-card`, 32px padding (48px from `lg`), and the points in columns split by
 * `aec-on-brand-rule` hairlines. The classes are reused, not extracted: the home
 * card also carries an icon tile, a card heading and a button, so a shared component
 * would have to be reshaped around both and the home page would move. The pillars
 * have no link today, so the card has no button and no focus stop. The closing line
 * stays on white under the card. The Clay top stripe and the hover lift are gone.
 *
 * Light theme only (Stage 1). Copy is authored with `$localize` so it stays
 * i18n-extractable in one place.
 */
import { ChangeDetectionStrategy, Component } from '@angular/core';

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

      <!-- The page's one Forest feature card (ruling 2026-11-17). The recipe of the
           home page's "What we do instead" card: Forest fill, Bone ink, the card
           shadow, 24px corners, the points in columns split by on-brand hairlines.
           It holds no link or button, so it needs no focus ring of its own. -->
      <div
        data-testid="about-trust-card"
        class="aec-card mt-12 rounded-card border bg-(--accent-primary) p-8 text-(--text-on-brand) shadow-card lg:p-12"
      >
        <ul class="grid gap-8 md:grid-cols-3">
          @for (p of pillars; track p.id) {
            <li
              class="aec-on-brand-rule max-md:not-first:border-t max-md:not-first:pt-8 md:not-first:border-s md:not-first:ps-8"
            >
              <h3 class="text-(--text-on-brand)">{{ p.title }}</h3>
              <p class="mt-2 text-t-16 leading-relaxed text-(--text-on-brand-secondary)">
                {{ p.body }}
              </p>
            </li>
          }
        </ul>
      </div>

      <p class="mt-8 max-w-[70ch] text-t-14 leading-relaxed text-(--text-secondary)">
        {{ closing }}
      </p>
    </section>
  `,
})
export class HomeTrustPillars {
  /** Framing line under the headline. */
  protected readonly lede = $localize`:@@home.trust.lede:Every decision we make, especially how we make money, must protect trust. If we break that trust, we have nothing.`;

  /**
   * The three commitments. Source: pitch deck Slide 10 ("Trust Is the Product"). The rankings
   * body is ruling 65's order sentence (AECI-2233, ruling 68), never a promise about position.
   */
  protected readonly pillars: readonly Pillar[] = [
    {
      id: 'rankings',
      title: $localize`:@@home.trust.rankings.title:Never sell rankings`,
      body: $localize`:@@home.trust.rankings.body:Rankings are algorithmic. Payment never changes the order in which products are listed or returned in search.`,
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
  protected readonly closing = $localize`:@@home.trust.closing:We will earn revenue from vendors who want to be found, never from changing the order of results.`;
}
