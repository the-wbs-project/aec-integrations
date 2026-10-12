/**
 * Docs article page (`/docs/<section>/<slug>`, AECI-1104, AECI-1248, AECI-1259;
 * `docs/STAGE_2_PRODUCT_DOCS_SPEC.md` §3). One component renders every page in
 * the docs manifest (`docs-content.ts`); the route's `data` selects which. It
 * renders inside `DocsShellComponent`, which owns the sidebar, the breadcrumb
 * and the "Last updated" line in the top bar.
 *
 * Anchor site: **Devin (DeepWiki)**, Mobbin screen c3936cdb. The article is a
 * compact centred column with a small Source Serif `h1`, one muted lede line,
 * then the body in `.aec-prose aec-docs-prose`. From `xl` the "On this page"
 * rail (`docs-toc.ts`) sits at the far right. A quiet previous / next pager
 * closes the article. No overline, no hero, no cards (the Plans page's
 * pricing widget is the one exception).
 *
 * **Headings carry ids.** The body arrives as blocks (`docs-markdown.ts`). This
 * template renders each `h2` / `h3` with a bound `[id]`, because the
 * `[innerHTML]` sanitizer would strip one, and passes only the HTML between
 * headings through `[innerHTML]`. The block wrappers are `display: contents`,
 * so the prose rhythm sees one flat flow. A widget block (the Plans page's
 * cards and table) splits the flow: it renders its component outside
 * `.aec-prose`, and the prose resumes in a new wrapper after it.
 *
 * **Static + edge-cache / SSR-safe.** No data fetch and no per-visitor state:
 * the Markdown is bundled at build time and parsed once per isolate, so the HTML
 * is identical on the SSR Worker and after hydration. `/docs` and `/docs/*`
 * carry `Cache-Tag: route:index` on the static-page TTL (`ROUTE_CACHE_PATTERNS`
 * + `cacheTagInputsForPath`).
 *
 * **Noindex by path.** The robots meta comes from `pathForcesNoindex`
 * (`docs-indexing.ts`), the same list the egress `X-Robots-Tag` stamp and the
 * sitemap read. It has been empty since AECI-1253, so every docs page is
 * indexable.
 *
 * **i18n split.** The Markdown body is content and is not extracted (the
 * `/legal/*` rule, `src/content/README.md`). The chrome below is `i18n` /
 * `$localize`-wrapped. The page title and description come from frontmatter, so
 * they reach `$localize` as placeholders.
 *
 * **Reading order:** the article, then the rail, then the pager. Light only.
 */
import { Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { type DocsBlock, type DocsPage, docsNeighbours, getDocsPage } from './docs-content';
import { pathForcesNoindex } from './docs-indexing';
import type { DocsWidget } from './docs-markdown';
import { DocsPlansComparisonComponent } from './docs-plans-comparison';
import { DocsTocComponent } from './docs-toc';
import {
  PlanCtaActionsComponent,
  PlanCtaMobileBarComponent,
  PlanCtaPanelComponent,
  PlanCtaRailComponent,
} from '../shared/plan-cta/plan-cta';
import { ClaimDialogHost } from '../shared/claim-dialog/claim-dialog-host';
import { PlanInquiryHost } from '../shared/plan-inquiry/plan-inquiry-host';

/** A run of prose blocks, or one widget. */
export interface DocsSegment {
  /** Set on a widget segment, whose `blocks` is empty. */
  readonly widget?: DocsWidget;
  readonly blocks: readonly DocsBlock[];
}

/** Cuts a body at its widget blocks, so each prose run gets its own wrapper. */
export function docsSegments(blocks: readonly DocsBlock[]): readonly DocsSegment[] {
  const segments: DocsSegment[] = [];
  let run: DocsBlock[] = [];
  for (const block of blocks) {
    if (block.widget) {
      if (run.length > 0) segments.push({ blocks: run });
      segments.push({ widget: block.widget, blocks: [] });
      run = [];
    } else {
      run.push(block);
    }
  }
  if (run.length > 0) segments.push({ blocks: run });
  return segments;
}

@Component({
  selector: 'app-docs-page',
  imports: [
    RouterLink,
    DocsTocComponent,
    DocsPlansComparisonComponent,
    PlanCtaActionsComponent,
    PlanCtaMobileBarComponent,
    PlanCtaPanelComponent,
    PlanCtaRailComponent,
    ClaimDialogHost,
    PlanInquiryHost,
  ],
  template: `
    <div
      class="px-4 pt-8 pb-14 md:px-6 lg:px-8 lg:pt-10 xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,42rem)_minmax(0,1fr)] xl:gap-x-8"
    >
      <article class="mx-auto w-full max-w-[42rem] min-w-0 xl:col-start-2 xl:row-start-1">
        <header>
          <h1 class="aec-docs-title text-(--text-primary)">{{ page.title }}</h1>
          <p class="mt-2 leading-relaxed text-(--text-secondary)">{{ page.description }}</p>
          <!-- Pre-formatted in the frontmatter and rendered verbatim: SSR runs
               UTC and the browser does not, so reformatting would mismatch.
               The top bar shows this line from sm; here it covers phones. -->
          <p class="mt-2 text-sm text-(--text-secondary) sm:hidden" i18n="@@app.docs.lastUpdated">
            Last updated {{ page.lastUpdated }}
          </p>
        </header>
        <!-- Rendered Markdown, sanitized by Angular, styled by .aec-prose. A
             widget block renders its component between prose runs, outside
             .aec-prose, so the prose list and table rules do not reach it. -->
        @for (segment of segments; track $index; let first = $first) {
          @if (segment.widget === 'plans-comparison') {
            <app-docs-plans-comparison class="mt-5 mb-10" />
          } @else if (segment.widget === 'plans-actions') {
            <!-- The intro's pointer to the public vendor program page
                 (VENDOR_PROGRAM_PAGE_SPEC.md section 10), then the button pair. -->
            <p
              class="mt-6 leading-relaxed text-(--text-secondary)"
              data-testid="docs-plans-vendor-program"
              i18n="@@app.docs.plans.vendorProgram"
            >
              For a short overview of what AEC Integrations offers vendors, see
              <a
                routerLink="/vendor-program"
                class="rounded-sm font-medium text-(--accent-primary) underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                >the vendor program</a
              >.
            </p>
            <aec-plan-cta-actions class="mt-6 mb-10" page="docs_plans" />
          } @else if (segment.widget === 'plans-cta') {
            <aec-plan-cta-panel class="mt-6 mb-6" page="docs_plans" />
          } @else {
            <div class="aec-prose aec-docs-prose" [class.mt-6]="first">
              @for (block of segment.blocks; track $index) {
                @if (block.heading; as heading) {
                  @if (heading.level === 2) {
                    <h2 [id]="heading.id">{{ heading.text }}</h2>
                  } @else {
                    <h3 [id]="heading.id">{{ heading.text }}</h3>
                  }
                }
                @if (block.html) {
                  <div class="contents" [innerHTML]="block.html"></div>
                }
              }
            </div>
          }
        }
      </article>

      @if (page.cta === 'managed') {
        <!-- The Plans page: the rail also carries the Managed card, from 90rem,
             where the column is wide enough. Both stick together. The card goes
             first: the dash list is absolutely placed and takes no height, so
             anything after it would sit on top of the dashes. -->
        <div
          class="hidden xl:sticky xl:top-8 xl:z-10 xl:col-start-3 xl:row-span-2 xl:row-start-1 xl:flex xl:flex-col xl:items-end xl:gap-8 xl:self-start xl:justify-self-end"
        >
          <aec-plan-cta-rail class="hidden w-44 min-[90rem]:block" page="docs_plans" />
          <app-docs-toc class="block w-10" [headings]="page.headings" [path]="page.path" />
        </div>
        <aec-plan-cta-mobile-bar page="docs_plans" />
        <!-- One claim dialog for every claim control (AECI-1293) and one inquiry
             dialog for the pricing links (AECI-1279), each loaded on first use. -->
        <aec-claim-dialog-host />
        <aec-plan-inquiry-host />
      } @else {
        <app-docs-toc
          class="hidden xl:sticky xl:top-8 xl:z-10 xl:col-start-3 xl:row-span-2 xl:row-start-1 xl:block xl:w-10 xl:self-start xl:justify-self-end"
          [headings]="page.headings"
          [path]="page.path"
        />
      }

      @if (neighbours.prev || neighbours.next) {
        <nav
          class="mx-auto mt-12 flex w-full max-w-[42rem] gap-6 border-t border-(--border-default) pt-5 text-sm xl:col-start-2 xl:row-start-2"
          i18n-aria-label="@@app.docs.pager.aria"
          aria-label="Previous and next articles"
        >
          @if (neighbours.prev; as prev) {
            <a
              [routerLink]="prev.path"
              rel="prev"
              class="group min-w-0 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--accent-primary)"
            >
              <span class="block text-(--text-secondary)" i18n="@@app.docs.pager.previous"
                >Previous</span
              >
              <span
                class="mt-0.5 block font-medium text-(--accent-primary) underline-offset-4 group-hover:underline"
                >{{ prev.title }}</span
              >
            </a>
          }
          @if (neighbours.next; as next) {
            <a
              [routerLink]="next.path"
              rel="next"
              class="group ms-auto min-w-0 rounded-sm text-end focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--accent-primary)"
            >
              <span class="block text-(--text-secondary)" i18n="@@app.docs.pager.next">Next</span>
              <span
                class="mt-0.5 block font-medium text-(--accent-primary) underline-offset-4 group-hover:underline"
                >{{ next.title }}</span
              >
            </a>
          }
        </nav>
      }
    </div>
  `,
})
export class DocsPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly meta = inject(MetaService);

  protected readonly page: DocsPage;
  protected readonly segments: readonly DocsSegment[];
  protected readonly neighbours: { readonly prev?: DocsPage; readonly next?: DocsPage };

  constructor() {
    const { section, slug } = this.route.snapshot.data as { section: string; slug: string };
    const page = getDocsPage(section, slug);
    if (!page) {
      // Programming error: routes are generated from the same manifest.
      throw new Error(`No docs page for /docs/${section}/${slug}`);
    }
    this.page = page;
    this.segments = docsSegments(page.blocks);
    this.neighbours = docsNeighbours(page);

    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.docsPageTitle:${page.title}:title: · AEC Integrations`,
      description: page.description,
      canonical: canonicalUrl(page.path),
      noindex: pathForcesNoindex(page.path),
    });
  }
}
