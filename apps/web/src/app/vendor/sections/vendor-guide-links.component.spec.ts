/**
 * AECI-1253 item 3: the guide links on the two section pages that have no spec
 * of their own, Seats and Messages. Their child components each fetch, so they
 * are stubbed out here: the test is about the page's own template, and the
 * children's links (the contests list on Messages) are pinned in their specs.
 */
import { NO_ERRORS_SCHEMA, provideZonelessChangeDetection, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, it } from 'vitest';

import { VendorDocsLink } from '../components/vendor-docs-link';
import { expectVendorDocsLink } from '../components/vendor-docs-link.testing';
import { VendorApi } from '../vendor-api';
import { VENDOR_ME_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorMessagesPage } from './vendor-messages-page';
import { VendorSeatsPage } from './vendor-seats-page';

const ONLY_THE_LINK = { set: { imports: [VendorDocsLink], schemas: [NO_ERRORS_SCHEMA] } };

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: VendorApi, useValue: {} },
      VendorPortalStore,
    ],
  });
  TestBed.overrideComponent(VendorSeatsPage, ONLY_THE_LINK);
  TestBed.overrideComponent(VendorMessagesPage, ONLY_THE_LINK);
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
