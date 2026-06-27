/**
 * `aec-home-why` — the home "Why AECi / the problem" band (§4.1 section 3, the
 * AECI-269 build child 3, ported from AECI-270's settled concept **b · warm
 * commerce**). It gives the cold visitor the villain and the stakes the directory
 * home omits: the broken software-review landscape (pay-to-play rankings, AI
 * reviews, vendor-funded visibility) plus three market figures.
 *
 * The copy is **translated**, not pasted, from the legacy landing
 * (`apps/landing/public/index.html`) into the editorial / anti-vendor voice
 * (`PRODUCT.md`): sentence case, no banned words, no em dashes, no "verified"
 * overclaim (nothing is dual-vendor-verified at Stage 1).
 *
 * **Static + edge-cache / SSR-safe.** No data fetch, no per-visitor state, no
 * client JS — the band renders into the cacheable, visitor-state-neutral home HTML
 * (`Cache-Tag: route:index,taxonomy`, `s-maxage=900`), identical for every
 * visitor. The three figures are **static cited stats, not live data** (the live
 * directory aggregates live in the credibility strip + stats cards).
 *
 * Treatment per `DESIGN.md` (concept b): the eyebrow carries a small decorative
 * **Clay** dot (`--accent-secondary`, fill only, `aria-hidden`, well under the
 * ≤5% cap); the narrative sits in a rounded **Bone** callout (`--accent-warm`,
 * border not shadow, never a page background); the three figures are bordered stat
 * cards on `--surface-raised` with **Forest** (`--accent-primary`) figures — not
 * the banned hero-metric template (no sparkline, no gradient). Light theme only
 * (Stage 1). Anchor site: Faire (AECI-270).
 *
 * Sourcing (AECI-285, done): each figure now carries a small "Source" link to its
 * citation. The citation is revealed on hover and on keyboard focus, and announced
 * to screen readers via `aria-describedby` — a CSS-only reveal, so the band stays
 * static, zero-JS, and edge-cache-neutral. Figure 1 was revised ≈34% to ≈19%
 * (AI-generated Google reviews, Originality.AI) and figure 2 $87K to $27K (median
 * annual G2 vendor spend, Vendr); figure 3 (900+) was verified against Capterra
 * (~986 products in a single category) and kept. The blanket "industry estimates"
 * note is retired in favour of the per-figure sources. Full research + citations:
 * `docs/design/home-why-market-figures.md`. Copy is authored with `$localize` so it
 * stays i18n-extractable in one place. The hero owns the page `<h1>`; this band's
 * headline is the section `<h2>`, keeping a valid heading order.
 */
import { ChangeDetectionStrategy, Component } from '@angular/core';

/** A primary source behind a figure: the verifiable link and its citation. */
interface ProblemSource {
  /** Citation shown on hover/focus and announced to screen readers. */
  readonly citation: string;
  /** The source URL the "Source" link points to. */
  readonly url: string;
}

/** One market figure: the headline number, the claim it supports, and its source. */
interface ProblemStat {
  readonly id: string;
  readonly figure: string;
  readonly desc: string;
  readonly source: ProblemSource;
}

@Component({
  selector: 'aec-home-why',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <section class="bg-(--surface-base)">
      <div class="mx-auto max-w-7xl px-6 py-16 md:px-8 md:py-20">
        <p class="aec-overline inline-flex items-center gap-2 text-(--text-secondary)">
          <span
            class="inline-block h-2 w-2 rounded-full bg-(--accent-secondary)"
            aria-hidden="true"
          ></span>
          <span i18n="@@home.why.eyebrow">The problem</span>
        </p>

        <div
          class="mt-4 rounded-(--radius-lg) border border-(--border-default) bg-(--accent-warm) p-8 md:p-10"
        >
          <h2
            class="max-w-3xl font-display text-3xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-4xl"
            i18n="@@home.why.headline"
          >
            The software review landscape is broken
          </h2>
          <div class="mt-5 max-w-2xl space-y-4 text-base leading-relaxed text-(--text-secondary)">
            <p i18n="@@home.why.para1">
              AEC firms making six and seven figure software decisions rely on platforms riddled
              with pay-to-play rankings, AI-generated reviews, and vendor-funded visibility. The
              tools at the top aren't the best ones. They're the ones that paid the most.
            </p>
            <p i18n="@@home.why.para2">
              Meanwhile the information that actually decides a purchase, whether an integration
              really works, what implementation takes, and what a tool costs after the sales pitch,
              is almost impossible to find.
            </p>
          </div>
        </div>

        <ul class="mt-6 grid gap-4 sm:grid-cols-3">
          @for (s of stats; track s.id) {
            <li
              class="relative rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-6"
            >
              <p class="font-display text-4xl tabular-nums text-(--accent-primary)">
                {{ s.figure }}
              </p>
              <p class="mt-3 text-sm leading-relaxed text-(--text-secondary)">{{ s.desc }}</p>

              <!--
                Per-figure sourcing (AECI-285): a real "Source" link (verifiable,
                works without JS) whose citation is revealed on hover and on keyboard
                focus, and announced to screen readers via aria-describedby. The
                reveal is pure CSS, so the band stays static and edge-cache-neutral.
              -->
              <span class="group relative mt-4 inline-flex">
                <a
                  [href]="s.source.url"
                  target="_blank"
                  rel="noopener nofollow"
                  [attr.aria-describedby]="s.id + '-source'"
                  class="rounded-(--radius-sm) text-xs text-(--text-secondary) underline decoration-(--border-strong) underline-offset-2 transition-colors hover:text-(--text-primary) hover:decoration-(--text-secondary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                >
                  <span i18n="@@home.why.sourceLabel">Source</span>
                  <span class="sr-only" i18n="@@home.why.sourceNewTab">(opens in a new tab)</span>
                </a>
                <span
                  [id]="s.id + '-source'"
                  role="tooltip"
                  class="pointer-events-none absolute bottom-full left-0 z-10 mb-2 w-64 rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) p-3 text-xs leading-relaxed text-(--text-secondary) opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  {{ s.source.citation }}
                </span>
              </span>
            </li>
          }
        </ul>
      </div>
    </section>
  `,
})
export class HomeWhy {
  /**
   * The three market figures. Static cited stats (not live data); each carries a
   * primary source surfaced through the "Source" link (AECI-285). Figures 1 and 2
   * were revised to their citable values; figure 3 was verified and kept. Full
   * research: `docs/design/home-why-market-figures.md`.
   */
  protected readonly stats: readonly ProblemStat[] = [
    {
      id: 'ai-reviews',
      figure: $localize`:@@home.why.stat.aiReviews.figure:≈19%`,
      desc: $localize`:@@home.why.stat.aiReviews.desc:of Google reviews were AI-generated by late 2024, up from about 5% in 2019`,
      source: {
        citation: $localize`:@@home.why.stat.aiReviews.source:Originality.AI, 2025. AI-generated reviews on Google rose from about 5% in 2019 to 19% by the end of 2024. Measured on Google reviews; no equivalent study exists for B2B software review sites.`,
        url: 'https://originality.ai/blog/ai-google-reviews-study',
      },
    },
    {
      id: 'pay-to-rank',
      figure: $localize`:@@home.why.stat.payToRank.figure:$27K`,
      desc: $localize`:@@home.why.stat.payToRank.desc:a year is what a typical vendor pays for paid visibility on a leading review site`,
      source: {
        citation: $localize`:@@home.why.stat.payToRank.source:Vendr, 2026. The median annual amount vendors pay for G2, across 512 purchases. Paid plans and add-ons scale to $95K or more.`,
        url: 'https://www.vendr.com/marketplace/g2',
      },
    },
    {
      id: 'generic-tools',
      figure: $localize`:@@home.why.stat.genericTools.figure:900+`,
      desc: $localize`:@@home.why.stat.genericTools.desc:tools lumped into generic categories with no way to filter by AEC discipline`,
      source: {
        citation: $localize`:@@home.why.stat.genericTools.source:Capterra, 2026. Its single construction management category alone lists about 986 products, with no facet for AEC discipline.`,
        url: 'https://www.capterra.com/construction-management-software/',
      },
    },
  ];
}
