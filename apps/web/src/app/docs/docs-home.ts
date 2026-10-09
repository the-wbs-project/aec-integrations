/**
 * Docs home (`/docs`, AECI-1248, AECI-1259; `docs/STAGE_2_PRODUCT_DOCS_SPEC.md`
 * §3, §5). Renders inside `DocsShellComponent`, which owns the sidebar and the
 * top bar.
 *
 * Anchor site: **Devin (DeepWiki)**, Mobbin screen c3936cdb: the same quiet
 * column as an article. A small Source Serif `h1` "Help center" and a one-line
 * intro, then two plain divided lists, no cards. First the **audience split**,
 * which sends a reader, a vendor or a reviewer to the sections written for them.
 * Then "All sections", each with its summary and page links. Built entirely from
 * the manifest (`docs-content.ts`), so an empty section shows nowhere and an
 * audience with no non-empty section drops out of the split.
 *
 * Static, SSR-safe, edge-cached on the static-page TTL, and indexable (`/docs`
 * is in `sitemap.xml`). Light theme only.
 */
import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { type DocsAudience, type DocsSection, DOCS_SECTIONS } from './docs-content';
import { pathForcesNoindex } from './docs-indexing';

interface AudienceGroup {
  readonly audience: DocsAudience;
  readonly heading: string;
  readonly summary: string;
  readonly sections: readonly DocsSection[];
}

const AUDIENCES: readonly Omit<AudienceGroup, 'sections'>[] = [
  {
    audience: 'reader',
    heading: $localize`:@@app.docs.home.audience.reader:Choosing integrations`,
    summary: $localize`:@@app.docs.home.audience.reader.summary:For firms reading the directory: how listings work and how ranking is decided.`,
  },
  {
    audience: 'vendor',
    heading: $localize`:@@app.docs.home.audience.vendor:Listing your products`,
    summary: $localize`:@@app.docs.home.audience.vendor.summary:For vendors: claim your listing and keep your integrations accurate.`,
  },
  {
    audience: 'reviewer',
    heading: $localize`:@@app.docs.home.audience.reviewer:Reviewing and requesting`,
    summary: $localize`:@@app.docs.home.audience.reviewer.summary:For practitioners: write a review, request an integration, or correct a listing.`,
  },
];

@Component({
  selector: 'app-docs-home',
  imports: [RouterLink],
  template: `
    <div class="px-4 pt-8 pb-14 md:px-6 lg:px-8 lg:pt-10">
      <div class="mx-auto max-w-[42rem]">
        <header>
          <h1 class="aec-docs-title text-(--text-primary)" i18n="@@app.docs.home.heading">
            Help center
          </h1>
          <p class="mt-2 leading-relaxed text-(--text-secondary)" i18n="@@app.docs.home.intro">
            How AEC Integrations works, and how to get things done on it. Pick the guide written for
            you, or browse every section below.
          </p>
        </header>

        <section class="mt-8" aria-labelledby="docs-audience-heading">
          <h2 id="docs-audience-heading" class="sr-only" i18n="@@app.docs.home.audience.heading">
            Guides by role
          </h2>
          <ul class="divide-y divide-(--border-default) border-y border-(--border-default)">
            @for (group of audiences; track group.audience) {
              <li class="py-4" [attr.data-audience]="group.audience">
                <h3 class="aec-docs-subhead text-(--text-primary)">{{ group.heading }}</h3>
                <p class="mt-1 max-w-[36rem] text-sm leading-relaxed text-(--text-secondary)">
                  {{ group.summary }}
                </p>
                <ul class="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
                  @for (section of group.sections; track section.id) {
                    <li>
                      <a
                        [routerLink]="section.path"
                        class="rounded-sm font-medium text-(--accent-primary) underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                        >{{ section.label }}</a
                      >
                    </li>
                  }
                </ul>
              </li>
            }
          </ul>
        </section>

        <section class="mt-10" aria-labelledby="docs-sections-heading">
          <h2
            id="docs-sections-heading"
            class="aec-overline text-(--text-secondary)"
            i18n="@@app.docs.home.sections.heading"
          >
            All sections
          </h2>
          <div class="mt-3 divide-y divide-(--border-default) border-t border-(--border-default)">
            @for (section of sections; track section.id) {
              <div class="py-5" [attr.data-section]="section.id">
                <h3 class="aec-docs-subhead">
                  <a
                    [routerLink]="section.path"
                    class="rounded-sm text-(--text-primary) underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                    >{{ section.label }}</a
                  >
                </h3>
                <p class="mt-1 max-w-[36rem] text-sm leading-relaxed text-(--text-secondary)">
                  {{ section.summary }}
                </p>
                @if (!section.singlePage) {
                  <ul class="mt-2.5 space-y-1.5 text-sm">
                    @for (page of section.pages; track page.slug) {
                      <li>
                        <a
                          [routerLink]="page.path"
                          class="rounded-sm text-(--accent-primary) underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                          >{{ page.title }}</a
                        >
                      </li>
                    }
                  </ul>
                }
              </div>
            }
          </div>
        </section>
      </div>
    </div>
  `,
})
export class DocsHomeComponent {
  private readonly meta = inject(MetaService);

  protected readonly sections = DOCS_SECTIONS;
  /** The audience split, minus any audience with no non-empty section. */
  protected readonly audiences: readonly AudienceGroup[] = AUDIENCES.map((group) => ({
    ...group,
    sections: DOCS_SECTIONS.filter((section) => section.audience === group.audience),
  })).filter((group) => group.sections.length > 0);

  constructor() {
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.docsHomeTitle:Help center · AEC Integrations`,
      description: $localize`:@@meta.docsHomeDescription:Guides to AEC Integrations for readers, vendors and reviewers: how the directory works, how to claim a listing, and how to request a correction.`,
      canonical: canonicalUrl('/docs'),
      noindex: pathForcesNoindex('/docs'),
    });
  }
}
