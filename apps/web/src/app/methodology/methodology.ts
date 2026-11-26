/**
 * Editorial methodology page (`/methodology`, AECI-804 — a sub-issue of the
 * AECI-788 SEO / AI-answer-surface epic, workstream D).
 *
 * The one place the site states how the catalogue is built: inclusion criteria,
 * where the data comes from, what confirmation does and does not mean, the
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
 * Layout mirrors `/about` (AECI-1800): the hero on `aec-bone-band`, the page's
 * one Bone band, with the h1 at the Headline role (the global h1 size). The body
 * is a white band on the 1328px page wrap (`BAND_WRAP_CLASS`), the article capped
 * at 70ch. From `lg` the "On this page" list (`aec-page-toc`) fills the column
 * beside it, so the page has no empty right half (AECI-1720 layout pass); the
 * headings carry ids for it (`aec-prose-blocks`). The prose styles are the
 * shared `.aec-prose`, which AECI-1804 owns for `/legal/*` too, so this page does
 * not restyle them. Light theme only (Stage 1).
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { BAND_WRAP_CLASS } from '../shared/band-wrap';
import { BoneBand } from '../shared/bone-band/bone-band';
import { AecPageToc } from '../shared/page-toc/page-toc';
import { PROSE_PAGE_GRID_CLASS, PROSE_PAGE_TOC_CLASS } from '../shared/page-toc/page-toc';
import { AecProseBlocks } from '../shared/prose-blocks/prose-blocks';
import { METHODOLOGY_DOC, type MethodologyDoc } from './methodology-content';

@Component({
  selector: 'app-methodology',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AecPageToc, AecProseBlocks, BoneBand],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <!-- Hero: the page's one Bone band, as on /about. -->
      <aec-bone-band>
        <div class="max-w-[70ch]">
          <p class="aec-overline text-(--text-secondary)" i18n="@@app.methodology.eyebrow">
            Methodology
          </p>
          <h1 class="mt-4 text-(--text-primary)">
            {{ doc.frontmatter.title }}
          </h1>
          <!-- Authored pre-formatted in the frontmatter and rendered verbatim.
               Never parsed/reformatted here: SSR runs UTC and the browser does
               not, so a zone-local format would trip a hydration mismatch. -->
          <p class="mt-4 text-t-14 text-(--text-secondary)" i18n="@@app.methodology.lastUpdated">
            Last updated {{ doc.frontmatter.lastUpdated }}
          </p>
        </div>
      </aec-bone-band>

      <!-- Body: rendered Markdown (sanitized by Angular; no bypassSecurityTrust).
           Styled globally via .aec-prose, shared with /legal/*. White band on
           the page wrap; the article keeps its 70ch measure, and from lg the
           "On this page" list fills the column beside it. -->
      <div class="py-16 md:py-24">
        <div [class]="body">
          <article
            aec-prose-blocks
            class="aec-prose max-w-[70ch] min-w-0"
            [blocks]="doc.blocks"
          ></article>
          <aec-page-toc [class]="toc" [headings]="doc.headings" />
        </div>
      </div>
    </div>
  `,
})
export class MethodologyPage {
  private readonly meta = inject(MetaService);

  protected readonly doc: MethodologyDoc = METHODOLOGY_DOC;

  /**
   * The body on the 1328px page wrap the header, footer and bands share: the
   * article, then the "On this page" column from `lg`.
   */
  protected readonly body = `${BAND_WRAP_CLASS} ${PROSE_PAGE_GRID_CLASS}`;
  protected readonly toc = PROSE_PAGE_TOC_CLASS;

  constructor() {
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.methodologyTitle:How we research listings · AEC Integrations`,
      description: $localize`:@@meta.methodologyDescription:How AEC Integrations researches listings: what we list, where integration data comes from, what vendor confirmation means, and why payment never changes the order of results.`,
      canonical: canonicalUrl('/methodology'),
    });
  }
}
