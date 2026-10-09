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
 * closes the article. No overline, no hero, no cards.
 *
 * **Headings carry ids.** The body arrives as blocks (`docs-markdown.ts`). This
 * template renders each `h2` / `h3` with a bound `[id]`, because the
 * `[innerHTML]` sanitizer would strip one, and passes only the HTML between
 * headings through `[innerHTML]`. The block wrappers are `display: contents`,
 * so the prose rhythm sees one flat flow.
 *
 * **Static + edge-cache / SSR-safe.** No data fetch and no per-visitor state:
 * the Markdown is bundled at build time and parsed once per isolate, so the HTML
 * is identical on the SSR Worker and after hydration. `/docs` and `/docs/*`
 * carry `Cache-Tag: route:index` on the static-page TTL (`ROUTE_CACHE_PATTERNS`
 * + `cacheTagInputsForPath`).
 *
 * **Noindex by path.** The robots meta comes from `pathForcesNoindex`
 * (`docs-indexing.ts`), the same list the egress `X-Robots-Tag` stamp and the
 * sitemap read. Today it holds the vendor guide out until AECI-1253.
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
import { type DocsPage, docsNeighbours, getDocsPage } from './docs-content';
import { pathForcesNoindex } from './docs-indexing';
import { DocsTocComponent } from './docs-toc';

@Component({
  selector: 'app-docs-page',
  imports: [RouterLink, DocsTocComponent],
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
        <!-- Rendered Markdown, sanitized by Angular, styled by .aec-prose. -->
        <div class="aec-prose aec-docs-prose mt-6">
          @for (block of page.blocks; track $index) {
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
      </article>

      <app-docs-toc
        class="hidden xl:sticky xl:top-8 xl:z-10 xl:col-start-3 xl:row-span-2 xl:row-start-1 xl:block xl:w-10 xl:self-start xl:justify-self-end"
        [headings]="page.headings"
        [path]="page.path"
      />

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
  protected readonly neighbours: { readonly prev?: DocsPage; readonly next?: DocsPage };

  constructor() {
    const { section, slug } = this.route.snapshot.data as { section: string; slug: string };
    const page = getDocsPage(section, slug);
    if (!page) {
      // Programming error: routes are generated from the same manifest.
      throw new Error(`No docs page for /docs/${section}/${slug}`);
    }
    this.page = page;
    this.neighbours = docsNeighbours(page);

    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.docsPageTitle:${page.title}:title: · AEC Integrations`,
      description: page.description,
      canonical: canonicalUrl(page.path),
      // TODO(AECI-1253): the vendor guide stays noindex until it is published.
      noindex: pathForcesNoindex(page.path),
    });
  }
}
