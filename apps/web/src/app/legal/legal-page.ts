/**
 * Legal page (`/legal/{terms,privacy,review-guidelines,listing-accuracy,
 * vendor-terms,managed-plan-agreement}`, AECI-237 / Phase 7.2, AECI-1359/1360).
 * One component renders every counsel-tracked document (`STAGE_1_SPEC.md`
 * §13/§27); the route's `data.slug` selects which.
 *
 * **Archived versions (AECI-1361, §27.3).** A route with `data.version` renders
 * that superseded version at `/legal/<slug>/v<version>`. It shows a notice with
 * the superseded date and a link to the current version, sets `robots: noindex`,
 * and points its canonical at the current `/legal/<slug>`. The SSR egress also
 * stamps `X-Robots-Tag` on it (`NOINDEX_PATH_PREFIXES`), and the sitemap leaves
 * it out. Same cache rules as the current page.
 *
 * **Upcoming versions (AECI-1610, §27.3).** A route whose version is in
 * `LEGAL_UPCOMING` renders the text before it takes effect, at the same kind of
 * URL. It opens with "This version takes effect on <date>. Until then the current
 * version applies.", linking the current page, and is held out of the index the
 * same way as an archive: `robots: noindex`, canonical to the current page, the
 * egress `X-Robots-Tag`, and no sitemap entry. It stays on the static `/legal/*`
 * TTL, capped at its effective moment, with no purge.
 *
 * **The effective date switches by itself (AECI-1689, §27.3).** From 12:00 UTC of
 * `effectiveOn`, and for an agreement only once its version was published, the
 * upcoming version is the current one with no deploy: `/legal/<slug>` serves it,
 * its own address gets the address callout, the old version's address serves it as
 * superseded on that date, and the announcement stops. The `legalSwitched` route
 * data (`legal-in-force.resolver.ts`) decides per request on the server and hands
 * the browser the same answer; `resolveLegalView` (`legal-in-force-state.ts`)
 * renders it. The bump-day change is cleanup with the same bytes.
 *
 * **The current version at its own address (AECI-1610, §27.3).** A route whose
 * version is the current one (`LEGAL_CURRENT_VERSIONS`) renders the current text
 * at `/legal/<slug>/v<version>`, the URL a change notice links. It says that this
 * address always shows that version and links `/legal/<slug>`. It never says the
 * version is in force: a draft's own text says whether it is. It is held out of
 * the index like an archive, so the link in a notice keeps serving that version's
 * text after bump day, and serves the archived copy once a later version
 * supersedes it.
 *
 * **The announcement of an upcoming version (AECI-1610, §27.3).** The current
 * page, and the current version at its own address, say "Version X takes effect
 * on <date>. Read version X." for each `LEGAL_UPCOMING` entry of the slug, linking
 * the upcoming page. It is chrome built from the manifest, not Markdown, so
 * announcing a version never edits the current file (for an agreement, its hashed
 * text). It depends on the build alone, so the cached HTML stays visitor-neutral.
 *
 * **Static + edge-cache / SSR-safe.** No per-visitor state, and no data fetch
 * except the resolver's one read for an agreement past its moment —
 * the Markdown is bundled at build time and parsed once per isolate
 * (`legal-content.ts`), so the HTML is identical on the SSR Worker and after
 * hydration. `/legal/*` carries `Cache-Tag: route:index` (24h edge / 1h browser)
 * via `ROUTE_CACHE_PATTERNS` + `cacheTagInputsForPath`. The current pages are
 * indexable, so `setStaticPageMeta` sets title + description + canonical + OG
 * (no `robots`).
 * Meta is set from the constructor (like `About`/`Home`) so it ships in the SSR
 * head AND refreshes on an in-app navigation.
 *
 * The body is rendered via `[innerHTML]` — Angular's sanitizer runs (the content
 * is trusted/in-repo, but we don't bypass it), and the body is *content*, not UI
 * strings, so it is not `$localize`-extracted. Only the chrome (eyebrow, title,
 * metadata labels, meta) is i18n-wrapped. Body prose is styled by the global
 * `.aec-prose` block in `styles.css`. Layout mirrors `/about`: a warm Bone
 * (`accent-warm`) hero band, body measure capped at 70ch. Light theme only.
 */
import { ChangeDetectionStrategy, Component, InjectionToken, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { type LegalDoc, type LegalSlug, getLegalDoc, getLegalVersion } from './legal-content';
import {
  type LegalAnnouncement,
  type LegalDocLookup,
  resolveLegalView,
} from './legal-in-force-state';
import { LEGAL_UPCOMING_ENTRIES } from './legal-upcoming-token';

export type { LegalDocLookup } from './legal-in-force-state';
export { LEGAL_UPCOMING_ENTRIES } from './legal-upcoming-token';

/**
 * The bundled registry by default. The real manifest has no upcoming entry, so
 * `legal-page.component.spec.ts` provides a fixture through this token.
 */
export const LEGAL_DOC_LOOKUP = new InjectionToken<LegalDocLookup>('LEGAL_DOC_LOOKUP', {
  providedIn: 'root',
  factory: () => ({ current: getLegalDoc, version: getLegalVersion }),
});

interface LegalChrome {
  readonly title: string;
  readonly description: string;
}

/** Per-slug `$localize` chrome (page `<title>` + meta description). */
function chromeForSlug(slug: LegalSlug): LegalChrome {
  switch (slug) {
    case 'terms':
      return {
        title: $localize`:@@meta.legalTermsTitle:Terms of Service · AEC Integrations`,
        description: $localize`:@@meta.legalTermsDescription:The terms governing use of AEC Integrations, the independent public-information directory of AEC software integrations.`,
      };
    case 'privacy':
      return {
        title: $localize`:@@meta.legalPrivacyTitle:Privacy Policy · AEC Integrations`,
        description: $localize`:@@meta.legalPrivacyDescription:How AEC Integrations collects, uses, retains, and deletes personal data, written to comply with the GDPR.`,
      };
    case 'review-guidelines':
      return {
        title: $localize`:@@meta.legalReviewGuidelinesTitle:Review Guidelines · AEC Integrations`,
        description: $localize`:@@meta.legalReviewGuidelinesDescription:What makes a valid review on AEC Integrations, what content is prohibited, and how moderation works.`,
      };
    case 'listing-accuracy':
      return {
        title: $localize`:@@meta.legalListingAccuracyTitle:Listing Accuracy Policy · AEC Integrations`,
        description: $localize`:@@meta.legalListingAccuracyDescription:Where AEC Integrations listing data comes from, how to request a correction, and why accurate listings are not removed on vendor request.`,
      };
    case 'vendor-terms':
      return {
        title: $localize`:@@meta.legalVendorTermsTitle:Vendor Terms · AEC Integrations`,
        description: $localize`:@@meta.legalVendorTermsDescription:The terms a vendor accepts when claiming a company on AEC Integrations: who may claim, truthfulness, content, seats, and why plans never affect ranking.`,
      };
    case 'managed-plan-agreement':
      return {
        title: $localize`:@@meta.legalManagedPlanAgreementTitle:Managed Plan Agreement · AEC Integrations`,
        description: $localize`:@@meta.legalManagedPlanAgreementDescription:The agreement for Managed subscriptions on AEC Integrations: prices, annual and monthly billing, renewal notice, refunds, and what happens when Managed ends.`,
      };
  }
}

@Component({
  selector: 'app-legal-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <!-- Hero: warm Bone accent band (the Surfaces-Are-Neutral treatment, not a
           page background), mirroring /about. -->
      <section class="border-b border-(--border-default) bg-(--accent-warm)">
        <div class="mx-auto max-w-7xl px-6 py-16 md:px-8 md:py-20">
          <div class="max-w-[70ch]">
            <p class="aec-overline text-(--accent-primary)" i18n="@@app.legal.eyebrow">Legal</p>
            <h1
              class="mt-3 font-display text-4xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-5xl"
            >
              {{ doc.frontmatter.title }}
            </h1>
            <!-- Frontmatter metadata line (§27.1: version + effective date shown
                 at the top). Labels are i18n-wrapped with the value as an
                 interpolation placeholder; effective date is hidden while blank
                 (an unapproved draft). -->
            <div
              class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-(--text-secondary)"
            >
              <span i18n="@@app.legal.version">Version {{ doc.frontmatter.version }}</span>
              @if (doc.frontmatter.effectiveDate) {
                <span aria-hidden="true">·</span>
                <span i18n="@@app.legal.effectiveDate"
                  >Effective {{ doc.frontmatter.effectiveDate }}</span
                >
              }
              <span aria-hidden="true">·</span>
              <span i18n="@@app.legal.lastUpdated"
                >Last updated {{ doc.frontmatter.lastUpdated }}</span
              >
            </div>
            <!-- AECI-1361: an archived version says so before anything else in
                 the body, and links to the current text. -->
            @if (doc.supersededOn) {
              <p
                class="mt-6 rounded-md border border-(--border-default) bg-(--surface-base) px-4 py-3 text-sm text-(--text-primary)"
                data-testid="legal-superseded"
                i18n="@@app.legal.superseded"
              >
                This is version {{ doc.frontmatter.version }}, superseded on {{ doc.supersededOn }}.
                <a
                  class="font-semibold text-(--accent-primary) underline"
                  [routerLink]="currentPath"
                  >Read the current version.</a
                >
              </p>
            }
            <!-- AECI-1610: a version not yet in force says so first, and links to
                 the text that applies until then. -->
            @if (doc.effectiveOn) {
              <p
                class="mt-6 rounded-md border border-(--border-default) bg-(--surface-base) px-4 py-3 text-sm text-(--text-primary)"
                data-testid="legal-upcoming"
                i18n="@@app.legal.upcoming"
              >
                This version takes effect on {{ doc.frontmatter.effectiveDate }}. Until then
                <a
                  class="font-semibold text-(--accent-primary) underline"
                  [routerLink]="currentPath"
                  >the current version</a
                >
                applies.
              </p>
            }
            <!-- AECI-1610: the current version at its own address names the version
                 it always shows, and links the page that follows the current one.
                 It does not say the version is in force: a draft is not. -->
            @if (fixedCurrent) {
              <p
                class="mt-6 rounded-md border border-(--border-default) bg-(--surface-base) px-4 py-3 text-sm text-(--text-primary)"
                data-testid="legal-fixed-current"
                i18n="@@app.legal.fixedCurrent"
              >
                This address always shows version {{ doc.frontmatter.version }}. For the version
                that currently applies, see
                <a
                  class="font-semibold text-(--accent-primary) underline"
                  [routerLink]="currentPath"
                  >{{ doc.frontmatter.title }}</a
                >.
              </p>
            }
            <!-- AECI-1610: the current text announces each upcoming version from the
                 manifest, so announcing one never edits the current Markdown. -->
            @for (next of announcements; track next.version) {
              <p
                class="mt-6 rounded-md border border-(--border-default) bg-(--surface-base) px-4 py-3 text-sm text-(--text-primary)"
                data-testid="legal-upcoming-announcement"
                i18n="@@app.legal.upcomingAnnouncement"
              >
                Version {{ next.version }} takes effect on {{ next.effectiveDate }}.
                <a class="font-semibold text-(--accent-primary) underline" [routerLink]="next.path"
                  >Read version {{ next.version }}.</a
                >
              </p>
            }
          </div>
        </div>
      </section>

      <!-- Body: rendered Markdown (sanitized). Styled globally via .aec-prose. -->
      <div class="mx-auto max-w-7xl px-6 py-12 md:px-8 md:py-16">
        <article class="aec-prose max-w-[70ch]" [innerHTML]="doc.html"></article>
        <!-- AECI-1610: the body ends with "## Change history" (the registry
             checks it is the last section), and the current files promise that
             every version is listed there. So an upcoming version is listed here,
             right after it, from the manifest, without editing the Markdown. -->
        @if (announcements.length > 0) {
          <ul class="aec-prose max-w-[70ch]" data-testid="legal-upcoming-history">
            @for (next of announcements; track next.version) {
              <li i18n="@@app.legal.upcomingHistoryLine">
                <a [routerLink]="next.path">Version {{ next.version }}</a
                >: takes effect on {{ next.effectiveDate }}.
              </li>
            }
          </ul>
        }
      </div>
    </div>
  `,
})
export class LegalPage {
  private readonly route = inject(ActivatedRoute);
  private readonly meta = inject(MetaService);
  private readonly lookup = inject(LEGAL_DOC_LOOKUP);
  private readonly upcoming = inject(LEGAL_UPCOMING_ENTRIES);

  protected readonly doc: LegalDoc;
  /** The current version's path: the canonical, and every callout's link. */
  protected readonly currentPath: string;
  /** The current version served at its own `/v<version>` address (AECI-1610). */
  protected readonly fixedCurrent: boolean;
  /** Upcoming versions announced on the current text; empty on any other page. */
  protected readonly announcements: readonly LegalAnnouncement[];

  constructor() {
    // A `/legal/<slug>` route names its slug in `data`; the one
    // `/legal/<slug>/v<version>` route passes both as path params (AECI-1610).
    const { data, paramMap } = this.route.snapshot;
    const slug = (data['slug'] ?? paramMap?.get('slug')) as LegalSlug;
    const version = (data['version'] ?? paramMap?.get('version') ?? undefined) as
      | string
      | undefined;
    // AECI-1689: whether the slug's upcoming version is in force for this request,
    // decided on the server and handed to the browser (`legal-in-force.resolver.ts`).
    // Absent (no resolver ran) is the pre-moment state.
    const switched = data['legalSwitched'] === true;
    const view = resolveLegalView(slug, version, this.lookup, this.upcoming, switched);
    if (!view) {
      // Programming error: a route was registered with a slug or version that
      // has no backing document. The routes are generated from the registry
      // manifest, so they only ever pass valid ones.
      throw new Error(`No legal document for slug "${slug}" version "${version ?? 'current'}"`);
    }
    this.doc = view.doc;
    this.currentPath = view.currentPath;
    this.fixedCurrent = view.fixedCurrent;
    this.announcements = view.announcements;

    const chrome = chromeForSlug(slug);
    this.meta.setStaticPageMeta({
      title: chrome.title,
      description: chrome.description,
      // Every `/v<version>` address, archived (AECI-1361), upcoming or current
      // (AECI-1610), canonicalises to the current page and stays out of the index.
      canonical: canonicalUrl(this.currentPath),
      noindex: view.noindex,
    });
  }
}
