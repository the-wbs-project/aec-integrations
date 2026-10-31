/**
 * `aec-home-why`: the home's one argument band (AECI-1558). It merged three
 * stacked bands (the problem, what's different, how it works) into one evidence
 * band, top to bottom:
 *
 *   1. Eyebrow and the section `<h2>` (Source Serif display face).
 *   2. Two short paragraphs in a reading-width column: rankings shaped by money,
 *      and the purchase-deciding facts that are hard to find.
 *   3. The three cited market figures as a spec-sheet row: three columns split
 *      by hairlines, a Forest figure over its label, and a per-figure "Source"
 *      link with the accessible citation reveal (AECI-285). Each link carries an
 *      sr-only suffix naming its figure, so the three links no longer share one
 *      accessible name (AECI-830).
 *   4. "What we do instead": three plain bordered white cards. The second card
 *      is the only place in the band that says no pay-for-placement (the hero
 *      lede is the other one on the page).
 *
 * No reviews claim (AECI-1557). AECi holds no reviews yet, so the band never says
 * it rates, reviews, or verifies anything. The figure row keeps its cited market
 * stats, which describe other platforms, not ours. The third idea describes the
 * AEC-native taxonomy (`PRODUCT.md`, "AEC-native"), which the browse block above
 * already shows working, rather than a vendor-portal claim the portal does not
 * yet deliver in production.
 *
 * Figures, sources and their i18n ids are unchanged from AECI-285. Research and
 * citations: `docs/design/home-why-market-figures.md`.
 *
 * Static and edge-cache neutral: no data fetch, no per-visitor state, no client
 * JS. The citation reveal is CSS only. `home.ts` owns the white ground, width
 * and padding. Light theme only. The hero owns the page `<h1>`; this band owns
 * one `<h2>`, one `<h3>` for the ideas row, and an `<h4>` per idea.
 */
import { ChangeDetectionStrategy, Component } from '@angular/core';

import { NewTabIcon } from '../shared/new-tab-icon/new-tab-icon';

/** A primary source behind a figure: the verifiable link and its citation. */
interface ProblemSource {
  /** Citation shown on hover/focus and announced to screen readers. */
  readonly citation: string;
  /** The source URL the "Source" link points to. */
  readonly url: string;
  /** Screen-reader suffix that makes this link's accessible name unique (AECI-830). */
  readonly linkSuffix: string;
}

/** One market figure: the headline number, the claim it supports, and its source. */
interface ProblemStat {
  readonly id: string;
  readonly figure: string;
  readonly desc: string;
  readonly source: ProblemSource;
}

/** One "what we do instead" idea. */
interface Idea {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

@Component({
  selector: 'aec-home-why',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NewTabIcon],
  host: { class: 'block' },
  template: `
    <section aria-labelledby="home-why-heading">
      <p class="aec-overline text-(--text-secondary)" i18n="@@home.why.kicker">Why this exists</p>
      <h2
        id="home-why-heading"
        class="mt-3 max-w-3xl font-display text-3xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-4xl"
        i18n="@@home.why.headlineFind"
      >
        The way AEC firms find software is broken
      </h2>
      <div
        data-testid="home-why-prose"
        class="mt-5 max-w-3xl space-y-4 text-base leading-relaxed text-(--text-secondary)"
      >
        <p i18n="@@home.why.lede1">
          AEC firms make six and seven figure software decisions on platforms shaped by pay-to-play
          rankings and vendor-funded visibility. The tools at the top are often the ones that paid
          the most, not the ones that fit the work.
        </p>
        <p i18n="@@home.why.lede2">
          Meanwhile the information that actually decides a purchase is hard to find: whether an
          integration really works, and what implementation takes once the sales pitch ends.
        </p>
      </div>

      <!-- Spec-sheet row: three cited figures split by hairlines. -->
      <ul
        data-testid="home-why-figures"
        class="mt-10 grid divide-y divide-(--border-default) border-y border-(--border-default) sm:grid-cols-3 sm:divide-x sm:divide-y-0"
      >
        @for (s of stats; track s.id) {
          <li class="py-5 sm:px-6 sm:first:ps-0 sm:last:pe-0">
            <p class="font-display text-3xl tabular-nums text-(--accent-primary)">
              {{ s.figure }}
            </p>
            <p class="mt-2 text-sm leading-relaxed text-(--text-secondary)">{{ s.desc }}</p>

            <!-- Citation reveal (AECI-285): a real link, its citation shown on hover
                 and focus and announced through aria-describedby. CSS only. -->
            <span class="group relative mt-3 inline-flex">
              <a
                [href]="s.source.url"
                target="_blank"
                rel="noopener noreferrer nofollow"
                [attr.aria-describedby]="s.id + '-source'"
                class="inline-flex items-center gap-1.5 rounded-(--radius-sm) text-xs font-medium text-(--text-secondary) underline decoration-(--border-strong) underline-offset-4 transition-colors hover:text-(--text-primary) hover:decoration-(--text-secondary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              >
                <span i18n="@@home.why.sourceLabel">Source</span>
                <span class="sr-only">{{ s.source.linkSuffix }}</span>
                <aec-new-tab-icon />
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

      <h3
        class="mt-12 font-display text-xl leading-snug text-(--text-primary)"
        i18n="@@home.why.instead.heading"
      >
        What we do instead
      </h3>
      <ul data-testid="home-why-ideas" class="mt-5 grid gap-4 md:grid-cols-3">
        @for (idea of ideas; track idea.id) {
          <li
            class="rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base) p-6"
          >
            <h4 class="font-display text-lg leading-snug text-(--text-primary)">
              {{ idea.title }}
            </h4>
            <p class="mt-2 text-sm leading-relaxed text-(--text-secondary)">{{ idea.body }}</p>
          </li>
        }
      </ul>
    </section>
  `,
})
export class HomeWhy {
  /**
   * The three market figures. Static cited stats, not live data. Figures,
   * descriptions and citations are unchanged from AECI-285; only the layout and
   * the per-link accessible-name suffix are new.
   */
  protected readonly stats: readonly ProblemStat[] = [
    {
      id: 'ai-reviews',
      figure: $localize`:@@home.why.stat.aiReviews.figure:≈19%`,
      desc: $localize`:@@home.why.stat.aiReviews.desc:of Google reviews were AI-generated by late 2024, up from about 5% in 2019`,
      source: {
        citation: $localize`:@@home.why.stat.aiReviews.source:Originality.AI, 2025. AI-generated reviews on Google rose from about 5% in 2019 to 19% by the end of 2024. Measured on Google reviews; no equivalent study exists for B2B software review sites.`,
        url: 'https://originality.ai/blog/ai-google-reviews-study',
        linkSuffix: $localize`:@@home.why.stat.aiReviews.linkSuffix:for the 19% AI-generated figure, Originality.AI`,
      },
    },
    {
      id: 'pay-to-rank',
      figure: $localize`:@@home.why.stat.payToRank.figure:$27K`,
      desc: $localize`:@@home.why.stat.payToRank.desc:a year is what a typical vendor pays for paid visibility on a leading review site`,
      source: {
        citation: $localize`:@@home.why.stat.payToRank.source:Vendr, 2026. The median annual amount vendors pay for G2, across 512 purchases. Paid plans and add-ons scale to $95K or more.`,
        url: 'https://www.vendr.com/marketplace/g2',
        linkSuffix: $localize`:@@home.why.stat.payToRank.linkSuffix:for the $27K paid visibility figure, Vendr`,
      },
    },
    {
      id: 'generic-tools',
      figure: $localize`:@@home.why.stat.genericTools.figure:900+`,
      desc: $localize`:@@home.why.stat.genericTools.desc:tools lumped into generic categories with no way to filter by AEC discipline`,
      source: {
        citation: $localize`:@@home.why.stat.genericTools.source:Capterra, 2026. Its single construction management category alone lists about 986 products, with no facet for AEC discipline.`,
        url: 'https://www.capterra.com/construction-management-software/',
        linkSuffix: $localize`:@@home.why.stat.genericTools.linkSuffix:for the 900+ generic category figure, Capterra`,
      },
    },
  ];

  /** What AECi does instead. The second idea is the band's one no-pay-for-placement line. */
  protected readonly ideas: readonly Idea[] = [
    {
      id: 'documented',
      title: $localize`:@@home.why.idea.documented.title:Every connection is documented`,
      body: $localize`:@@home.why.idea.documented.body:Each integration records what it links, the mechanism behind it, and which way the data moves. A logo count tells you none of that.`,
    },
    {
      id: 'earned',
      title: $localize`:@@home.why.idea.earned.title:Position is earned, never bought`,
      body: $localize`:@@home.why.idea.earned.body:Rankings are algorithmic. Listings are never boosted by spend, and there is no pay-for-placement.`,
    },
    {
      id: 'aec-native',
      title: $localize`:@@home.why.idea.aecNative.title:Organized the way AEC works`,
      body: $localize`:@@home.why.idea.aecNative.body:Browse by AEC category, project phase and role, not a generic software taxonomy with construction added as an afterthought.`,
    },
  ];
}
