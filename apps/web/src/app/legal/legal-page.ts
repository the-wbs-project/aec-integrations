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
 * **Static + edge-cache / SSR-safe.** No data fetch and no per-visitor state —
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
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { type LegalDoc, type LegalSlug, getLegalDoc, getLegalVersion } from './legal-content';
import { legalPath } from './legal-manifest';

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
        description: $localize`:@@meta.legalManagedPlanAgreementDescription:The agreement for Managed licenses on AEC Integrations: prices, annual and monthly billing, renewal notice, refunds, and what happens when Managed ends.`,
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
                <a class="font-medium text-(--accent-primary) underline" [routerLink]="currentPath"
                  >Read the current version.</a
                >
              </p>
            }
          </div>
        </div>
      </section>

      <!-- Body: rendered Markdown (sanitized). Styled globally via .aec-prose. -->
      <div class="mx-auto max-w-7xl px-6 py-12 md:px-8 md:py-16">
        <article class="aec-prose max-w-[70ch]" [innerHTML]="doc.html"></article>
      </div>
    </div>
  `,
})
export class LegalPage {
  private readonly route = inject(ActivatedRoute);
  private readonly meta = inject(MetaService);

  protected readonly doc: LegalDoc;
  /** The current version's path: the canonical, and the archive notice's link. */
  protected readonly currentPath: string;

  constructor() {
    const slug = this.route.snapshot.data['slug'] as LegalSlug;
    const version = this.route.snapshot.data['version'] as string | undefined;
    const doc = version === undefined ? getLegalDoc(slug) : getLegalVersion(slug, version);
    if (!doc) {
      // Programming error: a route was registered with a slug or version that
      // has no backing document. The routes are generated from the registry
      // manifest, so they only ever pass valid ones.
      throw new Error(`No legal document for slug "${slug}" version "${version ?? 'current'}"`);
    }
    this.doc = doc;
    this.currentPath = legalPath(slug);

    const chrome = chromeForSlug(slug);
    this.meta.setStaticPageMeta({
      title: chrome.title,
      description: chrome.description,
      // An archived version canonicalises to the current one and stays out of
      // the index (AECI-1361).
      canonical: canonicalUrl(this.currentPath),
      noindex: doc.supersededOn !== undefined,
    });
  }
}
