/**
 * Docs home (`/docs`, AECI-1248; `docs/STAGE_2_PRODUCT_DOCS_SPEC.md` §3, §5).
 *
 * Anchor site: **Zendesk** (the Copenhagen help-center home): a title and a
 * short intro, an audience split, then every section with its articles. The
 * audience split sends a reader, a vendor or a reviewer to the sections written
 * for them. Built entirely from the manifest (`docs-content.ts`), so an empty
 * section shows nowhere and an audience with no non-empty section drops out of
 * the split.
 *
 * Same breadcrumb, overline, Source Serif `h1` and token vocabulary as the
 * article page (`docs-page.ts`). Static, SSR-safe, edge-cached on the
 * static-page TTL, and indexable (`/docs` is in `sitemap.xml`). Light theme only.
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
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
          </ol>
        </nav>

        <header class="mt-8 max-w-[62ch]">
          <p class="aec-overline text-(--accent-primary)" i18n="@@app.docs.home.overline">Docs</p>
          <h1
            class="mt-3 font-display text-4xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-5xl"
            i18n="@@app.docs.home.heading"
          >
            Help center
          </h1>
          <p
            class="mt-4 text-lg leading-relaxed text-(--text-secondary)"
            i18n="@@app.docs.home.intro"
          >
            How AEC Integrations works, and how to get things done on it. Pick the guide written for
            you, or browse every section below.
          </p>
        </header>

        <section class="mt-10" aria-labelledby="docs-audience-heading">
          <h2 id="docs-audience-heading" class="sr-only" i18n="@@app.docs.home.audience.heading">
            Guides by role
          </h2>
          <ul class="grid gap-4 md:grid-cols-3">
            @for (group of audiences; track group.audience) {
              <li
                class="rounded-lg border border-(--border-default) bg-(--surface-raised) p-6"
                [attr.data-audience]="group.audience"
              >
                <h3 class="font-display text-2xl font-normal leading-tight">{{ group.heading }}</h3>
                <p class="mt-2 text-(--text-secondary)">{{ group.summary }}</p>
                <ul class="mt-4 space-y-2">
                  @for (section of group.sections; track section.id) {
                    <li>
                      <a
                        [routerLink]="section.path"
                        class="rounded-sm font-semibold text-(--accent-primary) underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                        >{{ section.label }}</a
                      >
                    </li>
                  }
                </ul>
              </li>
            }
          </ul>
        </section>

        <section class="mt-14" aria-labelledby="docs-sections-heading">
          <h2
            id="docs-sections-heading"
            class="aec-overline text-(--text-secondary)"
            i18n="@@app.docs.home.sections.heading"
          >
            All sections
          </h2>
          <div class="mt-6 grid gap-x-12 gap-y-10 md:grid-cols-2">
            @for (section of sections; track section.id) {
              <div class="border-t border-(--border-default) pt-6" [attr.data-section]="section.id">
                <h3 class="text-xl font-semibold leading-snug">
                  <a
                    [routerLink]="section.path"
                    class="rounded-sm text-(--text-primary) underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                    >{{ section.label }}</a
                  >
                </h3>
                <p class="mt-2 text-(--text-secondary)">{{ section.summary }}</p>
                @if (!section.singlePage) {
                  <ul class="mt-4 space-y-2">
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
