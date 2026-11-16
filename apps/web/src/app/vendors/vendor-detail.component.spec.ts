/**
 * VendorDetailPage: the band shell page (AECI-1797) and its claim CTA.
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
import { trail } from '../shared/breadcrumb/breadcrumb-trail.harness';

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

// AECI-1797: the vendor page is on DetailLayout's band shell (mock-up 11, rulings of
// 2026-11-16). The Forest hero holds the breadcrumb, the name and the description. The
// facts card is the page's metadata. No section nav. The mailing list is white.
describe('VendorDetailPage band shell (AECI-1797)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the band shell with the hero, the facts card and no sidebar', () => {
    const { el } = setup(buildVendor());
    expect(el.querySelector('[data-shell=bands]')).not.toBeNull();
    const hero = el.querySelector('aec-hero-band');
    expect(hero).not.toBeNull();
    expect(hero!.querySelector('nav[aria-label=Breadcrumb]')).not.toBeNull();
    expect(el.querySelectorAll('h1')).toHaveLength(1);
    expect(hero!.querySelector('h1')?.textContent?.trim()).toBe('Procore Technologies');
    const aside = el.querySelector('aside[aria-label=Metadata]');
    expect(aside?.querySelector('[data-testid=vendor-facts]')).not.toBeNull();
    expect([...aside!.classList]).not.toContain('lg:sticky');
    expect(el.querySelector('aec-section-nav')).toBeNull();
  });

  it('puts the description in the hero as its lede, with no About heading', () => {
    const { el } = setup(buildVendor());
    const lede = el.querySelector('aec-hero-band [data-testid=vendor-description]');
    expect(lede?.textContent?.trim()).toBe('Construction management platform.');
    expect([...el.querySelectorAll('h2')].map((h) => h.textContent?.trim())).not.toContain('About');
    // With no lead, the shell's About band holds nothing and hides: the facts ground is
    // the page's one Bone band.
    expect(el.querySelector('[data-lead]')?.children).toHaveLength(0);
  });

  it('keeps At a glance, Company facts and Actions in the facts card', () => {
    const { el } = setup(
      buildVendor({
        company_facts: {
          headquarters: {
            value: 'Carpinteria, CA',
            source: { set_by: 'aeci', date: '2026-11-04T00:00:00.000Z', url: 'https://x.test/hq' },
          },
          founded_year: null,
          company_size: null,
          ownership_type: null,
          parent_company: null,
          funding_stage: null,
        },
      }),
    );
    const card = el.querySelector('[data-testid=vendor-facts]')!;
    const headings = [...card.querySelectorAll('h2')].map((h) => h.textContent?.trim());
    expect(headings).toEqual(['At a glance', 'Company facts', 'Actions']);
    expect(card.querySelector('aec-company-facts')?.textContent).toContain(
      'Set by AEC Integrations on Nov 4, 2026',
    );
    // The licence note sits under the card, in the same slot.
    expect(card.lastElementChild?.tagName.toLowerCase()).toBe('aec-company-facts-note');
  });

  it('drops the Company facts cell when there are no facts, and keeps the others', () => {
    const { el } = setup(buildVendor());
    const card = el.querySelector('[data-testid=vendor-facts]')!;
    expect(card.querySelector('aec-company-facts')).toBeNull();
    expect([...card.querySelectorAll('h2')].map((h) => h.textContent?.trim())).toEqual([
      'At a glance',
      'Actions',
    ]);
  });

  it('shows the website as the Bone button and the social links Bone-washed', () => {
    const { el } = setup(buildVendor({ x_url: 'https://x.com/procore' }));
    expect(el.querySelector('a[href="https://x.com/procore"]')?.getAttribute('data-variant')).toBe(
      'on-brand-secondary',
    );
    expect(
      el.querySelector('a[href="https://www.procore.com"]')?.getAttribute('data-variant'),
    ).toBe('on-brand');
  });

  it('puts the mailing list on white', () => {
    const { el } = setup(buildVendor());
    const band = el.querySelector('aec-mailing-list-signup section');
    expect([...band!.classList]).toContain('bg-(--surface-base)');
  });
});

// Ruling 4 of 2026-11-16 approved the caption. It states the API's order (toVendorDetail:
// A to Z by name, case ignored, then id), which the page renders as given.
describe('VendorDetailPage products order caption (AECI-1797)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const product = (n: number, name: string) => ({
    id: `00000000-0000-4000-8000-00000002000${n}`,
    slug: `p-${n}`,
    name,
    logo_url: null,
    product_role: 'application' as const,
    vendor: null,
    integration_count: 0,
    review_count: 0,
    rating_overall_avg: null,
    rating_onboarding_avg: null,
    created_at: '2024-06-01T00:00:00.000Z',
    updated_at: '2024-06-01T00:00:00.000Z',
  });

  it('says how the list is ordered and keeps the order it was given', () => {
    const names = ['Agave', 'BIM 360', 'pyRevit', 'Revit'];
    const { el } = setup(buildVendor({ products: names.map((name, i) => product(i, name)) }));
    expect(el.querySelector('[data-testid=vendor-products-order]')?.textContent?.trim()).toBe(
      'A to Z by name.',
    );
    const links = [...el.querySelectorAll('table[aria-label=Products] tbody tr')].map((tr) =>
      tr.querySelector('a[href^="/products/"]')?.getAttribute('href'),
    );
    expect(links).toEqual(['/products/p-0', '/products/p-1', '/products/p-2', '/products/p-3']);
  });

  it('shows no order caption over the empty state', () => {
    const { el } = setup(buildVendor({ products: [] }));
    expect(el.querySelector('[data-testid=vendor-products-order]')).toBeNull();
    expect(el.textContent).toContain('No products listed yet.');
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

// ── Maintenance marker (AECI-981 / STAGE_2_ATTESTATIONS_SPEC.md §13.9) ───────
//
// The rendered half of the defect. `aec-maintenance-marker` and its four branches
// have shipped since AECI-616 and have their own component spec, but until now
// NOTHING bound the API's `maintenance` object to the vendor page's mount site — so a
// dropped input or a wrong field name would have rendered AECi attribution
// forever and no test would have noticed. That is exactly the shape of the bug
// this issue reports, one layer down.
describe('VendorDetailPage maintenance marker', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders AECi attribution with no date for an unreviewed record', () => {
    const { el } = setup(buildVendor());
    const marker = el.querySelector('aec-maintenance-marker');
    expect(marker).toBeTruthy();
    expect(marker!.textContent).toContain('AEC Integrations maintained');
    expect(marker!.textContent).not.toMatch(/\d{4}/);
  });

  it('renders the vendor branch when the record has been taken over', () => {
    const { el } = setup(
      buildVendor({
        maintenance: { maintained_by: 'vendor', last_reviewed_at: '2026-09-16T00:00:00.000Z' },
      }),
    );
    const marker = el.querySelector('aec-maintenance-marker');
    // The verb differs by branch off the SAME column: "Updated" for a vendor,
    // "Reviewed" for AECi. Asserting the whole string is what catches a mis-bind
    // that passes the right date into the wrong branch.
    expect(marker!.textContent).toContain(
      'Vendor maintained: Procore Technologies keeps this up to date · Updated September 16, 2026',
    );
    expect(marker!.textContent).not.toContain('AEC Integrations maintained');
  });

  it('carries the date through to the AECi branch too', () => {
    const { el } = setup(
      buildVendor({
        maintenance: { maintained_by: 'aeci', last_reviewed_at: '2026-03-04T00:00:00.000Z' },
      }),
    );
    expect(el.querySelector('aec-maintenance-marker')!.textContent).toContain(
      'AEC Integrations maintained · Reviewed March 4, 2026',
    );
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

  it('shows the logo as the 104px hero mark and adds no wording on a claimed listing', () => {
    const { fixture } = setup(
      buildVendor({ claim_status: 'claimed', logo_url: 'https://cdn.example.com/a.png' }),
    );
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('aec-unclaimed-note')).toBeNull();
    const mark = el.querySelector('[data-testid=vendor-hero-mark]');
    expect(mark?.hasAttribute('heroMark')).toBe(true);
    expect(mark?.querySelector('img')?.getAttribute('width')).toBe('104');
  });

  it('gives an unclaimed listing no large mark, so no logo renders above 32px', () => {
    const { fixture } = setup(
      buildVendor({ claim_status: 'unclaimed', logo_url: 'https://cdn.example.com/a.png' }),
    );
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid=vendor-hero-mark]')).toBeNull();
    const widths = [...el.querySelectorAll('img[src="https://cdn.example.com/a.png"]')].map((i) =>
      Number(i.getAttribute('width')),
    );
    expect(widths).toEqual([32]);
  });
});

// AECI-1614: the vendor page takes Corrected only (ruling 2026-11-05).
describe('VendorDetailPage corrections (AECI-1614)', () => {
  const correction = (field: string, source_url: string | null = null, cleared = false) => ({
    field,
    date: '2026-09-15T00:00:00.000Z',
    source_url,
    cleared,
  });
  const lines = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('[data-testid="field-correction"]')).map((n) =>
      n.textContent?.replace(/\s+/g, ' ').trim(),
    );

  it('renders nothing with no corrections, and never a Maintained caption', () => {
    const { el } = setup(buildVendor());
    expect(lines(el)).toEqual([]);
    expect(el.querySelector('[data-testid="field-caption"]')).toBeNull();
    expect(el.querySelector('[data-testid="vendor-corrections"]')).toBeNull();
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
    expect(el.querySelectorAll('[data-testid="field-correction-source"]')).toHaveLength(1);
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

  // AECI-1628: a removal reads "Removed by" where the value was, the logo included.
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
    // The logo line sits under the name, above the fact row.
    expect(lines(el)).toEqual([
      `Logo: ${removed}`,
      `Website: ${removed}`,
      `Headquarters: ${removed}`,
      `Founded year: ${removed}`,
    ]);
    expect(el.querySelector('[data-testid="logo-correction"]')?.textContent).toContain(
      `Logo: ${removed}`,
    );
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
});

// AECI-1238 (§11d.7): the company values AECi hid while it checks them.
describe('VendorDetailPage values under review (AECI-1238)', () => {
  const markers = (el: Element | null) =>
    Array.from(el?.querySelectorAll('[data-testid="field-under-review"]') ?? []).map((n) =>
      n.textContent?.replace(/\s+/g, ' ').trim(),
    );

  it('shows the marker in the hero for a hidden description', () => {
    const { el } = setup(buildVendor({ description: null, under_review: ['description'] }));
    expect(
      el.querySelector('aec-hero-band [data-testid="vendor-description-under-review"]'),
    ).not.toBeNull();
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

describe('VendorDetailPage breadcrumb (AECI-1777)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reads Home, then the company as the current page', () => {
    const { el } = setup(buildVendor());
    expect(trail(el)).toEqual([
      { label: 'Home', href: '/', current: false },
      { label: 'Procore Technologies', href: null, current: true },
    ]);
  });
});
