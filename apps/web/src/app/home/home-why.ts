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
 * Sourcing: the figures keep their hedged framing ("≈", "estimated to be") plus a
 * single understated "industry estimates" note. Properly researching / citing them
 * is tracked as a follow-up issue (AECI-285). Copy is authored with `$localize`
 * so it stays i18n-extractable in one place. The hero owns the page `<h1>`; this
 * band's headline is the section `<h2>`, keeping a valid heading order.
 */
import { ChangeDetectionStrategy, Component } from '@angular/core';

/** One market figure: the headline number and the claim it supports. */
interface ProblemStat {
  readonly id: string;
  readonly figure: string;
  readonly desc: string;
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
              class="rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-6"
            >
              <p class="font-display text-4xl tabular-nums text-(--accent-primary)">
                {{ s.figure }}
              </p>
              <p class="mt-3 text-sm leading-relaxed text-(--text-secondary)">{{ s.desc }}</p>
            </li>
          }
        </ul>

        <p class="mt-4 text-xs text-(--text-secondary)" i18n="@@home.why.estimatesNote">
          Figures are industry estimates.
        </p>
      </div>
    </section>
  `,
})
export class HomeWhy {
  /**
   * The three market figures. Static cited stats (not live data), kept in their
   * hedged framing; real sourcing is a tracked follow-up. Source copy translated
   * from the legacy landing's "the problem" section.
   */
  protected readonly stats: readonly ProblemStat[] = [
    {
      id: 'ai-reviews',
      figure: $localize`:@@home.why.stat.aiReviews.figure:≈34%`,
      desc: $localize`:@@home.why.stat.aiReviews.desc:of reviews on major platforms are estimated to be AI-generated`,
    },
    {
      id: 'pay-to-rank',
      figure: $localize`:@@home.why.stat.payToRank.figure:$87K`,
      desc: $localize`:@@home.why.stat.payToRank.desc:a year is what vendors pay to boost their ranking on leading review sites`,
    },
    {
      id: 'generic-tools',
      figure: $localize`:@@home.why.stat.genericTools.figure:900+`,
      desc: $localize`:@@home.why.stat.genericTools.desc:tools lumped into generic categories with no way to filter by AEC discipline`,
    },
  ];
}
