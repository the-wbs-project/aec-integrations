/**
 * Docs article page (`/docs/<section>/<slug>`, AECI-1104, AECI-1248;
 * `docs/STAGE_2_PRODUCT_DOCS_SPEC.md` §3). One component renders every page in
 * the docs manifest (`docs-content.ts`); the route's `data` selects which.
 *
 * Anchor site: **Zendesk** (the Copenhagen help-center article page). Its
 * shape is a breadcrumb, an "articles in this section" rail beside the article,
 * the article itself, and a previous / next pager at the article foot. The
 * breadcrumb links up to the docs home (`/docs`) and the section index
 * (`/docs/<section>`). A single-page section (`faq`) has no index, so its page
 * shows no section crumb and no rail.
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
 * **Reading order.** The article comes first in the DOM, so a small screen and a
 * screen reader reach the content before the rail. From `lg` the grid places the
 * rail in the left column. Light theme only.
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import {
  type DocsPage,
  type DocsSection,
  docsNeighbours,
  getDocsPage,
  getDocsSection,
} from './docs-content';
import { pathForcesNoindex } from './docs-indexing';

@Component({
  selector: 'app-docs-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <div class="mx-auto max-w-7xl px-6 py-10 md:px-8 md:py-14">
        <nav i18n-aria-label="@@app.docs.breadcrumbs.aria" aria-label="Breadcrumb">
          <ol class="flex flex-wrap items-center gap-2 text-sm text-(--text-secondary)">
            <li>
              <a
                routerLink="/"
                class="rounded-sm transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                i18n="@@app.docs.breadcrumbs.home"
                >Home</a
              >
            </li>
            <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
            <li>
              <a
                routerLink="/docs"
                class="rounded-sm transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                i18n="@@app.docs.breadcrumbs.docs"
                >Docs</a
              >
            </li>
            @if (!section.singlePage) {
              <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
              <li>
                <a
                  [routerLink]="section.path"
                  class="rounded-sm transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  >{{ section.label }}</a
                >
              </li>
            }
          </ol>
        </nav>

        <div class="mt-8 grid gap-12 lg:gap-16" [class]="layout.grid">
          <article class="min-w-0" [class]="layout.article">
            <header class="max-w-[62ch] border-b border-(--border-default) pb-8">
              <p class="aec-overline text-(--accent-primary)">{{ section.label }}</p>
              <h1
                class="mt-3 font-display text-4xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-5xl"
              >
                {{ page.title }}
              </h1>
              <p class="mt-4 text-lg leading-relaxed text-(--text-secondary)">
                {{ page.description }}
              </p>
              <!-- Pre-formatted in the frontmatter and rendered verbatim: SSR runs
                   UTC and the browser does not, so reformatting would mismatch. -->
              <p class="mt-4 text-sm text-(--text-secondary)" i18n="@@app.docs.lastUpdated">
                Last updated {{ page.lastUpdated }}
              </p>
            </header>
            <!-- Rendered Markdown, sanitized by Angular. Styled by .aec-prose. -->
            <div class="aec-prose mt-8 max-w-[62ch]" [innerHTML]="page.html"></div>

            @if (neighbours.prev || neighbours.next) {
              <nav
                class="mt-12 grid max-w-[62ch] gap-4 border-t border-(--border-default) pt-8 sm:grid-cols-2"
                i18n-aria-label="@@app.docs.pager.aria"
                aria-label="Previous and next articles"
              >
                @if (neighbours.prev; as prev) {
                  <a
                    [routerLink]="prev.path"
                    rel="prev"
                    class="rounded-md border border-(--border-default) px-4 py-3 transition-colors hover:bg-(--surface-muted) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  >
                    <span
                      class="block text-sm text-(--text-secondary)"
                      i18n="@@app.docs.pager.previous"
                      >Previous</span
                    >
                    <span class="mt-1 block font-semibold text-(--text-primary)">{{
                      prev.title
                    }}</span>
                  </a>
                }
                @if (neighbours.next; as next) {
                  <a
                    [routerLink]="next.path"
                    rel="next"
                    class="rounded-md border border-(--border-default) px-4 py-3 transition-colors hover:bg-(--surface-muted) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) sm:col-start-2 sm:text-end"
                  >
                    <span class="block text-sm text-(--text-secondary)" i18n="@@app.docs.pager.next"
                      >Next</span
                    >
                    <span class="mt-1 block font-semibold text-(--text-primary)">{{
                      next.title
                    }}</span>
                  </a>
                }
              </nav>
            }
          </article>

          @if (!section.singlePage) {
            <nav
              class="border-t border-(--border-default) pt-8 lg:sticky lg:top-8 lg:col-start-1 lg:row-start-1 lg:self-start lg:border-t-0 lg:pt-0"
              aria-labelledby="docs-section-nav-heading"
            >
              <h2
                id="docs-section-nav-heading"
                class="aec-overline text-(--text-secondary)"
                i18n="@@app.docs.sectionNav.heading"
              >
                In this guide
              </h2>
              <ol class="mt-3 space-y-1">
                @for (entry of sectionPages; track entry.slug) {
                  <li>
                    <a
                      [routerLink]="entry.path"
                      [attr.aria-current]="entry.slug === page.slug ? 'page' : null"
                      class="aec-docs-nav-link block rounded-md border-s-2 px-3 py-2 text-sm leading-snug text-(--text-secondary) transition-colors hover:bg-(--surface-muted) hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) aria-[current=page]:bg-(--surface-muted) aria-[current=page]:font-semibold aria-[current=page]:text-(--text-primary)"
                      >{{ entry.title }}</a
                    >
                  </li>
                }
              </ol>
            </nav>
          }
        </div>
      </div>
    </div>
  `,
})
export class DocsPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly meta = inject(MetaService);

  protected readonly page: DocsPage;
  protected readonly section: DocsSection;
  protected readonly sectionPages: readonly DocsPage[];
  protected readonly neighbours: { readonly prev?: DocsPage; readonly next?: DocsPage };
  /** Two columns with the section rail; one column for a single-page section. */
  protected readonly layout: { readonly grid: string; readonly article: string };

  constructor() {
    const { section, slug } = this.route.snapshot.data as { section: string; slug: string };
    const page = getDocsPage(section, slug);
    if (!page) {
      // Programming error: routes are generated from the same manifest.
      throw new Error(`No docs page for /docs/${section}/${slug}`);
    }
    this.page = page;
    // Non-null: a page's section has at least this page, so it is never hidden.
    this.section = getDocsSection(page.section)!;
    this.sectionPages = this.section.pages;
    this.neighbours = docsNeighbours(page);
    this.layout = this.section.singlePage
      ? { grid: '', article: '' }
      : { grid: 'lg:grid-cols-[15rem_minmax(0,1fr)]', article: 'lg:col-start-2 lg:row-start-1' };

    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.docsPageTitle:${page.title}:title: · AEC Integrations`,
      description: page.description,
      canonical: canonicalUrl(page.path),
      // TODO(AECI-1253): the vendor guide stays noindex until it is published.
      noindex: pathForcesNoindex(page.path),
    });
  }
}
