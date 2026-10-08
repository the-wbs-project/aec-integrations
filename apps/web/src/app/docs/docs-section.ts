/**
 * Docs section index (`/docs/<section>`, AECI-1248;
 * `docs/STAGE_2_PRODUCT_DOCS_SPEC.md` §3, §5). One component renders every
 * non-empty, multi-page section in the manifest; the route's `data` selects
 * which. A section with no pages has no route, and a single-page section
 * (`faq`) is served by the article page instead.
 *
 * Anchor site: **Zendesk** (the Copenhagen help-center section page): a
 * breadcrumb, the section title and summary, then the list of articles with
 * their one-line descriptions. Same breadcrumb, overline, Source Serif `h1` and
 * 62ch measure as the article page (`docs-page.ts`), so home → section →
 * article reads as one surface.
 *
 * Static, SSR-safe and edge-cached like the article page. Noindex by path
 * (`pathForcesNoindex`), so `/docs/vendors` stays out with the vendor guide.
 * Light theme only.
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { type DocsSection, getDocsSection } from './docs-content';
import { pathForcesNoindex } from './docs-indexing';

@Component({
  selector: 'app-docs-section',
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
          </ol>
        </nav>

        <header class="mt-8 max-w-[62ch] border-b border-(--border-default) pb-8">
          <p class="aec-overline text-(--accent-primary)" i18n="@@app.docs.section.overline">
            Help center
          </p>
          <h1
            class="mt-3 font-display text-4xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-5xl"
          >
            {{ section.label }}
          </h1>
          <p class="mt-4 text-lg leading-relaxed text-(--text-secondary)">
            {{ section.summary }}
          </p>
        </header>

        <ol class="mt-4 max-w-[62ch] divide-y divide-(--border-default)">
          @for (page of section.pages; track page.slug) {
            <li class="py-5">
              <h2 class="text-lg font-semibold leading-snug">
                <a
                  [routerLink]="page.path"
                  class="rounded-sm text-(--accent-primary) underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  >{{ page.title }}</a
                >
              </h2>
              <p class="mt-1 text-(--text-secondary)">{{ page.description }}</p>
            </li>
          }
        </ol>
      </div>
    </div>
  `,
})
export class DocsSectionComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly meta = inject(MetaService);

  protected readonly section: DocsSection;

  constructor() {
    const { section: id } = this.route.snapshot.data as { section: string };
    const section = getDocsSection(id);
    if (!section) {
      // Programming error: routes are generated from the same manifest.
      throw new Error(`No docs section for /docs/${id}`);
    }
    this.section = section;

    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.docsSectionTitle:${section.label}:section: · AEC Integrations`,
      description: section.summary,
      canonical: canonicalUrl(section.path),
      noindex: pathForcesNoindex(section.path),
    });
  }
}
