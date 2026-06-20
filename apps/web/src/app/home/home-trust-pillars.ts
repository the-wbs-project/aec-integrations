/**
 * `aec-home-trust-pillars` — the home page trust band (the marquee value
 * statement under the hero). AECi's positioning is trust-first, so the marketing
 * band states the three commitments that protect it, drawn from the pitch deck
 * ("Trust Is the Product", Slide 10): never sell rankings, always be transparent,
 * never review products ourselves.
 *
 * **Static + edge-cache / SSR-safe.** No data fetch, no per-visitor state, and no
 * client JS — all three pillars render into the cacheable, visitor-state-neutral
 * home HTML (`Cache-Tag: route:index,taxonomy`, `s-maxage=900`), identical for
 * every visitor. The hover lift is pure CSS (neutralised under
 * `prefers-reduced-motion` by the global rule in styles.css), so there is no
 * auto-motion and therefore no pause control to reason about. Cards are a real
 * `<ul>`/`<li>` list with a visible `<h3>` each, keeping a valid heading order
 * under the section `<h2>`.
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
    <section class="border-y border-(--accent-primary-hover) bg-(--accent-primary)">
      <div class="mx-auto max-w-7xl px-6 py-16 md:px-8 md:py-20">
        <div class="max-w-2xl">
          <p class="aec-overline text-(--accent-secondary)" i18n="@@home.trust.eyebrow">
            Our commitment
          </p>
          <h2
            class="mt-3 font-display text-3xl font-normal leading-[1.1] tracking-[-0.01em] text-white md:text-4xl"
            i18n="@@home.trust.headline"
          >
            Trust is the product
          </h2>
          <p class="mt-4 text-lg leading-relaxed text-white/80">{{ lede }}</p>
        </div>

        <ul class="mt-12 grid gap-4 md:grid-cols-3">
          @for (p of pillars; track p.id) {
            <li
              class="relative flex flex-col rounded-(--radius-lg) bg-(--surface-base) p-6 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-lg"
            >
              <span class="absolute inset-x-0 top-0 h-1 bg-(--accent-secondary)"></span>
              <h3 class="font-display text-xl leading-snug text-(--text-primary)">{{ p.title }}</h3>
              <p class="mt-3 text-sm leading-relaxed text-(--text-secondary)">{{ p.body }}</p>
            </li>
          }
        </ul>

        <p class="mt-8 max-w-3xl text-sm leading-relaxed text-white/70">{{ closing }}</p>
      </div>
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
      body: $localize`:@@home.trust.rankings.body:Search results and listings are ordered by relevance and reviews. Payment never influences position. Ever.`,
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
  protected readonly closing = $localize`:@@home.trust.closing:We earn revenue from vendors who want to be found, never from changing what you see.`;
}
