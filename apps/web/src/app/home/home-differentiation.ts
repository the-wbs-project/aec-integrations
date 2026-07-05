import { Component } from '@angular/core';

/**
 * `aec-home-differentiation` — the home page "what's different" band (§4.1
 * section 4, AECI-273). It **reconciles** two near-duplicate "threes": the
 * landing's *product differentiators* ("Three ideas at the core") and the shipped
 * *operator promises* ("Trust is the product"). Per
 * `docs/design/unified-home-direction.md` §4 the band **leads with the three
 * product ideas** — reviewable integrations · separate product/onboarding
 * ratings · no pay-for-placement — and **folds the operator promise in as the
 * closing trust line** ("We earn revenue from vendors who want to be found, never
 * from changing what you see."), rather than running both as separate bands
 * (their overlap is "no pay-for-placement" = "never sell rankings").
 *
 * **Why a new component, not an in-place rework of `home-trust-pillars.ts`:** that
 * band is shared with the About page (`/about`), which still wants the standalone
 * "three trust commitments". Reworking it in place would silently change About, so
 * the home's reconciled story lives here and `home-trust-pillars.ts` stays as the
 * About band. There is no second trust block on the home — the home shows only
 * this band (the standalone trust band is absorbed here, per the design doc).
 *
 * Stage-1 honesty: idea 1 describes the *model* (each integration is a reviewable
 * object), it does **not** claim a verified catalogue exists — nothing is
 * dual-vendor-verified at Stage 1 (§4.1; §4.2 verified-badge placeholder).
 *
 * Treatment is the settled concept **b · warm commerce** (`unified-home-direction.md`
 * §4 / line 96): bordered cards on `--surface-raised` (**borders not shadows**),
 * each with a decorative **Clay top-tick** bar (`--accent-secondary`, fill only,
 * `aria-hidden`, well under the ≤5% cap). No motion.
 *
 * **Static + edge-cache / SSR-safe.** No data fetch, no per-visitor state, and no
 * client JS — it renders into the cacheable, visitor-state-neutral home HTML
 * (`Cache-Tag: route:index,index:home,taxonomy`, `s-maxage=900`), identical for every
 * visitor. It is a bare `<section>` (no internal `max-w` wrapper): the 4.11 page
 * assembly mounts it inside the centred home column, whose `flex` gap carries the
 * vertical rhythm (see `home.ts`). The three ideas are a real `<ul>`/`<li>` list
 * with a visible `<h3>` each, keeping a valid heading order under the section
 * `<h2>` (itself under the hero `<h1>`).
 *
 * Light theme only (Stage 1). Copy is authored with `$localize` so it stays
 * i18n-extractable in one place. Anchor site: Faire (AECI-270).
 */
interface Idea {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

@Component({
  selector: 'aec-home-differentiation',
  template: `
    <section>
      <p class="aec-overline text-(--text-secondary)" i18n="@@home.different.eyebrow">
        What's different
      </p>
      <h2
        class="mt-3 font-display text-3xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-4xl"
        i18n="@@home.different.headline"
      >
        Three ideas at the core
      </h2>

      <ul class="mt-10 grid gap-4 md:grid-cols-3">
        @for (idea of ideas; track idea.id) {
          <li
            class="flex flex-col rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-6"
          >
            <span class="mb-4 block h-1 w-10 bg-(--accent-secondary)" aria-hidden="true"></span>
            <h3 class="font-display text-xl leading-snug text-(--text-primary)">
              {{ idea.title }}
            </h3>
            <p class="mt-3 text-sm leading-relaxed text-(--text-secondary)">{{ idea.body }}</p>
          </li>
        }
      </ul>

      <p class="mt-8 max-w-2xl text-sm leading-relaxed text-(--text-secondary)">{{ closing }}</p>
    </section>
  `,
})
export class HomeDifferentiation {
  /** The three product ideas. Source: `unified-home-direction.md` §4 (translated
   *  from the landing's "Three ideas at the core" into the editorial voice). */
  protected readonly ideas: readonly Idea[] = [
    {
      id: 'reviewable',
      title: $localize`:@@home.different.idea1.title:Reviewable integrations`,
      body: $localize`:@@home.different.idea1.body:An integration count means nothing if half the connections are shallow or broken. We treat each integration as a reviewable object: what it links, how data flows, and where it falls short.`,
    },
    {
      id: 'separate-ratings',
      title: $localize`:@@home.different.idea2.title:Separate ratings for product and onboarding`,
      body: $localize`:@@home.different.idea2.body:A strong product with an 18 month rollout is a different proposition than one that deploys in weeks. We rate the product and the onboarding separately, instead of collapsing them into a single score.`,
    },
    {
      id: 'no-pay',
      title: $localize`:@@home.different.idea3.title:No pay-for-placement, ever`,
      body: $localize`:@@home.different.idea3.body:Listings are never boosted by spend. Rankings use a transparent method, and vendor responses sit alongside criticism, not instead of it.`,
    },
  ];

  /** Closing reinforcement — the absorbed operator promise (no competitor
   *  call-outs on the public site). Same statement as the About trust band. */
  protected readonly closing = $localize`:@@home.different.closing:We earn revenue from vendors who want to be found, never from changing what you see.`;
}
