import { Component, signal } from '@angular/core';

import type {
  IntegrationListItem,
  MostActiveCategory,
  MostIntegratedProduct,
  ProductListItem,
  TaxonomyTermWithCount,
} from '@aeci/shared';

import { BrowseGrid } from '../../home/browse-grid';
import { HomeHero } from '../../home/home-hero';
import { HomeStatsCards } from '../../home/home-stats-cards';
import { RecentIntegrationsSection } from '../../home/recent-integrations-section';
import { TrendingProductsSection } from '../../home/trending-products-section';

/**
 * Dev-only preview for the AECI-270 unified-home design pass (the direction-
 * setting child of AECI-269). It wires the FULL home flow in the §4.1 canonical
 * order — hero → [NEW marketing bands] → stats → browse → recent + trending →
 * [NEW closing CTA] → footer (app shell) — with the NEW bands rendered as three
 * live-toggleable premium concepts so the PO can choose one in the running app
 * (per `docs/design/LESSONS.md` 2026-06-10: "build all three in preview and then
 * I chose").
 *
 * The three concepts are distinct Faire-anchored editorial spines, all within the
 * DESIGN.md laws (Forest anchor, Clay ≤5% decorative, Bone accent bands only,
 * borders not shadows, Source Serif + Atkinson, sentence case, no em dashes, no
 * banned hero-metric template):
 *   - **a · Editorial restraint** — the trade-journal spine: hairline rules,
 *     numbered kickers, spec-sheet stat rows, near-zero fills.
 *   - **b · Warm commerce** — Faire-forward: Bone bands + bordered cards, a single
 *     decorative Clay tick, more visual but still editorial.
 *   - **c · Data-forward** — the directory-confident spine: a prominent live-count
 *     bar, a compressed problem, differentiation + how-it-works merged, the data
 *     sections carrying the weight.
 *
 * NOT the production components (AECI-269 build children 2–6 build those with the
 * real resolver wiring + i18n). The existing modules are the shipped components
 * fed synthetic fixtures (like `home-sections-preview.ts`); the new bands are
 * concept-fidelity throwaways with plain (non-i18n) copy translated from
 * `apps/landing/public/index.html` into the editorial voice. Route:
 * `/preview/unified-home`, production-blocked by `isPreviewPath`. Don't link to it
 * from product navigation. The hero owns the page `<h1>`.
 */
type Concept = 'a' | 'b' | 'c';

interface Figure {
  readonly figure: string;
  readonly desc: string;
}
interface Numbered {
  readonly n: string;
  readonly title: string;
  readonly body: string;
}

@Component({
  selector: 'app-unified-home-preview',
  imports: [
    HomeHero,
    HomeStatsCards,
    BrowseGrid,
    RecentIntegrationsSection,
    TrendingProductsSection,
  ],
  template: `
    <!-- Dev-only concept switcher. Not part of the surface under review. -->
    <div
      class="sticky top-0 z-40 border-b border-(--border-default) bg-(--surface-sunken)"
      role="region"
      aria-label="Concept switcher (dev only)"
    >
      <div class="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-2 px-6 py-3 md:px-8">
        <span class="aec-overline text-(--text-secondary)">AECI-270 concept</span>
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            [class]="tabClass('a')"
            [attr.aria-pressed]="concept() === 'a'"
            (click)="concept.set('a')"
          >
            a · Editorial restraint
          </button>
          <button
            type="button"
            [class]="tabClass('b')"
            [attr.aria-pressed]="concept() === 'b'"
            (click)="concept.set('b')"
          >
            b · Warm commerce
          </button>
          <button
            type="button"
            [class]="tabClass('c')"
            [attr.aria-pressed]="concept() === 'c'"
            (click)="concept.set('c')"
          >
            c · Data-forward
          </button>
        </div>
      </div>
    </div>

    <div class="bg-(--surface-base) text-(--text-primary)">
      <!-- 1 · Hero (existing component, owns the page h1). -->
      <aec-home-hero />

      <!-- 2–5 · NEW marketing bands (credibility / why / what's different / how). -->
      @switch (concept()) {
        @case ('a') {
          <!-- ===== Concept A: editorial restraint ===== -->
          <div class="mx-auto max-w-7xl px-6 md:px-8">
            <!-- 2 · Credibility strip -->
            <div
              class="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b border-(--border-default) py-6 text-sm text-(--text-secondary)"
            >
              @for (c of coverage; track c.label) {
                <span>
                  <span class="font-display text-lg tabular-nums text-(--accent-primary)">{{
                    c.figure
                  }}</span>
                  {{ c.label }}
                </span>
              }
              <span class="text-(--text-secondary)">{{ independence }}</span>
            </div>

            <!-- 3 · Why AECi / the problem -->
            <section class="border-b border-(--border-default) py-16 md:py-20">
              <p class="aec-overline text-(--text-secondary)">01 / {{ problem.eyebrow }}</p>
              <h2
                class="mt-3 max-w-3xl font-display text-3xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-4xl"
              >
                {{ problem.headline }}
              </h2>
              <div
                class="mt-5 max-w-2xl space-y-4 text-base leading-relaxed text-(--text-secondary)"
              >
                <p>{{ problem.para1 }}</p>
                <p>{{ problem.para2 }}</p>
              </div>
              <dl
                class="mt-10 grid grid-cols-1 divide-y divide-(--border-default) sm:grid-cols-3 sm:divide-x sm:divide-y-0"
              >
                @for (s of problem.stats; track s.figure) {
                  <div class="py-4 sm:px-6 sm:py-0 sm:first:ps-0">
                    <dt class="font-display text-3xl tabular-nums text-(--accent-primary)">
                      {{ s.figure }}
                    </dt>
                    <dd class="mt-2 text-sm leading-relaxed text-(--text-secondary)">
                      {{ s.desc }}
                    </dd>
                  </div>
                }
              </dl>
            </section>

            <!-- 4 · What's different (reworked trust + the three ideas) -->
            <section class="border-b border-(--border-default) py-16 md:py-20">
              <p class="aec-overline text-(--text-secondary)">02 / {{ ideas.eyebrow }}</p>
              <h2
                class="mt-3 font-display text-3xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-4xl"
              >
                {{ ideas.headline }}
              </h2>
              <ol class="mt-10 space-y-6">
                @for (it of ideas.items; track it.n) {
                  <li
                    class="grid grid-cols-[auto_1fr] gap-x-6 border-t border-(--border-default) pt-6"
                  >
                    <span class="font-display text-2xl tabular-nums text-(--accent-primary)">{{
                      it.n
                    }}</span>
                    <div class="max-w-2xl">
                      <h3 class="font-display text-xl leading-snug text-(--text-primary)">
                        {{ it.title }}
                      </h3>
                      <p class="mt-2 text-base leading-relaxed text-(--text-secondary)">
                        {{ it.body }}
                      </p>
                    </div>
                  </li>
                }
              </ol>
              <p class="mt-8 max-w-2xl text-sm leading-relaxed text-(--text-secondary)">
                {{ ideas.trustLine }}
              </p>
            </section>

            <!-- 5 · How it works -->
            <section class="py-16 md:py-20">
              <p class="aec-overline text-(--text-secondary)">03 / {{ steps.eyebrow }}</p>
              <h2
                class="mt-3 font-display text-3xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-4xl"
              >
                {{ steps.headline }}
              </h2>
              <ol class="mt-10 grid gap-8 sm:grid-cols-3">
                @for (st of steps.items; track st.n) {
                  <li class="border-t border-(--border-default) pt-4">
                    <span class="font-display text-2xl tabular-nums text-(--accent-primary)">{{
                      st.n
                    }}</span>
                    <h3 class="mt-2 font-display text-lg leading-snug text-(--text-primary)">
                      {{ st.title }}
                    </h3>
                    <p class="mt-2 text-sm leading-relaxed text-(--text-secondary)">
                      {{ st.body }}
                    </p>
                  </li>
                }
              </ol>
            </section>
          </div>
        }
        @case ('b') {
          <!-- ===== Concept B: warm commerce ===== -->
          <!-- 2 · Credibility strip (Bone band) -->
          <div class="border-y border-(--border-default) bg-(--accent-warm)">
            <div class="mx-auto flex max-w-7xl flex-wrap items-center gap-4 px-6 py-8 md:px-8">
              @for (c of coverage; track c.label) {
                <span
                  class="rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-4 py-2 text-sm text-(--text-secondary)"
                >
                  <span class="font-display tabular-nums text-(--accent-primary)">{{
                    c.figure
                  }}</span>
                  {{ c.label }}
                </span>
              }
              <span class="text-sm text-(--text-secondary)">{{ independence }}</span>
            </div>
          </div>

          <div class="mx-auto max-w-7xl px-6 md:px-8">
            <!-- 3 · Why AECi / the problem (Bone-tinted callout + stat cards) -->
            <section class="py-16 md:py-20">
              <p class="aec-overline inline-flex items-center gap-2 text-(--text-secondary)">
                <span
                  class="inline-block h-2 w-2 rounded-full bg-(--accent-secondary)"
                  aria-hidden="true"
                ></span>
                {{ problem.eyebrow }}
              </p>
              <div
                class="mt-4 rounded-(--radius-lg) border border-(--border-default) bg-(--accent-warm) p-8 md:p-10"
              >
                <h2
                  class="max-w-3xl font-display text-3xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-4xl"
                >
                  {{ problem.headline }}
                </h2>
                <div
                  class="mt-5 max-w-2xl space-y-4 text-base leading-relaxed text-(--text-secondary)"
                >
                  <p>{{ problem.para1 }}</p>
                  <p>{{ problem.para2 }}</p>
                </div>
              </div>
              <div class="mt-6 grid gap-4 sm:grid-cols-3">
                @for (s of problem.stats; track s.figure) {
                  <div
                    class="rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-6"
                  >
                    <p class="font-display text-4xl tabular-nums text-(--accent-primary)">
                      {{ s.figure }}
                    </p>
                    <p class="mt-3 text-sm leading-relaxed text-(--text-secondary)">{{ s.desc }}</p>
                  </div>
                }
              </div>
            </section>

            <!-- 4 · What's different (bordered cards, Clay top-tick) -->
            <section class="py-16 md:py-20">
              <p class="aec-overline text-(--text-secondary)">{{ ideas.eyebrow }}</p>
              <h2
                class="mt-3 font-display text-3xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-4xl"
              >
                {{ ideas.headline }}
              </h2>
              <ul class="mt-10 grid gap-4 md:grid-cols-3">
                @for (it of ideas.items; track it.n) {
                  <li
                    class="flex flex-col rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-6"
                  >
                    <span
                      class="mb-4 block h-1 w-10 bg-(--accent-secondary)"
                      aria-hidden="true"
                    ></span>
                    <h3 class="font-display text-xl leading-snug text-(--text-primary)">
                      {{ it.title }}
                    </h3>
                    <p class="mt-3 text-sm leading-relaxed text-(--text-secondary)">
                      {{ it.body }}
                    </p>
                  </li>
                }
              </ul>
              <p class="mt-8 max-w-2xl text-sm leading-relaxed text-(--text-secondary)">
                {{ ideas.trustLine }}
              </p>
            </section>

            <!-- 5 · How it works (step cards, Forest numerals) -->
            <section class="pb-16 md:pb-20">
              <p class="aec-overline text-(--text-secondary)">{{ steps.eyebrow }}</p>
              <h2
                class="mt-3 font-display text-3xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-4xl"
              >
                {{ steps.headline }}
              </h2>
              <ol class="mt-10 grid gap-4 sm:grid-cols-3">
                @for (st of steps.items; track st.n) {
                  <li
                    class="rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-6"
                  >
                    <span
                      class="flex h-9 w-9 items-center justify-center rounded-full border border-(--accent-primary) font-display tabular-nums text-(--accent-primary)"
                      >{{ st.n }}</span
                    >
                    <h3 class="mt-4 font-display text-lg leading-snug text-(--text-primary)">
                      {{ st.title }}
                    </h3>
                    <p class="mt-2 text-sm leading-relaxed text-(--text-secondary)">
                      {{ st.body }}
                    </p>
                  </li>
                }
              </ol>
            </section>
          </div>
        }
        @case ('c') {
          <!-- ===== Concept C: data-forward ===== -->
          <!-- 2 · Credibility count bar -->
          <div class="border-y border-(--border-default) bg-(--surface-raised)">
            <div
              class="mx-auto flex max-w-7xl flex-wrap items-baseline gap-x-10 gap-y-3 px-6 py-8 md:px-8"
            >
              @for (c of coverage; track c.label) {
                <span class="flex items-baseline gap-2">
                  <span class="font-display text-3xl tabular-nums text-(--accent-primary)">{{
                    c.figure
                  }}</span>
                  <span class="text-sm text-(--text-secondary)">{{ c.label }}</span>
                </span>
              }
              <span class="ms-auto max-w-sm text-sm text-(--text-secondary)">{{
                independence
              }}</span>
            </div>
          </div>

          <div class="mx-auto max-w-7xl px-6 md:px-8">
            <!-- 3 · Why AECi (compressed) -->
            <section class="py-12 md:py-16">
              <p class="aec-overline text-(--text-secondary)">{{ problem.eyebrow }}</p>
              <h2
                class="mt-3 max-w-3xl font-display text-3xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-4xl"
              >
                {{ problem.headline }}
              </h2>
              <p class="mt-4 max-w-2xl text-base leading-relaxed text-(--text-secondary)">
                {{ problem.para1 }}
              </p>
              <div class="mt-8 flex flex-wrap gap-x-10 gap-y-4">
                @for (s of problem.stats; track s.figure) {
                  <p class="max-w-xs text-sm leading-relaxed text-(--text-secondary)">
                    <span class="font-display text-2xl tabular-nums text-(--accent-primary)">{{
                      s.figure
                    }}</span>
                    {{ s.desc }}
                  </p>
                }
              </div>
            </section>

            <!-- 4 + 5 · What's different + how it works, merged -->
            <section class="border-t border-(--border-default) py-12 md:py-16">
              <p class="aec-overline text-(--text-secondary)">{{ ideas.eyebrow }}</p>
              <h2
                class="mt-3 font-display text-3xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-4xl"
              >
                {{ ideas.headline }}
              </h2>
              <ol class="mt-8 space-y-4">
                @for (it of ideas.items; track it.n) {
                  <li
                    class="grid grid-cols-[auto_1fr] items-baseline gap-x-4 border-t border-(--border-default) pt-4"
                  >
                    <span class="font-display tabular-nums text-(--accent-primary)">{{
                      it.n
                    }}</span>
                    <p class="max-w-3xl text-(--text-secondary)">
                      <span class="font-display text-lg text-(--text-primary)"
                        >{{ it.title }}.</span
                      >
                      {{ it.body }}
                    </p>
                  </li>
                }
              </ol>
              <p class="mt-8 max-w-3xl text-sm leading-relaxed text-(--text-secondary)">
                {{ mergedHowLine }}
              </p>
            </section>
          </div>
        }
      }

      <!-- 6–8 · Existing data modules (shipped components, synthetic fixtures). -->
      <div class="mx-auto w-full max-w-7xl px-6 py-8 md:px-8 md:py-12">
        <div class="flex flex-col gap-10 md:gap-12">
          <aec-home-stats-cards
            [totalIntegrations]="totalIntegrations"
            [integrationsAdded30d]="integrationsAdded30d"
            [mostIntegratedProduct]="mostIntegratedProduct"
            [mostActiveCategory]="mostActiveCategory"
          />
          <app-browse-grid kind="category" [terms]="categories" />
          <app-browse-grid kind="audience" [terms]="audiences" />
          <app-browse-grid kind="phase" [terms]="phases" />
          <aec-recent-integrations-section [integrations]="recentIntegrations" />
          <aec-trending-products-section
            [products]="trendingProducts"
            [recentlyAdded]="recentlyAddedProducts"
          />
        </div>
      </div>

      <!-- 9 · NEW closing CTA + capture (progressive-enhancement island in prod). -->
      @switch (concept()) {
        @case ('a') {
          <section class="border-t border-(--border-default) bg-(--accent-warm)">
            <div class="mx-auto max-w-7xl px-6 py-16 md:px-8 md:py-20">
              <p class="aec-overline text-(--text-secondary)">{{ cta.eyebrow }}</p>
              <h2
                class="mt-3 max-w-2xl font-display text-3xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-4xl"
              >
                {{ cta.headline }}
              </h2>
              <p class="mt-4 max-w-xl text-base leading-relaxed text-(--text-secondary)">
                {{ cta.body }}
              </p>
              <form class="mt-8 flex max-w-xl flex-wrap gap-3" novalidate>
                <label class="sr-only" for="uh-email-a">Email address</label>
                <input
                  id="uh-email-a"
                  type="email"
                  autocomplete="email"
                  placeholder="you@yourfirm.com"
                  [class]="emailClass"
                />
                <button type="button" [class]="primaryBtn">{{ cta.button }}</button>
              </form>
              <p class="mt-4 text-sm text-(--text-secondary)">
                {{ cta.feedbackLead }}
                <button type="button" [class]="linkBtn">{{ cta.feedbackAction }}</button>
              </p>
            </div>
          </section>
        }
        @case ('b') {
          <section class="bg-(--accent-warm)">
            <div class="mx-auto max-w-7xl px-6 py-16 md:px-8 md:py-20">
              <div
                class="rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base) p-8 md:p-10"
              >
                <p class="aec-overline text-(--text-secondary)">{{ cta.eyebrow }}</p>
                <h2
                  class="mt-3 max-w-2xl font-display text-3xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-4xl"
                >
                  {{ cta.headline }}
                </h2>
                <p class="mt-4 max-w-xl text-base leading-relaxed text-(--text-secondary)">
                  {{ cta.body }}
                </p>
                <form class="mt-8 flex max-w-xl flex-wrap gap-3" novalidate>
                  <label class="sr-only" for="uh-email-b">Email address</label>
                  <input
                    id="uh-email-b"
                    type="email"
                    autocomplete="email"
                    placeholder="you@yourfirm.com"
                    [class]="emailClass"
                  />
                  <button type="button" [class]="primaryBtn">{{ cta.button }}</button>
                </form>
                <p class="mt-4 text-sm text-(--text-secondary)">
                  {{ cta.feedbackLead }}
                  <button type="button" [class]="linkBtn">{{ cta.feedbackAction }}</button>
                </p>
              </div>
            </div>
          </section>
        }
        @case ('c') {
          <section class="border-t border-(--border-default) bg-(--surface-sunken)">
            <div
              class="mx-auto flex max-w-7xl flex-col gap-6 px-6 py-12 md:flex-row md:items-center md:justify-between md:px-8"
            >
              <div class="max-w-md">
                <h2
                  class="font-display text-2xl font-normal leading-[1.15] tracking-[-0.01em] text-(--text-primary) md:text-3xl"
                >
                  {{ cta.headline }}
                </h2>
                <p class="mt-2 text-sm leading-relaxed text-(--text-secondary)">{{ cta.body }}</p>
              </div>
              <div>
                <form class="flex flex-wrap gap-3" novalidate>
                  <label class="sr-only" for="uh-email-c">Email address</label>
                  <input
                    id="uh-email-c"
                    type="email"
                    autocomplete="email"
                    placeholder="you@yourfirm.com"
                    [class]="emailClass"
                  />
                  <button type="button" [class]="primaryBtn">{{ cta.button }}</button>
                </form>
                <p class="mt-3 text-sm text-(--text-secondary)">
                  {{ cta.feedbackLead }}
                  <button type="button" [class]="linkBtn">{{ cta.feedbackAction }}</button>
                </p>
              </div>
            </div>
          </section>
        }
      }
    </div>
  `,
})
export class UnifiedHomePreview {
  // Defaults to 'b' — the chosen direction (AECI-270, 2026-06-25). a / c stay toggleable for reference.
  protected readonly concept = signal<Concept>('b');

  /** Active/idle classes for the dev concept toggle (token classes can't be `[class.x]` keys). */
  protected tabClass(c: Concept): string {
    const base =
      'rounded-(--radius-sm) border px-3 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
    return this.concept() === c
      ? `${base} border-(--accent-primary) text-(--accent-primary)`
      : `${base} border-(--border-default) text-(--text-secondary) hover:text-(--text-primary)`;
  }

  // ---- New-band copy (translated from apps/landing into the editorial voice;
  //      no em dashes, sentence case, no banned words, Stage-1-honest). ----
  protected readonly coverage = [
    { figure: '45', label: 'products' },
    { figure: '90', label: 'integrations' },
    { figure: '33', label: 'vendors' },
  ];
  protected readonly independence =
    'Independent and editorially neutral. No vendor marketing, no pay-for-placement.';

  protected readonly problem = {
    eyebrow: 'The problem',
    headline: 'The software review landscape is broken',
    para1:
      "AEC firms making six and seven figure software decisions rely on platforms riddled with pay-to-play rankings, AI-generated reviews, and vendor-funded visibility. The tools at the top aren't the best ones. They're the ones that paid the most.",
    para2:
      'Meanwhile the information that actually decides a purchase, whether an integration really works, what implementation takes, and what a tool costs after the sales pitch, is almost impossible to find.',
    // Figures revised to their citable values in AECI-285 (the shipped band lives
    // in `home-why.ts`; full research in `docs/design/home-why-market-figures.md`).
    stats: [
      {
        figure: '≈19%',
        desc: 'of Google reviews were AI-generated by late 2024, up from about 5% in 2019',
      },
      {
        figure: '$27K',
        desc: 'a year is what a typical vendor pays for paid visibility on a leading review site',
      },
      {
        figure: '900+',
        desc: 'tools lumped into generic categories with no way to filter by AEC discipline',
      },
    ] satisfies Figure[],
  };

  protected readonly ideas = {
    eyebrow: "What's different",
    headline: 'Three ideas at the core',
    items: [
      {
        n: '01',
        title: 'Reviewable integrations',
        body: 'An integration count means nothing if half the connections are shallow or broken. We treat each integration as a reviewable object: what it links, how data flows, and where it falls short.',
      },
      {
        n: '02',
        title: 'Separate ratings for product and onboarding',
        body: 'A strong product with an 18 month rollout is a different proposition than one that deploys in weeks. We rate the product and the onboarding separately, instead of collapsing them into a single score.',
      },
      {
        n: '03',
        title: 'No pay-for-placement, ever',
        body: 'Listings are never boosted by spend. Rankings use a transparent method, and vendor responses sit alongside criticism, not instead of it.',
      },
    ] satisfies Numbered[],
    trustLine:
      'We earn revenue from vendors who want to be found, never from changing what you see.',
  };

  protected readonly steps = {
    eyebrow: 'How it works',
    headline: 'How a listing earns its place',
    items: [
      {
        n: '1',
        title: 'Integrations are documented',
        body: 'Each connection records what it links, the mechanism, and its direction.',
      },
      {
        n: '2',
        title: 'Practitioners review them',
        body: 'The people who run the tools rate the product and the onboarding, separately.',
      },
      {
        n: '3',
        title: 'Nothing is for sale',
        body: 'Position is earned by relevance and reviews. Payment never moves it.',
      },
    ] satisfies Numbered[],
  };

  protected readonly mergedHowLine =
    'How it works: integrations are documented, practitioners review the product and the onboarding separately, and position is earned by relevance and reviews, never bought.';

  protected readonly cta = {
    eyebrow: 'Stay in the loop',
    headline: 'Get notified when we launch',
    body: "We're building this in the open. Drop your email for milestone updates. No spam, just progress.",
    button: 'Subscribe',
    feedbackLead: 'Think we are missing a tool?',
    feedbackAction: 'Suggest a tool',
  };

  // Shared form chrome (Forest CTA per the Forest-Anchor Rule; borders not shadows).
  protected readonly emailClass =
    'min-w-0 flex-1 rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly primaryBtn =
    'rounded-(--radius-sm) bg-(--accent-primary) px-5 py-2 font-label text-white transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly linkBtn =
    'rounded-sm font-label text-(--accent-primary) underline decoration-1 underline-offset-4 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  // ---- Synthetic fixtures for the shipped data modules (mirrors home-sections-preview). ----
  protected readonly totalIntegrations = 90;
  protected readonly integrationsAdded30d = 12;
  protected readonly mostIntegratedProduct: MostIntegratedProduct = {
    product: { id: 'p-procore', name: 'Procore', slug: 'procore', logo_url: null },
    integration_count: 24,
  };
  protected readonly mostActiveCategory: MostActiveCategory = {
    category: { id: 'c-pm', name: 'Project management', slug: 'project-management' },
    integration_count: 61,
  };

  protected readonly categories: readonly TaxonomyTermWithCount[] = [
    this.term('project-management', 'Project management', 18, 1),
    this.term('bim-authoring', 'BIM authoring', 12, 2),
    this.term('estimating', 'Estimating', 9, 3),
    this.term('document-control', 'Document control', 7, 4),
    this.term('field-reporting', 'Field reporting', 6, 5),
  ];
  protected readonly audiences: readonly TaxonomyTermWithCount[] = [
    this.term('architects', 'Architects', 14, 1),
    this.term('structural-engineers', 'Structural engineers', 11, 2),
    this.term('general-contractors', 'General contractors', 13, 3),
    this.term('estimators', 'Estimators', 8, 4),
    this.term('project-managers', 'Project managers', 15, 5),
  ];
  protected readonly phases: readonly TaxonomyTermWithCount[] = [
    this.term('preconstruction', 'Preconstruction', 16, 1),
    this.term('design', 'Design', 19, 2),
    this.term('construction', 'Construction', 22, 3),
    this.term('operations', 'Operations', 7, 4),
  ];

  protected readonly recentIntegrations: readonly IntegrationListItem[] = [
    this.integration(1, 'Revit', 'Navisworks', 'native', 'bidirectional'),
    this.integration(2, 'Procore', 'QuickBooks', 'api', 'one-way'),
    this.integration(3, 'Bluebeam', 'SharePoint', 'marketplace-app', null),
    this.integration(4, 'AutoCAD', 'BIM 360', null, 'one-way'),
  ];
  protected readonly trendingProducts: readonly ProductListItem[] = [
    this.product(1, 'Procore', 'Procore Technologies', 'Project management', 24),
    this.product(2, 'Autodesk Construction Cloud', 'Autodesk', 'BIM', 18),
    this.product(3, 'Bluebeam Revu', 'Bluebeam', 'Document control', 9),
    this.product(4, 'PlanGrid', 'Autodesk', 'Field reporting', 6),
  ];
  protected readonly recentlyAddedProducts: readonly ProductListItem[] = [
    this.product(5, 'Fieldwire', 'Hilti', 'Field reporting', 3),
    this.product(6, 'Newforma', 'Newforma', 'Project information', 2),
  ];

  private term(
    slug: string,
    name: string,
    product_count: number,
    display_order: number,
  ): TaxonomyTermWithCount {
    return { id: `tax-${slug}`, slug, name, description: null, display_order, product_count };
  }

  private integration(
    n: number,
    source: string,
    target: string,
    mechanism_kind: IntegrationListItem['mechanism_kind'],
    direction: IntegrationListItem['direction'],
  ): IntegrationListItem {
    const slug = (name: string) => name.toLowerCase().replace(/\s+/g, '-');
    return {
      id: `00000000-0000-4000-8000-0000002700${String(n).padStart(2, '0')}`,
      name: `${source} → ${target}`,
      mechanism_kind,
      mechanism_name: null,
      direction,
      source: { id: `s${n}`, slug: slug(source), name: source, logo_url: null },
      target: { id: `t${n}`, slug: slug(target), name: target, logo_url: null },
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
    };
  }

  private product(
    n: number,
    name: string,
    vendor: string,
    category: string,
    integration_count: number,
  ): ProductListItem {
    const slug = (s: string) => s.toLowerCase().replace(/\s+/g, '-');
    return {
      id: `00000000-0000-4000-8000-0000002701${String(n).padStart(2, '0')}`,
      slug: slug(name),
      name,
      logo_url: null,
      product_role: 'application',
      vendor: { id: `v${n}`, slug: slug(vendor), name: vendor, logo_url: null },
      primary_category: { id: `c${n}`, slug: slug(category), name: category },
      integration_count,
      review_count: 0,
      rating_overall_avg: null,
      rating_onboarding_avg: null,
      created_at: '2026-05-20T00:00:00.000Z',
      updated_at: '2026-06-05T00:00:00.000Z',
    };
  }
}
