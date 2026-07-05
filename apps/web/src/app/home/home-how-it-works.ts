import { Component } from '@angular/core';

/**
 * `aec-home-how-it-works` — the home page "how it works" band (§4.1 section 5,
 * AECI-273). A compact three-step line-up that **earns the "reviews" framing**
 * the footer used to assert, stated as the **operating model** (present tense):
 * (1) integrations are documented, (2) practitioners review them (product and
 * onboarding separately), (3) nothing is for sale. It deliberately makes **no
 * claim that a verified or reviewed inventory already exists** at launch —
 * nothing is dual-vendor-verified at Stage 1 (`STAGE_1_SPEC.md` §4.1; §4.2
 * verified-badge placeholder), so the copy describes how a listing earns its
 * place, not a verified catalogue.
 *
 * Treatment is the settled concept **b · warm commerce**
 * (`docs/design/unified-home-direction.md` §5): bordered step cards on
 * `--surface-raised` (borders not shadows), each with a **Forest-circled**
 * numeral. The steps are a genuine sequence, so the list is an `<ol>`; the
 * numerals are real visible ordinals (not `aria-hidden`).
 *
 * **Static + edge-cache / SSR-safe.** No data fetch, no per-visitor state, and
 * no client JS — it renders into the cacheable, visitor-state-neutral home HTML
 * (`Cache-Tag: route:index,index:home,taxonomy`, `s-maxage=900`), identical for every
 * visitor. It is a bare `<section>` (no internal `max-w` wrapper): the 4.11 page
 * assembly mounts it inside the centred home column, whose `flex` gap carries the
 * vertical rhythm (see `home.ts`). The single `<h2>` keeps a valid heading order
 * under the hero `<h1>`; each step owns an `<h3>`.
 *
 * Light theme only (Stage 1). Copy is authored with `$localize` so it stays
 * i18n-extractable in one place. Anchor site: Faire (AECI-270).
 */
interface Step {
  readonly n: string;
  readonly title: string;
  readonly body: string;
}

@Component({
  selector: 'aec-home-how-it-works',
  template: `
    <section>
      <p class="aec-overline text-(--text-secondary)" i18n="@@home.how.eyebrow">How it works</p>
      <h2
        class="mt-3 font-display text-3xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-4xl"
        i18n="@@home.how.headline"
      >
        How a listing earns its place
      </h2>

      <ol class="mt-10 grid gap-4 sm:grid-cols-3">
        @for (st of steps; track st.n) {
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
            <p class="mt-2 text-sm leading-relaxed text-(--text-secondary)">{{ st.body }}</p>
          </li>
        }
      </ol>
    </section>
  `,
})
export class HomeHowItWorks {
  /** The three operating-model steps. Source: `unified-home-direction.md` §5. */
  protected readonly steps: readonly Step[] = [
    {
      n: '1',
      title: $localize`:@@home.how.step1.title:Integrations are documented`,
      body: $localize`:@@home.how.step1.body:Each connection records what it links, the mechanism, and its direction.`,
    },
    {
      n: '2',
      title: $localize`:@@home.how.step2.title:Practitioners review them`,
      body: $localize`:@@home.how.step2.body:The people who run the tools rate the product and the onboarding, separately.`,
    },
    {
      n: '3',
      title: $localize`:@@home.how.step3.title:Nothing is for sale`,
      body: $localize`:@@home.how.step3.body:Position is earned by relevance and reviews. Payment never moves it.`,
    },
  ];
}
