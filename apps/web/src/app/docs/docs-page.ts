/**
 * Docs article page (`/docs/<section>/<slug>`, AECI-1104;
 * `docs/STAGE_2_PRODUCT_DOCS_SPEC.md` §3). One component renders every page in
 * the docs manifest (`docs-content.ts`); the route's `data` selects which.
 *
 * Anchor site: **Zendesk** (the Copenhagen help-center article page). Its
 * shape is a breadcrumb, an "articles in this section" rail beside the article,
 * and the article itself. The rail is the section's table of contents, so a
 * vendor can move between tasks without a docs home page.
 *
 * **Static + edge-cache / SSR-safe.** No data fetch and no per-visitor state:
 * the Markdown is bundled at build time and parsed once per isolate, so the HTML
 * is identical on the SSR Worker and after hydration. `/docs/*` carries
 * `Cache-Tag: route:index` on the static-page TTL (`ROUTE_CACHE_PATTERNS` +
 * `cacheTagInputsForPath`).
 *
 * **Noindex for now.** The vendor guide describes a portal that is still a dark
 * launch, so the page emits `robots: noindex` and the egress middleware stamps
 * `X-Robots-Tag` on `/docs/vendors/*` in every env (`pathForcesNoindex`).
 * TODO(AECI-1105): drop `noindex: true` here when the portal opens.
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
import { type DocsPage, type DocsSectionId, docsSection, getDocsPage } from './docs-content';

/** Per-section chrome. One section today; the switch keeps the next one honest. */
function sectionLabel(section: DocsSectionId): string {
  switch (section) {
    case 'vendors':
      return $localize`:@@app.docs.section.vendors:Vendor guide`;
  }
}

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
            <li i18n="@@app.docs.breadcrumbs.docs">Docs</li>
            <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
            <li class="text-(--text-primary)">{{ sectionName }}</li>
          </ol>
        </nav>

        <div class="mt-8 grid gap-12 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-16">
          <article class="min-w-0 lg:col-start-2 lg:row-start-1">
            <header class="max-w-[62ch] border-b border-(--border-default) pb-8">
              <p class="aec-overline text-(--accent-primary)">{{ sectionName }}</p>
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
          </article>

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
        </div>
      </div>
    </div>
  `,
})
export class DocsPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly meta = inject(MetaService);

  protected readonly page: DocsPage;
  protected readonly sectionPages: readonly DocsPage[];
  protected readonly sectionName: string;

  constructor() {
    const { section, slug } = this.route.snapshot.data as { section: string; slug: string };
    const page = getDocsPage(section, slug);
    if (!page) {
      // Programming error: routes are generated from the same manifest.
      throw new Error(`No docs page for /docs/${section}/${slug}`);
    }
    this.page = page;
    this.sectionPages = docsSection(page.section);
    this.sectionName = sectionLabel(page.section);

    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.docsPageTitle:${page.title}:title: · AEC Integrations`,
      description: page.description,
      canonical: canonicalUrl(page.path),
      // TODO(AECI-1105): remove when the vendor portal opens.
      noindex: true,
    });
  }
}
