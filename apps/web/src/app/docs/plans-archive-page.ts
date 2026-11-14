/**
 * A recorded version of the Plans page (`/docs/vendors/plans/v<version>`,
 * AECI-1619, counsel ruling 16). A checkout or grant acceptance points here
 * through its stored `plans_page_version`, so the vendor and an operator can
 * read the page as it stood when the acceptance was given. Every known version
 * has a route, the current one included.
 *
 * It follows the legal archive pattern (`legal/legal-page.ts`, AECI-1361): a
 * notice names the version and its recorded date and links the live page, the
 * robots meta is `noindex`, and the canonical points at `/docs/vendors/plans`.
 * The SSR egress also stamps `X-Robots-Tag` on it (`NOINDEX_PATH_PREFIXES`), and
 * it is not in the docs manifest, so the sitemap and the docs search never list it.
 *
 * It renders inside `DocsShellComponent` like an article, with the vendor-guide
 * sidebar (`locate` maps a path below a page to that page's guide). The body is
 * the snapshot Markdown, rendered by `renderDocsBody` with bound heading ids, the
 * same template shape as `docs-page.ts` minus the widgets: the snapshot prints
 * the cards and the table as Markdown. No buttons, no claim dialog.
 *
 * Static + edge-cache / SSR-safe: bundled Markdown, no fetch, no visitor state.
 * Same `/docs` cache rules (`route:index`). The body is content and is not
 * `$localize`-extracted; the chrome is. Light only.
 */
import { Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { type PlansSnapshot, getPlansSnapshot } from './plans-archive-content';
import { PLANS_PAGE_PATH } from './plans-versions';

@Component({
  selector: 'app-plans-archive-page',
  imports: [RouterLink],
  template: `
    <div class="px-4 pt-8 pb-14 md:px-6 lg:px-8 lg:pt-10">
      <article class="mx-auto w-full max-w-[42rem] min-w-0">
        <header>
          <h1 class="aec-docs-title text-(--text-primary)">{{ snapshot.title }}</h1>
          <p
            class="mt-4 rounded-md border border-(--border-default) bg-(--surface-base) px-4 py-3 text-sm text-(--text-primary)"
            data-testid="plans-archive-notice"
            i18n="@@app.docs.plans.archive.notice"
          >
            This is the Plans page as recorded at version {{ snapshot.version }} on
            {{ snapshot.recordedOn }}.
            <a
              class="rounded-sm font-semibold text-(--accent-primary) underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              [routerLink]="currentPath"
              >Read the current page.</a
            >
          </p>
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
export class PlansArchivePageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly meta = inject(MetaService);

  protected readonly snapshot: PlansSnapshot;
  /** The live page: the canonical, and the notice's link. */
  protected readonly currentPath = PLANS_PAGE_PATH;

  constructor() {
    const version = this.route.snapshot.data['version'] as string;
    const snapshot = getPlansSnapshot(version);
    if (!snapshot) {
      // Programming error: the routes are generated from PLANS_PAGE_KNOWN_VERSIONS,
      // and the registry throws at init when one has no file.
      throw new Error(`No Plans snapshot for version "${version}"`);
    }
    this.snapshot = snapshot;
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.docsPlansArchiveTitle:Plans, version ${snapshot.version}:VERSION: · AEC Integrations`,
      description: $localize`:@@meta.docsPlansArchiveDescription:The AEC Integrations Plans page as recorded at version ${snapshot.version}:VERSION: on ${snapshot.recordedOn}:DATE:.`,
      canonical: canonicalUrl(PLANS_PAGE_PATH),
      noindex: true,
    });
  }
}
