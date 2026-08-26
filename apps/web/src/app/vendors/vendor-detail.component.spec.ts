/**
 * VendorDetailPage — the Actions-sidebar claim CTA.
 *
 * Named `.component.spec.ts` so it runs under `ng test` (Angular's TestBed /
 * vitest runner) rather than the node-only Vitest pass that excludes Angular DI
 * (see `apps/web/vitest.config.ts`).
 *
 * Scope: the claim CTA's two copy states. `vendors.verified` is the only public
 * signal that a listing is claimed (it is the AECI-519 grant's mirror), so it
 * drives the wording: an unverified vendor gets "Claim this listing", a verified
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
    expect(section.textContent).not.toContain('Already managed by a verified vendor');
  });

  it('offers to request access when the vendor is verified', () => {
    const { el } = setup(buildVendor({ verified: true }));
    const section = actions(el);

    expect(section.textContent).toContain('Request access to this listing');
    expect(section.textContent).not.toContain('Claim this listing');
    expect(section.textContent).toContain('Already managed by a verified vendor');
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
