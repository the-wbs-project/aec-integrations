/**
 * Docs section index (`/docs/<section>`, AECI-1248, AECI-1259;
 * `docs/STAGE_2_PRODUCT_DOCS_SPEC.md` §3, §5). One component renders every
 * non-empty, multi-page section in the manifest; the route's `data` selects
 * which. A section with no pages has no route, and a single-page section
 * (`faq`) is served by the article page instead. Renders inside
 * `DocsShellComponent`, which owns the sidebar and the top bar.
 *
 * Anchor site: **Devin (DeepWiki)**, Mobbin screen c3936cdb: the same quiet
 * column as an article. A small Source Serif `h1` (the section label), its
 * one-line summary, then a plain divided list of the section's pages, each a
 * linked title with its one-line description.
 *
 * **Landing copy (AECI-1265).** A section may declare an intro in the manifest.
 * The vendor guide does: `/docs/vendors` is its landing page. The intro's lead
 * renders above the page list, and its headed parts (the "Current limits" note)
 * below it. Headings render from the template with bound ids, as on an article,
 * because the `[innerHTML]` sanitizer strips `id`.
 *
 * Static, SSR-safe and edge-cached like the article page. Indexability is by
 * path (`pathForcesNoindex`). Since AECI-1253 that list holds no docs path, so
 * `/docs/vendors` is indexable with the rest of the vendor guide.
 * Light theme only.
 */
import { Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { type DocsBlock, type DocsSection, getDocsSection } from './docs-content';
import { pathForcesNoindex } from './docs-indexing';

@Component({
  selector: 'app-docs-section',
  imports: [RouterLink],
  template: `
    <!-- AECI-987: the index takes the docs content column. The header and the
         intro prose keep the 42rem measure. From lg the page list runs two columns. -->
    <div class="px-4 pt-8 pb-14 md:px-6 lg:px-8 lg:pt-10" data-testid="page-canvas">
      <div class="mx-auto max-w-6xl">
        <header class="max-w-[42rem]">
          <h1 class="aec-docs-title text-(--text-primary)">{{ section.label }}</h1>
          <p class="mt-2 leading-relaxed text-(--text-secondary)">{{ section.summary }}</p>
        </header>

        @if (lead.length > 0) {
          <div class="aec-prose aec-docs-prose mt-6 max-w-[42rem]" data-intro="lead">
            @for (block of lead; track $index) {
              <div class="contents" [innerHTML]="block.html"></div>
            }
          </div>
        }

        <ol
          class="mt-6 grid border-t border-(--border-default) lg:grid-cols-2 lg:gap-x-12"
          data-testid="docs-section-pages"
        >
          @for (page of section.pages; track page.slug) {
            <li class="border-b border-(--border-default) py-4">
              <h2 class="aec-docs-subhead">
                <a
                  [routerLink]="page.path"
                  class="rounded-sm text-(--accent-primary) underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  >{{ page.title }}</a
                >
              </h2>
              <p class="mt-1 max-w-[36rem] text-sm leading-relaxed text-(--text-secondary)">
                {{ page.description }}
              </p>
            </li>
          }
        </ol>

        @if (rest.length > 0) {
          <div class="aec-prose aec-docs-prose mt-10 max-w-[42rem]" data-intro="rest">
            @for (block of rest; track $index) {
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
      </div>
    </div>
  `,
})
export class DocsSectionComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly meta = inject(MetaService);

  protected readonly section: DocsSection;
  /** The intro's lead, above the page list. Empty when the section has none. */
  protected readonly lead: readonly DocsBlock[];
  /** The intro's headed parts, below the page list. */
  protected readonly rest: readonly DocsBlock[];

  constructor() {
    const { section: id } = this.route.snapshot.data as { section: string };
    const section = getDocsSection(id);
    if (!section) {
      // Programming error: routes are generated from the same manifest.
      throw new Error(`No docs section for /docs/${id}`);
    }
    this.section = section;
    this.lead = section.intro?.lead ?? [];
    this.rest = section.intro?.rest ?? [];

    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.docsSectionTitle:${section.label}:section: · AEC Integrations`,
      description: section.summary,
      canonical: canonicalUrl(section.path),
      noindex: pathForcesNoindex(section.path),
    });
  }
}
