/**
 * AECI-1253 item 3 and AECI-1251: the guide links on the section pages that have
 * no spec of their own: Seats, Messages, Vendor Overview, the company Profile and
 * a product's Profile. Their child components each fetch, so they are stubbed
 * out here: the test is about the page's own template, and the children's links
 * (the contests list on Messages, the checklist card) are pinned in their specs.
 */
import { NO_ERRORS_SCHEMA, provideZonelessChangeDetection, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, it } from 'vitest';

import { VendorDocsLink } from '../components/vendor-docs-link';
import { expectVendorDocsLink } from '../components/vendor-docs-link.testing';
import { VendorApi } from '../vendor-api';
import { VENDOR_ME_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorMessagesPage } from './vendor-messages-page';
import { VendorOverviewSection } from './vendor-overview-section';
import { VendorProductProfilePage } from './vendor-product-profile-page';
import { VendorProfileSection } from './vendor-profile-section';
import { VendorSeatsPage } from './vendor-seats-page';

const ONLY_THE_LINK = { set: { imports: [VendorDocsLink], schemas: [NO_ERRORS_SCHEMA] } };

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: VendorApi, useValue: {} },
      VendorPortalStore,
    ],
  });
  TestBed.overrideComponent(VendorSeatsPage, ONLY_THE_LINK);
  TestBed.overrideComponent(VendorMessagesPage, ONLY_THE_LINK);
  TestBed.overrideComponent(VendorOverviewSection, ONLY_THE_LINK);
  TestBed.overrideComponent(VendorProfileSection, ONLY_THE_LINK);
  TestBed.overrideComponent(VendorProductProfilePage, ONLY_THE_LINK);
  TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
});

function render<T>(type: Type<T>): HTMLElement {
  const fixture = TestBed.createComponent(type);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('portal guide links (AECI-1253)', () => {
  it('Seats links Your seat', () => {
    expectVendorDocsLink(render(VendorSeatsPage), 'your-seat');
  });

  it('Messages links Claiming your vendor listing at the claim status', () => {
    expectVendorDocsLink(render(VendorMessagesPage), 'claiming-your-listing');
  });
});

describe('portal guide links (AECI-1251)', () => {
  it('Messages links Notifications and messages under its intro', () => {
    expectVendorDocsLink(render(VendorMessagesPage), 'notifications-and-messages');
  });

  it('Vendor Overview links Your dashboard', () => {
    expectVendorDocsLink(render(VendorOverviewSection), 'your-dashboard');
  });

  it('the company Profile links Editing your profile and products', () => {
    expectVendorDocsLink(render(VendorProfileSection), 'editing-profile-and-products');
  });

  it("a product's Profile links Editing your profile and products", () => {
    expectVendorDocsLink(render(VendorProductProfilePage), 'editing-profile-and-products');
  });
});
