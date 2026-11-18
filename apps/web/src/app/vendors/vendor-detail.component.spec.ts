/**
 * VendorDetailPage — the Actions-sidebar claim CTA.
 *
 * Named `.component.spec.ts` so it runs under `ng test` (Angular's TestBed /
 * vitest runner) rather than the node-only Vitest pass that excludes Angular DI
 * (see `apps/web/vitest.config.ts`).
 *
 * Scope: the claim CTA is stateless (AECI-1266). Every listing reads "Claim this
 * listing" with no note, whatever plan the vendor holds: a state-dependent
 * wording told visitors which vendors pay. The CTA is never removed. Seats are
 * admin-granted and multi-seat, and self-serve invite is deferred
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11), so the public claim form stays the only
 * route in for a second person at the vendor (and the only correction
 * path for a wrong grant). The vendor is delivered via a stub `ActivatedRoute`,
 * the same channel `vendorDetailResolver` populates in production.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorDetail } from '@aeci/shared';

import { Analytics } from '../analytics/analytics';

import { VendorDetailPage } from './vendor-detail';

function buildVendor(overrides: Partial<VendorDetail> = {}): VendorDetail {
  return {
    claim_status: 'claimed',
    id: '00000000-0000-4000-8000-000000010001',
    slug: 'procore',
    company_name: 'Procore Technologies',
    logo_url: null,
    company_facts: {
      headquarters: null,
      founded_year: null,
      company_size: null,
      ownership_type: null,
      parent_company: null,
      funding_stage: null,
    },
    headquarters: 'Carpinteria, CA',
    founded_year: 2002,
    product_count: 1,
    integration_count: 0,
    review_count: 0,
    created_at: '2024-06-01T00:00:00.000Z',
    updated_at: '2024-06-01T00:00:00.000Z',
    description: 'Construction management platform.',
    website: 'https://www.procore.com',
    linkedin_url: null,
    x_url: null,
    facebook_url: null,
    instagram_url: null,
    youtube_url: null,
    products: [],
    maintenance: { maintained_by: 'aeci', last_reviewed_at: null },
    ...overrides,
  };
}

function setup(vendor: VendorDetail) {
  const analytics = { externalLinkClicked: vi.fn(), track: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      // Leaf analytics seams on the page's children (the external-link tracker,
      // the mailing-list band). Returned so the AECI-933 cases can read clicks.
      { provide: Analytics, useValue: analytics },
      {
        provide: ActivatedRoute,
        useValue: { data: of({ vendor }), snapshot: { data: { vendor } } },
      },
    ],
  });
  const fixture = TestBed.createComponent(VendorDetailPage);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, analytics };
}

describe('VendorDetailPage company facts licence note (AECI-1310)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('carries the note on a vendor with no facts too, because it is a blanket note', () => {
    const { el } = setup(buildVendor({ headquarters: null, founded_year: null }));
    expect(el.querySelector('aec-company-facts-note')).not.toBeNull();
  });
});

// AECI-933: the vendor owns its own website and social profiles, so both clicks
// name this vendor as the owner, with the vendor page as the source.
describe('VendorDetailPage outbound click ownership (AECI-933)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const VENDOR_ID = '00000000-0000-4000-8000-000000010001';

  function click(el: HTMLElement, href: string): void {
    el.addEventListener('click', (e) => e.preventDefault());
    const anchor = el.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
    expect(anchor).toBeTruthy();
    anchor!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  it('records the website click as owned by this vendor', () => {
    const { el, analytics } = setup(buildVendor());
    click(el, 'https://www.procore.com');
    expect(analytics.externalLinkClicked).toHaveBeenCalledExactlyOnceWith({
      destination: 'https://www.procore.com/',
      source: 'vendor_detail',
      owner_vendor_id: VENDOR_ID,
      link_origin: 'vendor',
      source_entity_type: 'vendor',
      source_entity_id: VENDOR_ID,
      link_purpose: 'website',
    });
  });

  it('records a social click as owned by this vendor, with purpose social', () => {
    const { el, analytics } = setup(
      buildVendor({ linkedin_url: 'https://www.linkedin.com/company/procore' }),
    );
    click(el, 'https://www.linkedin.com/company/procore');
    expect(analytics.externalLinkClicked).toHaveBeenCalledExactlyOnceWith({
      destination: 'https://www.linkedin.com/company/procore',
      source: 'vendor_detail_social',
      owner_vendor_id: VENDOR_ID,
      link_origin: 'vendor',
      source_entity_type: 'vendor',
      source_entity_id: VENDOR_ID,
      link_purpose: 'social',
    });
  });
});

// AECI-853 lockstep. This page shares DetailLayout, which now docks its sidebar
// at `lg` and so leaves the body column 608px wide. At the old 44rem the
// products table overflowed that by 96px and scrolled inside a narrow well.
// 34rem keeps the table's floor under that 608px column.
// Paired with the dock assertion in detail-layout.component.spec.ts and the
// table assertion in product-integrations-section.component.spec.ts.
describe('VendorDetailPage products table width floor', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('keeps the products table at or under the 38rem the lg dock allows', () => {
    const { el } = setup(
      buildVendor({
        products: [
          {
            id: '00000000-0000-4000-8000-000000020001',
            slug: 'procore-project-management',
            name: 'Procore Project Management',
            logo_url: null,
            product_role: 'application',
            vendor: null,
            integration_count: 1,
            review_count: 0,
            rating_overall_avg: null,
            rating_onboarding_avg: null,
            created_at: '2024-06-01T00:00:00.000Z',
            updated_at: '2024-06-01T00:00:00.000Z',
          },
        ],
      }),
    );
    const table = el.querySelector('table[aria-label=Products]')!;
    expect(table).not.toBeNull();
    expect([...table.classList]).toContain('md:min-w-[34rem]');
    expect([...table.classList].some((c) => /min-w-\[(3[89]|[4-9]\d)rem\]/.test(c))).toBe(false);
  });
});

// ── Record line (AECI-981 / STAGE_2_ATTESTATIONS_SPEC.md §13.9; AECI-1666) ──────
//
// The rendered half of the AECI-981 defect: nothing bound the API's `maintenance` object
// to the vendor page's mount site. Since AECI-1666 the line opens "About this listing"
// instead of sitting in the header as a chip.
describe('VendorDetailPage record line', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const panel = (el: HTMLElement) => el.querySelector('[data-testid="listing-provenance"]')!;

  // Ruling 2026-11-17: every listing shows the panel, including one AECi maintains alone.
  it('retires the header chip and shows the panel for a bare AECi listing', () => {
    const { el } = setup(buildVendor());
    expect(el.querySelector('[slot="hero"] aec-maintenance-marker')).toBeNull();
    expect(panel(el).hasAttribute('hidden')).toBe(false);
    expect(panel(el).querySelector('aec-maintenance-marker')?.textContent?.trim()).toBe(
      'AEC Integrations maintained',
    );
  });

  it('adds the review date to the AECi record line when there is one', () => {
    const { el } = setup(
      buildVendor({
        maintenance: { maintained_by: 'aeci', last_reviewed_at: '2026-09-16T00:00:00.000Z' },
      }),
    );
    expect(panel(el).querySelector('aec-maintenance-marker')?.textContent?.trim()).toBe(
      'AEC Integrations maintained · Reviewed September 16, 2026',
    );
  });

  it('opens the panel with the vendor line when the record has been taken over', () => {
    const { el } = setup(
      buildVendor({
        maintenance: { maintained_by: 'vendor', last_reviewed_at: '2026-09-16T00:00:00.000Z' },
      }),
    );
    const marker = panel(el).querySelector('aec-maintenance-marker');
    // The verb differs by branch off the SAME column: "Updated" for a vendor,
    // "Reviewed" for AECi. Asserting the whole string is what catches a mis-bind
    // that passes the right date into the wrong branch.
    expect(marker!.textContent).toContain(
      'Vendor maintained: Procore Technologies keeps this up to date · Updated September 16, 2026',
    );
  });

  it('reads the AECi form on an unclaimed listing whatever is stored (ruling 3)', () => {
    const { el } = setup(
      buildVendor({
        claim_status: 'unclaimed',
        maintenance: { maintained_by: 'vendor', last_reviewed_at: '2026-09-16T00:00:00.000Z' },
      }),
    );
    expect(el.textContent).not.toContain('Vendor maintained');
  });
});

describe('VendorDetailPage claim CTA', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const actions = (el: HTMLElement) =>
    el.querySelector('section[aria-labelledby="vendor-actions-label"]') as HTMLElement;

  it('always offers to claim the company by name, with no note (AECI-1365)', () => {
    const { el } = setup(buildVendor());
    const section = actions(el);

    expect(section).toBeTruthy();
    expect(section.textContent).toContain('Claim Procore Technologies');
    expect(section.textContent).not.toContain('Claim this listing');
    expect(section.textContent).not.toContain('Request access to this listing');
    expect(section.textContent).not.toContain('Already managed through an active vendor account');
  });

  // AECI-1264 (marketing review B1): no public account or plan label. The hero
  // shows the same thing for a vendor with or without an active plan.
  it('shows no account label and no "What this means" link', () => {
    const { el } = setup(buildVendor());
    expect(el.textContent).not.toContain('Active on AEC Integrations');
    expect(el.textContent).not.toContain('What this means');
    expect(el.querySelector('a[href^="/docs/trust/the-account-label"]')).toBeNull();
  });

  it('points the CTA at the claim route', () => {
    // A colleague joining an account someone already holds uses the same
    // `kind:'claim'` route, because that is the only seat/dispute path there is (§11).
    const { el } = setup(buildVendor());
    const cta = actions(el).querySelector<HTMLAnchorElement>('a[href="/vendors/procore/claim"]');
    expect(cta).toBeTruthy();
  });
});

describe('VendorDetailPage unclaimed wording (AECI-1618)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const WORDING = 'Unclaimed · not affiliated with or endorsed by this vendor';

  it('puts the wording directly beside a small logo on an unclaimed listing', () => {
    const { fixture } = setup(
      buildVendor({ claim_status: 'unclaimed', logo_url: 'https://cdn.example.com/a.png' }),
    );
    const el = fixture.nativeElement as HTMLElement;
    const note = el.querySelector('aec-unclaimed-note');
    expect(note?.textContent?.trim()).toBe(WORDING);
    const logo = note?.previousElementSibling;
    expect(logo?.tagName.toLowerCase()).toBe('aec-logo-or-initial');
    expect(logo?.querySelector('img')?.getAttribute('width')).toBe('32');
  });

  it('shows the wording with no logo, beside the initial tile', () => {
    const { fixture } = setup(buildVendor({ claim_status: 'unclaimed', logo_url: null }));
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('aec-unclaimed-note')?.textContent?.trim()).toBe(WORDING);
    expect(
      el.querySelector('aec-unclaimed-note')?.previousElementSibling?.textContent?.trim(),
    ).toBe('P');
  });

  it('keeps the 64px logo and adds no wording on a claimed listing', () => {
    const { fixture } = setup(
      buildVendor({ claim_status: 'claimed', logo_url: 'https://cdn.example.com/a.png' }),
    );
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('aec-unclaimed-note')).toBeNull();
    expect(el.querySelector('aec-logo-or-initial img')?.getAttribute('width')).toBe('64');
  });
});

// AECI-1666: the vendor page's corrections moved into "About this listing". Corrected
// only: this page takes no Maintained caption (ruling 2026-11-05).
describe('VendorDetailPage provenance panel (AECI-1666)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const correction = (field: string, source_url: string | null = null, cleared = false) => ({
    field,
    date: '2026-09-15T00:00:00.000Z',
    source_url,
    cleared,
  });
  const panel = (el: HTMLElement) => el.querySelector('[data-testid="listing-provenance"]')!;
  const lines = (el: HTMLElement) =>
    Array.from(panel(el).querySelectorAll('[data-testid="field-correction"]')).map((n) =>
      n.textContent?.replace(/\s+/g, ' ').trim(),
    );

  // Ruling 2026-11-17: every listing shows the panel, including one AECi maintains alone.
  it('shows only the record line with no corrections, and never a Maintained caption', () => {
    const { el } = setup(buildVendor());
    expect(lines(el)).toEqual([]);
    expect(panel(el).hasAttribute('hidden')).toBe(false);
    expect(panel(el).querySelector('aec-maintenance-marker')?.textContent?.trim()).toBe(
      'AEC Integrations maintained',
    );
    expect(el.querySelector('[data-testid="field-caption"]')).toBeNull();
    expect(el.querySelector('[data-testid="vendor-corrections"]')).toBeNull();
  });

  it('puts every line in the panel and none in the hero', () => {
    const { el } = setup(
      buildVendor({
        website: 'https://www.example.com',
        corrections: [correction('website', 'https://www.example.com/register')],
      }),
    );
    expect(el.querySelector('[slot="hero"] aec-field-caption')).toBeNull();
    expect(el.querySelector('[data-testid="logo-correction"]')).toBeNull();
    expect(el.querySelectorAll('aec-listing-provenance')).toHaveLength(2);
    expect(el.querySelectorAll('[data-testid="listing-provenance"]')).toHaveLength(1);
    expect(panel(el).closest('aside')).not.toBeNull();
  });

  it('names each corrected fact the page shows', () => {
    const { el } = setup(
      buildVendor({
        website: 'https://www.example.com',
        headquarters: 'Toronto',
        founded_year: 1999,
        linkedin_url: 'https://www.linkedin.com/company/x',
        corrections: [
          correction('website', 'https://www.example.com/register'),
          correction('headquarters'),
          correction('founded_year'),
          correction('linkedin_url'),
        ],
      }),
    );
    // Headquarters and founded year name AECi in the Company facts panel (AECI-1310).
    const words = 'Corrected by AEC Integrations on September 15, 2026';
    expect(lines(el).map((t) => t?.replace(/ ·.*$/, ''))).toEqual([
      `Website: ${words}`,
      `LinkedIn: ${words}`,
    ]);
    expect(panel(el).querySelectorAll('[data-testid="field-correction-source"]')).toHaveLength(1);
  });

  it('skips a correction on a field the page never shows, or a cleared value', () => {
    const { el } = setup(
      buildVendor({
        headquarters: null,
        corrections: [correction('phone_number'), correction('headquarters')],
      }),
    );
    expect(lines(el)).toEqual([]);
  });

  // AECI-1628: a removal reads "Removed by", the logo included.
  it('names each removal, headquarters and founded year included', () => {
    const { el } = setup(
      buildVendor({
        website: null,
        headquarters: null,
        founded_year: null,
        logo_url: null,
        corrections: [
          correction('website', null, true),
          correction('headquarters', null, true),
          correction('founded_year', null, true),
          correction('phone_number', null, true),
          correction('logo_url', null, true),
        ],
      }),
    );
    const removed = 'Removed by AEC Integrations on September 15, 2026';
    expect(lines(el)).toEqual([
      `Website: ${removed}`,
      `Headquarters: ${removed}`,
      `Founded: ${removed}`,
      `Logo: ${removed}`,
    ]);
  });

  it('drops a removal once the slot holds a value again', () => {
    const { el } = setup(
      buildVendor({
        website: 'https://www.example.com',
        logo_url: 'https://logo.example/mark.png',
        corrections: [correction('website', null, true), correction('logo_url', null, true)],
      }),
    );
    expect(lines(el)).toEqual([]);
  });

  it('counts the values under review', () => {
    const { el } = setup(buildVendor({ description: null, under_review: ['description'] }));
    expect(
      panel(el).querySelector('[data-testid="provenance-under-review"]')?.textContent?.trim(),
    ).toBe('1 value on this page is under review.');
  });

  // §4.5.8: the count names only values the page marks in their slot. The phone number
  // and contact email never render, so a hide on them has no marker to count.
  it('counts only the hidden values the page marks', () => {
    const { el } = setup(
      buildVendor({
        linkedin_url: null,
        headquarters: null,
        under_review: ['linkedin_url', 'headquarters', 'phone_number', 'contact_email'],
      }),
    );
    expect(el.querySelectorAll('aec-under-review')).toHaveLength(2);
    expect(
      panel(el).querySelector('[data-testid="provenance-under-review"]')?.textContent?.trim(),
    ).toBe('2 values on this page are under review.');
  });

  it('shows no count when every hidden value is one the page never renders', () => {
    const { el } = setup(buildVendor({ under_review: ['phone_number', 'github_org'] }));
    expect(panel(el).querySelector('[data-testid="provenance-under-review"]')).toBeNull();
  });
});

// AECI-1238 (§11d.7): the company values AECi hid while it checks them.
describe('VendorDetailPage values under review (AECI-1238)', () => {
  const markers = (el: Element | null) =>
    Array.from(el?.querySelectorAll('[data-testid="field-under-review"]') ?? []).map((n) =>
      n.textContent?.replace(/\s+/g, ' ').trim(),
    );

  it('shows About with the marker for a hidden description', () => {
    const { el } = setup(buildVendor({ description: null, under_review: ['description'] }));
    expect(
      markers(
        el.querySelector('[data-testid="vendor-description-under-review"]')?.parentElement ?? null,
      ),
    ).toEqual(['Under review. AEC Integrations is checking this detail.']);
  });

  it('names each hidden link in the hero, in the row order', () => {
    const { el } = setup(
      buildVendor({
        website: null,
        linkedin_url: null,
        under_review: ['linkedin_url', 'website'],
      }),
    );
    expect(markers(el.querySelector('[data-testid="vendor-under-review"]'))).toEqual([
      'Website: Under review. AEC Integrations is checking this detail.',
      'LinkedIn: Under review. AEC Integrations is checking this detail.',
    ]);
  });

  it('passes the list to the Company facts panel', () => {
    const { el } = setup(buildVendor({ headquarters: null, under_review: ['headquarters'] }));
    expect(
      el.querySelector('[data-testid="company-fact-under-review-headquarters"]'),
    ).not.toBeNull();
  });
});
