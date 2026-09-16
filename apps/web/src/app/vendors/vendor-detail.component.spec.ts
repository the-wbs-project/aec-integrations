/**
 * VendorDetailPage — the Actions-sidebar claim CTA.
 *
 * Named `.component.spec.ts` so it runs under `ng test` (Angular's TestBed /
 * vitest runner) rather than the node-only Vitest pass that excludes Angular DI
 * (see `apps/web/vitest.config.ts`).
 *
 * Scope: the claim CTA's two copy states. `vendors.verified` is the only public
 * signal that a listing is claimed (it is the AECI-519 grant's mirror), so it
 * drives the wording: an inactive vendor account gets "Claim this listing", an active
 * one gets "Request access to this listing" plus a note. The CTA is never
 * removed — seats are admin-granted and multi-seat, and self-serve invite is
 * deferred (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11), so the public claim form stays
 * the only route in for a second person at the vendor (and the only correction
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
    id: '00000000-0000-4000-8000-000000010001',
    slug: 'procore',
    company_name: 'Procore Technologies',
    logo_url: null,
    verified: false,
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
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      // Leaf analytics seams on the page's children (the external-link tracker,
      // the mailing-list band). Nothing here clicks, so neutral no-ops suffice.
      { provide: Analytics, useValue: { externalLinkClicked: vi.fn(), track: vi.fn() } },
      {
        provide: ActivatedRoute,
        useValue: { data: of({ vendor }), snapshot: { data: { vendor } } },
      },
    ],
  });
  const fixture = TestBed.createComponent(VendorDetailPage);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

// AECI-853 lockstep. This page shares DetailLayout, which now docks its sidebar
// at `lg` and so leaves the body column 608px wide. At the old 44rem the five
// column products table overflowed that by 96px and scrolled inside a narrow
// well. Measured worst case with a long product name AND a long category is
// 648px, so at 34rem the longest rows wrap one line instead of scrolling.
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
            primary_category: null,
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
    expect(marker!.textContent).toContain('Maintained by AEC Integrations');
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
    expect(marker!.textContent).toContain('Vendor-maintained · Updated September 16, 2026');
    expect(marker!.textContent).not.toContain('Maintained by AEC Integrations');
  });

  it('carries the date through to the AECi branch too', () => {
    const { el } = setup(
      buildVendor({
        maintenance: { maintained_by: 'aeci', last_reviewed_at: '2026-03-04T00:00:00.000Z' },
      }),
    );
    expect(el.querySelector('aec-maintenance-marker')!.textContent).toContain(
      'Maintained by AEC Integrations · Reviewed March 4, 2026',
    );
  });
});

describe('VendorDetailPage claim CTA', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const actions = (el: HTMLElement) =>
    el.querySelector('section[aria-labelledby="vendor-actions-label"]') as HTMLElement;

  it('offers to claim the listing when the vendor is unverified', () => {
    const { el } = setup(buildVendor());
    const section = actions(el);

    expect(section).toBeTruthy();
    expect(section.textContent).toContain('Claim this listing');
    expect(section.textContent).not.toContain('Request access to this listing');
    expect(section.textContent).not.toContain('Already managed through an active vendor account');
  });

  it('offers to request access when the vendor is verified', () => {
    const { el } = setup(buildVendor({ verified: true }));
    const section = actions(el);

    expect(section.textContent).toContain('Request access to this listing');
    expect(section.textContent).not.toContain('Claim this listing');
    expect(section.textContent).toContain('Already managed through an active vendor account');
  });

  it('keeps the CTA pointed at the same claim route in both states', () => {
    // Copy only: a claimed listing still submits `kind:'claim'` to the same
    // route, because that is the only seat/dispute path there is (§11).
    for (const verified of [false, true]) {
      TestBed.resetTestingModule();
      const { el } = setup(buildVendor({ verified }));
      const cta = actions(el).querySelector<HTMLAnchorElement>('a[href="/vendors/procore/claim"]');
      expect(cta).toBeTruthy();
    }
  });
});
