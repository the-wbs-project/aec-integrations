/**
 * Editorial methodology page (`/methodology`, AECI-804 — a sub-issue of the
 * AECI-788 SEO / AI-answer-surface epic, workstream D).
 *
 * The one place the site states how the catalogue is built: inclusion criteria,
 * where the data comes from, what verification does and does not mean, the
 * no-pay-for-placement rule, the correction routes, and who is accountable.
 * `docs/STAGE_2_5_SPEC.md` §7 governs it.
 *
 * **Assembled, never invented.** Every assertion in the body maps to shipped
 * behaviour. The load-bearing constraint is that the page must not overstate:
 * it names no ranking signals (the AECI-636 overhaul retires the current ones,
 * and `STAGE_2_5_SPEC.md` §2 step 3 owns that copy), promises no accuracy
 * warranty or response SLA (`/legal/listing-accuracy` disclaims both), claims no
 * paid capability that is declared but unwired, and says plainly that vendor
 * confirmation is not yet reachable rather than describing the agreement ladder
 * as an observed state.
 *
 * **Static + edge-cache / SSR-safe.** No data fetch, no per-visitor state, no
 * client JS — the body is inlined at build time (`methodology-content.ts`), so
 * everything renders into cacheable, visitor-state-neutral HTML. `/methodology`
 * carries `Cache-Tag: route:index` on the 24h edge / 1h browser static-page TTL
 * via `ROUTE_CACHE_PATTERNS` + `cacheTagInputsForPath`, and is in `sitemap.xml`.
 * Indexable, so `setStaticPageMeta` emits title + description + canonical + OG
 * and no `robots` tag. Meta is set from the constructor (the `/about` and
 * `/legal/*` pattern) so it ships in the SSR head AND refreshes on an in-app
 * navigation onto the route.
 *
 * **No JSON-LD, deliberately.** `setStaticPageMeta` clears it. The site-wide
 * `@id`-linked entity graph is AECI-784's job, and an ad-hoc `Organization` node
 * here would collide with the existing `publisher` semantics on pair pages,
 * where `publisher` means the software's vendor (`core/meta.helpers.ts`).
 *
 * **i18n split.** The Markdown body is *content* and is not extracted (the
 * `/legal/*` rule; see `src/content/README.md`). The chrome below is UI strings
 * and is `i18n`/`$localize`-wrapped like every other surface.
 *
 * Layout mirrors `/about` and `/legal/*`: a warm Bone (`accent-warm`) hero band
 * (never a page background), body measure capped at 70ch, Source Serif display
 * for headings, Atkinson for prose. Light theme only (Stage 1).
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { METHODOLOGY_DOC, type MethodologyDoc } from './methodology-content';

@Component({
  selector: 'app-methodology',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <!-- Hero: warm Bone accent band (the Surfaces-Are-Neutral treatment, not a
           page background), mirroring /about and /legal/*. -->
      <section class="border-b border-(--border-default) bg-(--accent-warm)">
        <div class="mx-auto max-w-7xl px-6 py-16 md:px-8 md:py-20">
          <div class="max-w-[70ch]">
            <p class="aec-overline text-(--accent-primary)" i18n="@@app.methodology.eyebrow">
              Methodology
            </p>
            <h1
              class="mt-3 font-display text-4xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-5xl"
            >
              {{ doc.frontmatter.title }}
            </h1>
            <!-- Authored pre-formatted in the frontmatter and rendered verbatim.
                 Never parsed/reformatted here: SSR runs UTC and the browser does
                 not, so a zone-local format would trip a hydration mismatch. -->
            <p class="mt-4 text-sm text-(--text-secondary)" i18n="@@app.methodology.lastUpdated">
              Last updated {{ doc.frontmatter.lastUpdated }}
            </p>
          </div>
        </div>
      </section>

      <!-- Body: rendered Markdown (sanitized by Angular; no bypassSecurityTrust).
           Styled globally via .aec-prose, shared with /legal/*. -->
      <div class="mx-auto max-w-7xl px-6 py-12 md:px-8 md:py-16">
        <article class="aec-prose max-w-[70ch]" [innerHTML]="doc.html"></article>
      </div>
    </div>
  `,
})
export class MethodologyPage {
  private readonly meta = inject(MetaService);

  protected readonly doc: MethodologyDoc = METHODOLOGY_DOC;

  constructor() {
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.methodologyTitle:How we research and verify listings · AEC Integrations`,
      description: $localize`:@@meta.methodologyDescription:How AEC Integrations researches and verifies listings: what we list, where integration data comes from, what vendor confirmation means, and why position is never for sale.`,
      canonical: canonicalUrl('/methodology'),
    });
  }
}
