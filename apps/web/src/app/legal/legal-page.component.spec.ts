import { Title } from '@angular/platform-browser';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import {
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  type LegalAgreementDocument,
} from '@aeci/shared/api/agreements';
import { MANAGED_ANNUAL_PRICE_CENTS, MANAGED_LIST_PRICE_CENTS } from '@aeci/shared/entitlements';

import { LegalPage } from './legal-page';
import { type LegalSlug, LEGAL_SLUGS, currentLegalVersion, getLegalVersion } from './legal-content';
import { LEGAL_ARCHIVES } from './legal-manifest';

function render(slug: LegalSlug, version?: string): { host: HTMLElement; title: Title } {
  // Reset first so a test can render several slugs in sequence (each needs a
  // fresh, not-yet-instantiated module).
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { data: version === undefined ? { slug } : { slug, version } } },
      },
    ],
  });
  const fixture = TestBed.createComponent(LegalPage);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, title: TestBed.inject(Title) };
}

describe('LegalPage', () => {
  it('renders the frontmatter title as the single h1 and the version metadata', () => {
    const { host } = render('terms');
    const h1s = host.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toContain('Terms of Service');
    // Frontmatter version line (§27.1: version shown at the top).
    expect(host.textContent).toContain('Version 1.1');
  });

  it('hides the effective-date chip while the draft frontmatter leaves it blank', () => {
    const { host } = render('terms');
    expect(host.textContent).not.toContain('Effective');
    // Last-updated is always present.
    expect(host.textContent).toContain('Last updated');
  });

  it('renders the Markdown body (sanitized) into .aec-prose with headings, lists, and links', () => {
    const { host } = render('terms');
    const article = host.querySelector('article.aec-prose');
    expect(article).not.toBeNull();
    // marked produced block structure the global .aec-prose styles target.
    expect(article!.querySelector('h2')).not.toBeNull();
    expect(article!.querySelector('ul')).not.toBeNull();
    expect(article!.querySelector('blockquote')?.textContent).toContain('pending legal review');
    // The sanitizer keeps anchor hrefs, so internal cross-links survive.
    expect(article!.querySelector('a[href="/legal/review-guidelines"]')).not.toBeNull();
  });

  it('routes review reports to support@ (AECI-1265: there is no reviews@ mailbox)', () => {
    const { host } = render('review-guidelines');
    const article = host.querySelector('article.aec-prose');
    expect(article!.querySelector('a[href="mailto:support@aecintegrations.com"]')).not.toBeNull();
    // Ruled 2026-10-09: there is no reviews@ mailbox, so AECI-307's alias is gone.
    expect(article!.querySelector('a[href^="mailto:reviews@"]')).toBeNull();
  });

  it('puts the contest path beside the correction path on the listing-accuracy policy (AECI-1023)', () => {
    const { host } = render('listing-accuracy');
    const article = host.querySelector('article.aec-prose');
    const h2s = Array.from(article!.querySelectorAll('h2')).map((h) => h.textContent?.trim());
    // The contest section follows the correction section, so a reader looking for
    // "how do I get this fixed" finds both routes in one place.
    expect(h2s.indexOf('Contesting an integration detail')).toBe(
      h2s.indexOf('Requesting a correction') + 1,
    );
    expect(h2s).toContain('Who maintains an integration');
    const text = article!.textContent ?? '';
    // Routing as `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.4 builds it.
    expect(text).toContain('if the owner has claimed the integration, the owner decides');
    expect(text).toContain('always comes to us, even after a claim');
    // AECI-1009: an owner decline can be reviewed by us, and the view is advice.
    expect(h2s).not.toContain("Asking us to review an owner's decision");
    const h3s = Array.from(article!.querySelectorAll('h3')).map((h) => h.textContent?.trim());
    expect(h3s).toContain("Asking us to review an owner's decision");
    expect(text).toContain('within 30 days of the decline');
    expect(text).toContain('Our view is advice.');
    expect(text).toContain('may not contest the same detail of that integration again for 90 days');
    expect(text).toContain('We do not publish anything about a review');
  });

  // The ToS `## Disputes` governing-law paragraph. Both vendor agreements copy it
  // verbatim (AECI-1359 / AECI-1360). No arbitration, no class-action waiver
  // (AECI-312).
  const GOVERNING_LAW =
    'These terms are governed by the laws of the State of Florida, without regard to its conflict-of-laws rules. The state courts located in Martin County, Florida, and the United States District Court for the Southern District of Florida have exclusive jurisdiction over any dispute arising from these terms or the service, and you consent to that jurisdiction and venue, except where applicable consumer law provides otherwise.';
  // The portal plan panel's sentence, as `/docs/vendors/plans` quotes it.
  const RANKING = 'No plan changes where you rank or appear, or whether a review is published.';

  function paragraphs(article: Element): string[] {
    return Array.from(article.querySelectorAll('p')).map((p) =>
      (p.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
  }

  function h2s(article: Element): string[] {
    return Array.from(article.querySelectorAll('h2')).map((h) => h.textContent?.trim() ?? '');
  }

  it('governing law in the ToS is the sentence the vendor agreements copy', () => {
    const article = render('terms').host.querySelector('article.aec-prose')!;
    expect(paragraphs(article)).toContain(GOVERNING_LAW);
  });

  describe.each(['vendor-terms', 'managed-plan-agreement'] as const)(
    '%s (AECI-1359/1360)',
    (slug) => {
      it('renders as an unapproved draft: one h1, version 1.0, last updated, no effective date', () => {
        const { host } = render(slug);
        expect(host.querySelectorAll('h1')).toHaveLength(1);
        expect(host.textContent).toContain('Version 1.0');
        expect(host.textContent).toContain('Last updated');
        expect(host.textContent).not.toContain('Effective');
        const article = host.querySelector('article.aec-prose')!;
        expect(article.querySelector('blockquote')?.textContent).toContain('pending legal review');
      });

      it('carries the ToS governing law verbatim, the ranking sentence, and no arbitration', () => {
        const article = render(slug).host.querySelector('article.aec-prose')!;
        expect(paragraphs(article)).toContain(GOVERNING_LAW);
        expect(article.textContent).toContain(RANKING);
        expect(h2s(article)).toContain('Plans never affect ranking or reviews');
        expect(article.textContent?.toLowerCase()).not.toContain('arbitration');
        expect(article.textContent?.toLowerCase()).not.toContain('class action');
        // Sits under the ToS and references it rather than restating it.
        expect(article.querySelector('a[href="/legal/terms"]')).not.toBeNull();
      });
    },
  );

  it('vendor terms: a heading per VENDOR_SIGNUP_PROCESS §4 bullet and the claim-box sentence', () => {
    const article = render('vendor-terms').host.querySelector('article.aec-prose')!;
    expect(h2s(article)).toEqual(
      expect.arrayContaining([
        'Who may claim',
        'Truthfulness',
        'Your content and our license to publish it',
        'We may edit or remove content',
        'Plans never affect ranking or reviews',
        'When Managed ends on a product',
        'Seats and revocation',
        'Disputes',
      ]),
    );
    const text = article.textContent ?? '';
    expect(text).toContain('"I represent this company and accept the vendor terms."');
    // No seat exists at claim time: acceptance is against the claimant first.
    expect(text).toContain('your email address and your claim request');
    expect(text).toContain('recorded against your seat');
    expect(article.querySelector('a[href="/legal/managed-plan-agreement"]')).not.toBeNull();
  });

  it('managed plan agreement: the twelve §4 headings in order, then Renewal notice, the three closing sections, Disputes, Contact, Change history', () => {
    const article = render('managed-plan-agreement').host.querySelector('article.aec-prose')!;
    expect(h2s(article)).toEqual([
      'What a license is and does',
      'Prices and billing options',
      'Annual renewal',
      'Monthly billing',
      'Refunds',
      'Licenses stay assigned until renewal',
      'When Managed ends',
      'Suspension and non-payment',
      // AECI-1516: licenses when a company gives up its claim.
      'If you give up your claim',
      'Limit of liability',
      'Changes to this agreement',
      'Plans never affect ranking or reviews',
      'Renewal notice',
      'No promise of results',
      'Term and survival',
      'General terms',
      'Disputes',
      'Contact',
      // AECI-1361: every current legal file ends with its change history.
      'Change history',
    ]);
  });

  it('managed plan agreement: prices come from the entitlement constants, terms from §1', () => {
    const article = render('managed-plan-agreement').host.querySelector('article.aec-prose')!;
    const text = (article.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain(`$${MANAGED_ANNUAL_PRICE_CENTS / 100} a year`);
    expect(text).toContain(`$${MANAGED_LIST_PRICE_CENTS / 100} a month`);
    expect(text).toContain('14 days of the first charge');
    expect(text).toContain('30 days before the renewal date');
    expect(text).toContain('no commitment');
    expect(text).toContain('twelve months');
    expect(text).toContain('an AECi-recorded grant');
    expect(text).toContain('"I have read and accept the Managed plan agreement."');
    // Decision 6: invoice-sourced licenses are an AECi-recorded grant.
    expect(text.toLowerCase()).not.toContain('purchase order');
    // Counsel-open items say "Pending", never a bracketed placeholder.
    expect(text).not.toMatch(/\[[A-Z ]+\]/);
  });

  it('managed plan agreement: the renewal notice lists date, price, count, terms change, opt-out', () => {
    const article = render('managed-plan-agreement').host.querySelector('article.aec-prose')!;
    const heading = Array.from(article.querySelectorAll('h2')).find(
      (h) => h.textContent?.trim() === 'Renewal notice',
    )!;
    let list: Element | null = heading.nextElementSibling;
    while (list && list.tagName !== 'UL') list = list.nextElementSibling;
    const items = Array.from(list!.querySelectorAll('li')).map((li) => li.textContent?.trim());
    expect(items).toEqual([
      'the renewal or end date,',
      'the price,',
      'the number of licenses,',
      'any change to this agreement that will bind at renewal,',
      'how to opt out or reduce.',
    ]);
  });

  it('sets the per-slug document title chrome via MetaService', () => {
    expect(render('terms').title.getTitle()).toBe('Terms of Service · AEC Integrations');
    expect(render('privacy').title.getTitle()).toBe('Privacy Policy · AEC Integrations');
    expect(render('review-guidelines').title.getTitle()).toBe(
      'Review Guidelines · AEC Integrations',
    );
    expect(render('listing-accuracy').title.getTitle()).toBe(
      'Listing Accuracy Policy · AEC Integrations',
    );
    expect(render('vendor-terms').title.getTitle()).toBe('Vendor Terms · AEC Integrations');
    expect(render('managed-plan-agreement').title.getTitle()).toBe(
      'Managed Plan Agreement · AEC Integrations',
    );
  });

  it('writes a self-referential canonical link for the slug', () => {
    render('privacy');
    const link = document.head.querySelector('link[rel="canonical"]');
    expect(link?.getAttribute('href')).toMatch(/\/legal\/privacy$/);
  });

  it('the current page shows no superseded notice and no robots meta', () => {
    const { host } = render('terms');
    expect(host.querySelector('[data-testid="legal-superseded"]')).toBeNull();
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
  });

  describe('archived versions (AECI-1361)', () => {
    it('/legal/terms/v1.0 renders the archived ToS 1.0 text with the superseded notice', () => {
      const { host } = render('terms', '1.0');
      expect(host.querySelectorAll('h1')).toHaveLength(1);
      expect(host.textContent).toContain('Version 1.0');
      const notice = host.querySelector('[data-testid="legal-superseded"]');
      expect(notice?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
        'This is version 1.0, superseded on October 14, 2026. Read the current version.',
      );
      expect(notice?.querySelector('a')?.getAttribute('href')).toBe('/legal/terms');
      const article = host.querySelector('article.aec-prose')!;
      // 1.0 predates AECI-312's governing-law fill and the change history.
      expect(article.textContent).not.toContain('State of Florida');
      expect(article.textContent).not.toContain('Change history');
    });

    it('canonicalises to the current version and sets robots noindex', () => {
      render('privacy', '1.0');
      const link = document.head.querySelector('link[rel="canonical"]');
      expect(link?.getAttribute('href')).toMatch(/\/legal\/privacy$/);
      expect(document.head.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
        'noindex',
      );
    });

    it('a client nav back to the current page clears the robots meta', () => {
      render('terms', '1.0');
      render('terms');
      expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
    });

    it('every manifest entry resolves to its archived text', () => {
      for (const { slug, version, supersededOn } of LEGAL_ARCHIVES) {
        const doc = getLegalVersion(slug, version);
        expect(doc?.frontmatter.version, `${slug} ${version}`).toBe(version);
        expect(doc?.supersededOn).toBe(supersededOn);
      }
      expect(getLegalVersion('terms', '9.9')).toBeUndefined();
    });
  });

  describe('## Change history (AECI-1361)', () => {
    it('is the last section of every current page, and links each archived version', () => {
      for (const slug of LEGAL_SLUGS) {
        const article = render(slug).host.querySelector('article.aec-prose')!;
        expect(h2s(article).at(-1), slug).toBe('Change history');
        expect(article.textContent, slug).toContain(`Version ${currentLegalVersion(slug)}`);
      }
      const terms = render('terms').host.querySelector('article.aec-prose')!;
      expect(terms.querySelector('a[href="/legal/terms/v1.0"]')).not.toBeNull();
    });

    it('the ToS "Changes to these terms" paragraph points at the on-page history', () => {
      const article = render('terms').host.querySelector('article.aec-prose')!;
      const text = (article.textContent ?? '').replace(/\s+/g, ' ');
      expect(text).toContain(
        'every version is listed under Change history at the end of this page',
      );
      expect(text).not.toMatch(/commit log/i);
    });

    // The API refuses an acceptance of any version but the one in this shared map
    // (AECI-1362). A Markdown bump without a map bump, or the reverse, fails here.
    it('the shared agreement version map equals the frontmatter of each agreement', () => {
      const slugFor: Record<LegalAgreementDocument, LegalSlug> = {
        vendor_terms: 'vendor-terms',
        managed_plan: 'managed-plan-agreement',
      };
      for (const [document, version] of Object.entries(LEGAL_AGREEMENT_CURRENT_VERSIONS)) {
        expect(currentLegalVersion(slugFor[document as LegalAgreementDocument]), document).toBe(
          version,
        );
      }
    });

    it('currentLegalVersion reads the frontmatter', () => {
      expect(currentLegalVersion('terms')).toBe('1.1');
      expect(currentLegalVersion('vendor-terms')).toBe('1.1');
      expect(currentLegalVersion('managed-plan-agreement')).toBe('1.1');
    });
  });
});
