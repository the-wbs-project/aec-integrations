/**
 * A recorded version of a versioned docs page (`/docs/<section>/<slug>/v<version>`,
 * AECI-1619, AECI-1621). One route per known version in `DOCS_PAGE_VERSIONS`,
 * the current one included. Today two pages have versions:
 *
 *   - Plans (`/docs/vendors/plans/v<version>`, counsel ruling 16). A checkout or
 *     grant acceptance points here through its stored `plans_page_version`, so
 *     the vendor and an operator can read the page as it stood when the
 *     acceptance was given.
 *   - How ranking works (`/docs/trust/how-ranking-works/v<version>`, counsel Q23).
 *     The Terms of Service and the Vendor Terms link the live page, so each
 *     version they could have pointed at stays readable.
 *
 * It follows the legal archive pattern (`legal/legal-page.ts`, AECI-1361): a
 * notice names the version and its recorded date and links the live page, the
 * robots meta is `noindex`, and the canonical points at the live page. The SSR
 * egress also stamps `X-Robots-Tag` on it (`NOINDEX_PATH_PREFIXES`), and it is
 * not in the docs manifest, so the sitemap and the docs search never list it.
 * The Plans notice keeps its AECI-1619 wording. Every other page shares one.
 *
 * It renders inside `DocsShellComponent` like an article, in the live page's
 * guide (`locate` maps a path below a page to that page's guide). The body is
 * the version file's Markdown, rendered by `renderDocsBody` with bound heading
 * ids, the same template shape as `docs-page.ts` minus the widgets. No buttons,
 * no claim dialog.
 *
 * Static + edge-cache / SSR-safe: bundled Markdown, no fetch, no visitor state.
 * Same `/docs` cache rules (`route:index`). The body is content and is not
 * `$localize`-extracted; the chrome is. Light only.
 */
import { Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { type DocsSnapshot, getDocsSnapshot } from './docs-archive-content';
import { docsVersionedPagePath } from './docs-page-versions';

/** The Plans key, whose notice and meta keep their AECI-1619 wording. */
const PLANS_PAGE = 'vendors/plans';

@Component({
  selector: 'app-docs-archive-page',
  imports: [RouterLink],
  template: `
    <div class="px-4 pt-8 pb-14 md:px-6 lg:px-8 lg:pt-10">
      <article class="mx-auto w-full max-w-[42rem] min-w-0">
        <header>
          <h1 class="aec-docs-title text-(--text-primary)">{{ snapshot.title }}</h1>
          @if (isPlans) {
            <p
              class="mt-4 rounded-md border border-(--border-default) bg-(--surface-base) px-4 py-3 text-sm text-(--text-primary)"
              data-testid="plans-archive-notice"
              i18n="@@app.docs.plans.archive.notice"
            >
              This is the Plans page as recorded at version {{ snapshot.version }} on
              {{ snapshot.recordedOn }}.
              <a
                class="rounded-sm text-(--accent-primary) underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                [routerLink]="currentPath"
                >Read the current page.</a
              >
            </p>
          } @else {
            <p
              class="mt-4 rounded-md border border-(--border-default) bg-(--surface-base) px-4 py-3 text-sm text-(--text-primary)"
              data-testid="docs-archive-notice"
              i18n="@@app.docs.archive.notice"
            >
              This is version {{ snapshot.version }}, recorded on {{ snapshot.recordedOn }}.
              <a
                class="rounded-sm text-(--accent-primary) underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                [routerLink]="currentPath"
                >Read the current version.</a
              >
            </p>
          }
        </header>
        <div class="aec-prose aec-docs-prose mt-6">
          @for (block of snapshot.blocks; track $index) {
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
    </div>
  `,
})
export class DocsArchivePageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly meta = inject(MetaService);

  protected readonly snapshot: DocsSnapshot;
  protected readonly isPlans: boolean;
  /** The live page: the canonical, and the notice's link. */
  protected readonly currentPath: string;

  constructor() {
    const page = this.route.snapshot.data['page'] as string;
    const version = this.route.snapshot.data['version'] as string;
    const snapshot = getDocsSnapshot(page, version);
    if (!snapshot) {
      // Programming error: the routes are generated from DOCS_PAGE_VERSIONS,
      // and the archive content throws at init when a version has no file.
      throw new Error(`No recorded version "${version}" of docs page "${page}"`);
    }
    this.snapshot = snapshot;
    this.isPlans = page === PLANS_PAGE;
    this.currentPath = docsVersionedPagePath(page);
    const canonical = canonicalUrl(this.currentPath);
    this.meta.setStaticPageMeta(
      this.isPlans
        ? {
            title: $localize`:@@meta.docsPlansArchiveTitle:Plans, version ${snapshot.version}:VERSION: · AEC Integrations`,
            description: $localize`:@@meta.docsPlansArchiveDescription:The AEC Integrations Plans page as recorded at version ${snapshot.version}:VERSION: on ${snapshot.recordedOn}:DATE:.`,
            canonical,
            noindex: true,
          }
        : {
            title: $localize`:@@meta.docsArchiveTitle:${snapshot.title}:TITLE:, version ${snapshot.version}:VERSION: · AEC Integrations`,
            description: $localize`:@@meta.docsArchiveDescription:${snapshot.title}:TITLE: on AEC Integrations, version ${snapshot.version}:VERSION:, recorded on ${snapshot.recordedOn}:DATE:.`,
            canonical,
            noindex: true,
          },
    );
  }
}
