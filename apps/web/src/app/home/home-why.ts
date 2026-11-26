/**
 * `aec-home-why`: the home's one argument band (AECI-1558, rebuilt on mock-up 9 in
 * AECI-1792). Top to bottom:
 *
 *   1. Heading left, prose right from `lg`: the overline and the section `<h2>`
 *      (size on an inner span), then two short paragraphs: rankings shaped by
 *      money, and the purchase-deciding facts that are hard to find.
 *   2. The three cited market figures in a hairline row: Source Serif 600 at
 *      `--t-24` in Forest, so they read as sub-headings, not hero metrics (ruling
 *      4, which keeps clash 8's "one large figure per band"). Each citation is
 *      printed under its figure, followed by a "Source" link (AECI-285). Each link
 *      carries an sr-only suffix naming its figure, so the three links do not
 *      share one accessible name (AECI-830).
 *   3. "What we do instead": the page's one Forest feature card (mock-up 9 question 1, clash
 *      1). Bone ink, the three points in columns split by on-brand hairlines, and
 *      the Bone "How we rank" button to the ranking page. The second point is the
 *      only place in the band that says no pay-for-placement (the hero lede is the
 *      other one on the page).
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
 * JS. `home.ts` owns the white ground, width and padding. Light theme only. The
 * hero owns the page `<h1>`; this band owns one `<h2>`, one `<h3>` for the ideas
 * card, and an `<h4>` per idea.
 */
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AecButton } from '../shared/button/button';
import { AecIcon } from '../shared/icon/icon';
import type { AecIconName } from '../shared/icon/icon-registry';
import { NewTabIcon } from '../shared/new-tab-icon/new-tab-icon';

/** A primary source behind a figure: the verifiable link and its citation. */
interface ProblemSource {
  /** Citation printed under the figure, ahead of its "Source" link. */
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
  /** The glyph in the idea's tile. Decorative. */
  readonly icon: AecIconName;
  readonly title: string;
  readonly body: string;
}

@Component({
  selector: 'aec-home-why',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AecButton, AecIcon, NewTabIcon, RouterLink],
  host: { class: 'block' },
  template: `
    <section aria-labelledby="home-why-heading">
      <div class="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
        <div>
          <p class="aec-overline text-(--text-secondary)" i18n="@@home.why.kicker">
            Why this exists
          </p>
          <h2 id="home-why-heading" class="mt-3 text-(--text-primary)">
            <span
              class="block text-t-36 leading-[1.1] tracking-[-0.02em]"
              i18n="@@home.why.headlineFind"
              >The way AEC firms find software is broken</span
            >
          </h2>
        </div>
        <div
          data-testid="home-why-prose"
          class="grid max-w-2xl gap-4 text-t-16 leading-relaxed text-(--text-secondary)"
        >
          <p i18n="@@home.why.lede1">
            AEC firms make six and seven figure software decisions on platforms shaped by
            pay-to-play rankings and vendor-funded visibility. The tools at the top are often the
            ones that paid the most, not the ones that fit the work.
          </p>
          <p i18n="@@home.why.lede2">
            Meanwhile the information that actually decides a purchase is hard to find: whether an
            integration really works, and what implementation takes once the sales pitch ends.
          </p>
        </div>
      </div>

      <!-- Three cited figures in a hairline row (mock-up 9 question 4): --t-24, Forest, read as
           sub-headings rather than hero metrics. The citation is printed under each
           figure, so a reader sees the source without hovering. -->
      <ul
        data-testid="home-why-figures"
        class="mt-12 grid divide-y border-y md:grid-cols-3 md:divide-x md:divide-y-0"
      >
        @for (s of stats; track s.id) {
          <li class="py-6 md:px-6 md:first:ps-0 md:last:pe-0">
            <p
              data-testid="home-why-figure"
              class="font-display text-t-24 leading-tight font-semibold tabular-nums text-(--accent-primary)"
            >
              {{ s.figure }}
            </p>
            <p class="mt-2 text-t-16 text-(--text-primary)">{{ s.desc }}</p>
            <p
              [id]="s.id + '-source'"
              data-testid="home-why-citation"
              class="mt-3 text-t-13 leading-relaxed text-(--text-secondary)"
            >
              {{ s.source.citation }}
              <a
                [href]="s.source.url"
                target="_blank"
                rel="noopener nofollow"
                class="inline-flex items-center gap-1 rounded-sm font-semibold text-(--text-secondary) underline decoration-(--border-field) underline-offset-4 transition-colors hover:text-(--accent-primary) hover:decoration-current focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
              >
                <span i18n="@@home.why.sourceLabel">Source</span>
                <span class="sr-only">{{ s.source.linkSuffix }}</span>
                <aec-new-tab-icon />
              </a>
            </p>
          </li>
        }
      </ul>

      <!-- "What we do instead": the page's one Forest feature card (mock-up 9 question 1, clash
           1). A card, never a band: 24px radius, the card shadow, Bone ink and the
           Bone main button. DOM order is the reading order (heading, points,
           button). From md the button sits at the top right. -->
      <div
        data-testid="home-why-instead"
        class="aec-card mt-16 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 rounded-card border bg-(--accent-primary) p-8 text-(--text-on-brand) shadow-card lg:p-12"
      >
        <h3 class="col-start-1 row-start-1 text-(--text-on-brand)">
          <span class="block text-t-24 leading-tight" i18n="@@home.why.instead.heading"
            >What we do instead</span
          >
        </h3>
        <ul data-testid="home-why-ideas" class="col-span-full mt-8 grid gap-8 md:grid-cols-3">
          @for (idea of ideas; track idea.id) {
            <li
              class="aec-on-brand-rule max-md:not-first:border-t max-md:not-first:pt-8 md:not-first:border-s md:not-first:ps-8"
            >
              <span
                class="grid size-11 place-items-center rounded-control bg-(--surface-on-brand-wash) text-(--text-on-brand)"
              >
                <aec-icon [name]="idea.icon" decorative [size]="5" />
              </span>
              <h4 class="mt-4 font-display text-t-20 leading-tight font-semibold">
                {{ idea.title }}
              </h4>
              <p class="mt-2 text-t-16 text-(--text-on-brand-secondary)">{{ idea.body }}</p>
            </li>
          }
        </ul>
        <a
          aecButton
          variant="on-brand"
          routerLink="/docs/trust/how-ranking-works"
          class="col-start-1 row-start-3 mt-8 justify-self-start md:col-start-2 md:row-start-1 md:mt-0"
          i18n="@@app.nav.howWeRank"
          >How we rank</a
        >
      </div>
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

  /**
   * What AECi does instead. The second idea is the band's one no-pay-for-placement line: the
   * phrase as its title, and ruling 65's order sentence as its body (AECI-2233, ruling 68).
   */
  protected readonly ideas: readonly Idea[] = [
    {
      id: 'documented',
      icon: 'checklist',
      title: $localize`:@@home.why.idea.documented.title:Every connection is documented`,
      body: $localize`:@@home.why.idea.documented.body:Each integration records what it links, the mechanism behind it, and where it falls short. A logo count tells you none of that.`,
    },
    {
      id: 'earned',
      icon: 'scale',
      title: $localize`:@@home.why.idea.earned.title:No pay-for-placement`,
      body: $localize`:@@home.why.idea.earned.body:Rankings are algorithmic. Payment never changes the order in which products are listed or returned in search.`,
    },
    {
      id: 'aec-native',
      icon: 'grid',
      title: $localize`:@@home.why.idea.aecNative.title:Organized the way AEC works`,
      body: $localize`:@@home.why.idea.aecNative.body:Browse by AEC category, project phase and role, not a generic software taxonomy with construction added as an afterthought.`,
    },
  ];
}
