/**
 * The `/legal` index (AECI-2237, `STAGE_1_SPEC.md` §27.3): one row per legal document,
 * in the canonical order of `LEGAL_SLUGS`. Each row links `/legal/<slug>` and shows the
 * version in force and its effective date, or "Draft" while the date is blank. Nothing
 * else: the notice band of AECI-1870 links here so it need not list six documents.
 *
 * The version in force is decided the way each document page decides it: the
 * `legalSwitched` route data (`resolveLegalSwitchedAll`, every slug's answer) through
 * `resolveLegalView`. So a version that switched by itself at its effective moment
 * (AECI-1689) shows here as it does on its own page.
 *
 * Static, indexable, cacheable: `/legal` is on the `/legal/*` cache rules (24h edge /
 * 1h browser, `Cache-Tag: route:index`, the effective-moment TTL cap). No visitor state.
 * The hero and the page wrap are the document page's. Light theme only.
 */
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { BAND_WRAP_CLASS } from '../shared/band-wrap';
import { BoneBand } from '../shared/bone-band/bone-band';
import { resolveLegalView } from './legal-in-force-state';
import { LEGAL_DOC_LOOKUP } from './legal-page';
import { LEGAL_SLUGS, type LegalSlug } from './legal-slugs';
import { LEGAL_UPCOMING_ENTRIES } from './legal-upcoming-token';

/** One row of the index. */
interface LegalIndexRow {
  readonly slug: LegalSlug;
  readonly path: string;
  readonly title: string;
  readonly version: string;
  /** The display label ("March 31, 2027"); empty while the document is a draft. */
  readonly effectiveDate: string;
}

@Component({
  selector: 'app-legal-index',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BoneBand, RouterLink],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <aec-bone-band>
        <div class="max-w-[42rem]">
          <h1 class="text-(--text-primary)" i18n="@@app.legalIndex.title">Legal</h1>
          <p class="mt-4 text-t-16 text-(--text-secondary)" i18n="@@app.legalIndex.intro">
            The terms, policies and agreements that apply to AEC Integrations.
          </p>
        </div>
      </aec-bone-band>

      <div class="py-16 md:py-24">
        <div [class]="wrap">
          <ul class="max-w-[42rem] divide-y divide-(--border-default)" data-testid="legal-index">
            @for (row of rows; track row.slug) {
              <li class="py-4 first:pt-0" data-testid="legal-index-row">
                <a [class]="link" [routerLink]="row.path">{{ row.title }}</a>
                <p class="mt-1 text-t-14 text-(--text-secondary)">
                  <span i18n="@@app.legalIndex.version">Version {{ row.version }}</span>
                  <span aria-hidden="true"> · </span>
                  @if (row.effectiveDate) {
                    <span i18n="@@app.legalIndex.effectiveDate"
                      >Effective {{ row.effectiveDate }}</span
                    >
                  } @else {
                    <span i18n="@@app.legalIndex.draft">Draft</span>
                  }
                </p>
              </li>
            }
          </ul>
        </div>
      </div>
    </div>
  `,
})
export class LegalIndexPage {
  private readonly route = inject(ActivatedRoute);
  private readonly meta = inject(MetaService);
  private readonly lookup = inject(LEGAL_DOC_LOOKUP);
  private readonly upcoming = inject(LEGAL_UPCOMING_ENTRIES);

  protected readonly wrap = BAND_WRAP_CLASS;
  /** The in-text link recipe (DESIGN.md "The Link Treatment Rule"), at the row's size. */
  protected readonly link =
    'text-t-16 font-medium text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover)';

  protected readonly rows: readonly LegalIndexRow[];

  constructor() {
    // Absent (no resolver ran) is the pre-moment state, as on the document page.
    const switched = (this.route.snapshot.data['legalSwitched'] ?? {}) as Partial<
      Record<LegalSlug, boolean>
    >;
    this.rows = LEGAL_SLUGS.map((slug) => {
      const view = resolveLegalView(
        slug,
        undefined,
        this.lookup,
        this.upcoming,
        switched[slug] === true,
      );
      if (!view) throw new Error(`No legal document for slug "${slug}"`);
      const { title, version, effectiveDate } = view.doc.frontmatter;
      return { slug, path: view.currentPath, title, version, effectiveDate };
    });

    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.legalIndexTitle:Legal · AEC Integrations`,
      description: $localize`:@@meta.legalIndexDescription:Every legal document of AEC Integrations, with the version that applies and its effective date.`,
      canonical: canonicalUrl('/legal'),
    });
  }
}
