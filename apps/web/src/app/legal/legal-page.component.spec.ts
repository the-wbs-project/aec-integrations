import { Title } from '@angular/platform-browser';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import {
  AGREEMENT_CHECKBOX_LABELS,
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  LEGAL_POLICY_CURRENT_VERSIONS,
  type LegalAgreementDocument,
  type LegalPolicyDocument,
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

  // AECI-1617 (counsel Q15): the short forms beside the claim and checkout boxes restate
  // these sentences. If one of these fails, change the short forms in the same PR:
  // `vendor-terms-box.ts`, `MANAGED_PLAN_CAP_SHORT_FORM`, `vendor-billing-stripe-panel.ts`.
  it('still holds the terms the claim and checkout short forms restate', () => {
    const body = (slug: Parameters<typeof render>[0]) =>
      (render(slug).host.querySelector('article.aec-prose')?.textContent ?? '').replace(
        /\s+/g,
        ' ',
      );

    const vendorTerms = body('vendor-terms');
    expect(vendorTerms).toContain('Disclaimers and liability');
    expect(vendorTerms).toContain('is limited to one hundred US dollars');
    // Since 1.2 the Vendor Terms hold the exclusion too (item 10.6), so the claim short
    // form credits them for both sentences. Item 11.19 states the carve-outs.
    expect(vendorTerms).toContain(
      'We are not liable to you for lost profits, lost business, or any indirect or consequential loss',
    );
    expect(vendorTerms).toContain('Neither the cap nor the exclusion of lost profits');
    expect(vendorTerms).toContain(
      'I have read and accept the Vendor Terms on behalf of the company named above, and I am authorized to bind that company.',
    );

    expect(body('terms')).toContain(
      'not liable for any indirect, incidental, special, consequential, or punitive damages',
    );

    const agreement = body('managed-plan-agreement');
    expect(agreement).toContain('Limit of liability');
    expect(agreement).toContain(
      'limited to the greater of the fees you paid for the Managed subscription for the product to which the claim relates in the twelve months before the claim arose, or one hundred US dollars',
    );
    expect(agreement).toContain(
      'For a claim not tied to one product, the base is all fees you paid under this agreement in that period.',
    );
    expect(agreement).toContain(
      'lost profits, lost business, or any indirect or consequential loss',
    );
    expect(agreement).toContain('Neither the cap nor the exclusion of lost profits');
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

  // The `## Disputes` governing-law paragraph. The ToS and both vendor agreements share it,
  // with one deliberate difference: the ToS keeps the consumer-law exception and the
  // agreements drop it (counsel Q35b, AECI-1363 item 11.12). Courts are exclusive (item
  // 11.13). No arbitration, no class-action waiver (AECI-312).
  const GOVERNING_LAW_CORE =
    'These terms are governed by the laws of the State of Florida, without regard to its conflict-of-laws rules. Any dispute arising from these terms or the service shall be brought exclusively in the state courts in Martin County, Florida, or in the United States District Court for the Southern District of Florida where that court has jurisdiction. You consent to that jurisdiction and venue and waive any objection to venue there';
  const GOVERNING_LAW_TOS = `${GOVERNING_LAW_CORE}, except where applicable consumer law provides otherwise.`;
  const GOVERNING_LAW_AGREEMENT = `${GOVERNING_LAW_CORE}.`;
  // Both agreements carry the exclusive-courts sentence and the bold jury waiver after it
  // (items 11.13 and 11.17; the Vendor Terms since 1.2). The ToS has no jury waiver.
  const GOVERNING_LAW_BY_SLUG = {
    'vendor-terms': GOVERNING_LAW_AGREEMENT,
    'managed-plan-agreement': GOVERNING_LAW_AGREEMENT,
  } as const;
  // Item 13.8 (legal branch 5) labels the waiver.
  const JURY_WAIVER =
    'Jury trial waiver. Each of us gives up any right to a jury trial in any court action about these terms or the service. A judge decides the case.';
  // Counsel's Q1 follow-up (item 11.19) made the limit one-directional in all three. Items
  // 13.6 and 13.7 (legal branch 5) replaced its wording with this pair of sentences.
  const ONE_DIRECTIONAL =
    'This section limits what we can owe you. It does not limit what you owe us.';
  const OLD_ONE_DIRECTIONAL = 'that exclusion applies only to claims against us';
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

  it('governing law in the ToS is the shared sentence with the consumer-law exception', () => {
    const article = render('terms').host.querySelector('article.aec-prose')!;
    expect(paragraphs(article)).toContain(GOVERNING_LAW_TOS);
    expect(paragraphs(article)).not.toContain(JURY_WAIVER);
  });

  it('the ToS caps reader liability at $100, bold, with the one-directional carve-outs (items 11.18, 11.19)', () => {
    const article = render('terms').host.querySelector('article.aec-prose')!;
    const bold = Array.from(article.querySelectorAll('strong')).map((s) => s.textContent ?? '');
    const cap = bold.find((b) => b.startsWith('Our total liability to you under these terms'));
    expect(cap).toContain('is limited to one hundred US dollars.');
    expect(cap).toContain(ONE_DIRECTIONAL);
    expect(article.textContent).not.toContain('This limit covers our liability only');
    expect(article.textContent).not.toContain(OLD_ONE_DIRECTIONAL);
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

      it('carries the shared governing law, the ranking sentence, and no arbitration', () => {
        const article = render(slug).host.querySelector('article.aec-prose')!;
        expect(paragraphs(article)).toContain(GOVERNING_LAW_BY_SLUG[slug]);
        expect(paragraphs(article)).toContain(JURY_WAIVER);
        expect(article.querySelector('strong')).not.toBeNull();
        expect(article.textContent).toContain(ONE_DIRECTIONAL);
        expect(article.textContent).not.toContain('This limit covers our liability only');
        expect(article.textContent).not.toContain(OLD_ONE_DIRECTIONAL);
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
    expect(text).toContain(`"${AGREEMENT_CHECKBOX_LABELS.vendor_terms.text}"`);
    // AECI-1639: an owner may change the legal name. AECI-1649: the claim form asks no role.
    expect(text).toContain(
      "invite colleagues, and change the billing email and the company's legal name.",
    );
    expect(text).toContain(
      "the company's legal name, your work email address, an optional LinkedIn profile",
    );
    // No seat exists at claim time: acceptance is against the claimant first.
    expect(text).toContain('your email address and your claim request');
    expect(text).toContain('recorded against your seat');
    expect(article.querySelector('a[href="/legal/managed-plan-agreement"]')).not.toBeNull();
  });

  it('managed plan agreement: the twelve §4 headings in order, then Renewal notice, the three closing sections, Disputes, Contact, Change history', () => {
    const article = render('managed-plan-agreement').host.querySelector('article.aec-prose')!;
    expect(h2s(article)).toEqual([
      'What a subscription is and does',
      'Prices and billing options',
      'Annual renewal',
      'Monthly billing',
      'Refunds',
      'Subscriptions stay assigned until renewal',
      'When Managed ends',
      'Suspension and non-payment',
      // AECI-1516: subscriptions when a company gives up its claim.
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
    expect(text).toContain('45 days before the renewal date');
    expect(text).toContain('no commitment');
    expect(text).toContain('twelve months');
    expect(text).toContain('a grant we record');
    expect(text).not.toContain('AECi-recorded');
    expect(text).toContain(`"${AGREEMENT_CHECKBOX_LABELS.managed_plan.text}"`);
    // Decision 6: invoice-sourced subscriptions are a grant we record.
    expect(text.toLowerCase()).not.toContain('purchase order');
    // Counsel-open items say "Pending", never a bracketed placeholder.
    expect(text).not.toMatch(/\[[A-Z ]+\]/);
  });

  // AECI-1619: the agreement states the core of Managed itself, so a change to the Plans
  // page cannot take away what the buyer accepted. Each phrase is a headline row of the
  // Plans comparison table (`docs-plans-comparison.ts`).
  it('managed plan agreement: names each headline Managed inclusion', () => {
    const article = render('managed-plan-agreement').host.querySelector('article.aec-prose')!;
    const heading = Array.from(article.querySelectorAll('h2')).find(
      (h) => h.textContent?.trim() === 'What a subscription is and does',
    )!;
    let section = '';
    for (
      let el = heading.nextElementSibling;
      el && el.tagName !== 'H2';
      el = el.nextElementSibling
    ) {
      section += ` ${el.textContent ?? ''}`;
    }
    section = section.replace(/\s+/g, ' ');
    for (const phrase of [
      "edit the product's Managed fields",
      '"How teams use it"',
      'the trades, audiences and phases it serves',
      'integrations page and API docs',
      'confirm which data each',
      'We notify search engines when you update',
      'A notice does not decide whether or when a search engine crawls, indexes or ranks the page.',
      'As on every plan, owner seats can also reply to reviews',
      'reply to reviews',
      'seats for their colleagues',
      'for the term you paid for, at the price shown at checkout',
      'We record the Plans page as it stood when you accepted, with your acceptance record.',
    ]) {
      expect(section, phrase).toContain(phrase);
    }
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
      'the number of subscriptions,',
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

    // AECI-1619: a claim records the version of each policy the Vendor Terms incorporate,
    // read from this shared map. A Markdown bump without a map bump fails here.
    it('the shared policy version map equals the frontmatter of each policy', () => {
      const slugFor: Record<LegalPolicyDocument, LegalSlug> = {
        listing_accuracy: 'listing-accuracy',
        review_guidelines: 'review-guidelines',
      };
      for (const [policy, version] of Object.entries(LEGAL_POLICY_CURRENT_VERSIONS)) {
        expect(currentLegalVersion(slugFor[policy as LegalPolicyDocument]), policy).toBe(version);
      }
    });

    it('currentLegalVersion reads the frontmatter', () => {
      expect(currentLegalVersion('terms')).toBe('1.1');
      expect(currentLegalVersion('vendor-terms')).toBe('1.3');
      expect(currentLegalVersion('managed-plan-agreement')).toBe('1.1');
    });
  });
});
