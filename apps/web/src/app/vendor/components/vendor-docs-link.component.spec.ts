/**
 * AECI-1253 item 3: the portal's "Learn more" links into the vendor guide.
 *
 * The link keeps its own copy of each page title, so the bundle does not carry
 * the docs manifest. These tests are what keep that copy honest: a slug that
 * stops resolving, or a title that drifts from the page's frontmatter, fails
 * here rather than shipping a dead link or a wrong accessible name.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDocsPageByPath } from '../../docs/docs-content';
import { ViewPublicLink } from '../../shared/view-public-link/view-public-link';

import {
  STANDALONE_LINK_CLASS,
  VENDOR_GUIDE_PAGES,
  VendorDocsLink,
  type VendorGuidePage,
} from './vendor-docs-link';
import { expectVendorDocsLink } from './vendor-docs-link.testing';

@Component({
  selector: 'aec-vendor-docs-link-host',
  imports: [VendorDocsLink],
  template: `<aec-vendor-docs-link [page]="page()" />`,
})
class Host {
  readonly page = signal<VendorGuidePage>('your-seat');
}

const PAGES = Object.keys(VENDOR_GUIDE_PAGES) as VendorGuidePage[];

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
});

describe('VendorDocsLink', () => {
  it.each(PAGES)('links %s as a new-tab "Learn more" named after the page', (page) => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.page.set(page);
    fixture.detectChanges();

    expectVendorDocsLink(fixture.nativeElement as HTMLElement, page);
  });

  it.each(PAGES)('points %s at a vendor-guide page whose title it repeats', (page) => {
    const docsPage = getDocsPageByPath(`/docs/vendors/${page}`);

    expect(docsPage, `no vendor-guide page at /docs/vendors/${page}`).toBeDefined();
    expect(VENDOR_GUIDE_PAGES[page]()).toBe(docsPage?.title);
  });

  // AECI-1811: the link is the standalone role as `aec-view-public-link` draws it.
  // The shared component exports no class, so the portal keeps one copy and this
  // fails the day the two spellings drift apart.
  it('draws the same standalone link as aec-view-public-link', () => {
    const fixture = TestBed.createComponent(ViewPublicLink);
    fixture.componentRef.setInput('href', '/products/revit');
    fixture.detectChanges();
    const shared = (fixture.nativeElement as HTMLElement).querySelector('a') as HTMLAnchorElement;
    const docs = TestBed.createComponent(Host);
    docs.detectChanges();
    const ours = (docs.nativeElement as HTMLElement).querySelector('a') as HTMLAnchorElement;

    const classes = (el: Element) => [...el.classList].sort();
    expect(classes(ours)).toEqual(classes(shared));
    expect(classes(ours)).toEqual(STANDALONE_LINK_CLASS.split(' ').sort());
  });
});
