/**
 * AECI-1104, AECI-1248 — the docs article page: body, section rail, linked
 * breadcrumbs, the prev/next pager, and noindex by path.
 *
 * `*.component.spec.ts` (the Angular `ng test` tier) because the registry
 * imports `.md` files, and only the Angular build carries the esbuild `text`
 * loader. The manifest itself is pinned in `docs-content.component.spec.ts`.
 * The `X-Robots-Tag` half of the noindex contract is pinned in
 * `src/server.spec.ts`; the `<meta name="robots">` half is pinned here.
 */
import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { docsSection, getDocsPage } from './docs-content';
import { DocsPageComponent } from './docs-page';

const VENDOR_SLUGS = docsSection('vendors').map((page) => page.slug);

function render(section: string, slug: string): { host: HTMLElement; title: Title; meta: Meta } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { data: { section, slug } } } },
    ],
  });
  const fixture = TestBed.createComponent(DocsPageComponent);
  fixture.detectChanges();
  return {
    host: fixture.nativeElement as HTMLElement,
    title: TestBed.inject(Title),
    meta: TestBed.inject(Meta),
  };
}

function pager(host: HTMLElement): HTMLElement | null {
  return host.querySelector('nav[aria-label="Previous and next articles"]');
}

describe('DocsPageComponent', () => {
  // The Angular vitest builder shares one jsdom <head> across specs.
  beforeEach(() => {
    document.head.querySelector('meta[name="robots"]')?.remove();
  });

  it.each(VENDOR_SLUGS)('renders %s with one h1, its body and the section rail', (slug) => {
    const { host } = render('vendors', slug);
    const page = getDocsPage('vendors', slug)!;
    const h1s = host.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent?.trim()).toBe(page.title);
    expect(host.querySelector('.aec-prose h2')).not.toBeNull();

    const rail = host.querySelectorAll('nav[aria-labelledby] a');
    expect(rail).toHaveLength(VENDOR_SLUGS.length);
    const current = host.querySelectorAll('nav[aria-labelledby] a[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent?.trim()).toBe(page.title);
  });

  it('links the breadcrumb up to the docs home and the section index', () => {
    const { host } = render('vendors', 'your-seat');
    const crumbs = Array.from(host.querySelectorAll('nav[aria-label="Breadcrumb"] a')).map((a) => [
      a.textContent?.trim(),
      a.getAttribute('href'),
    ]);
    expect(crumbs).toEqual([
      ['Home', '/'],
      ['Docs', '/docs'],
      ['Vendor guide', '/docs/vendors'],
    ]);
  });

  it('shows only Next on the first page of a section', () => {
    const { host } = render('vendors', VENDOR_SLUGS[0]);
    const links = pager(host)!.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('rel')).toBe('next');
    expect(links[0].getAttribute('href')).toBe(`/docs/vendors/${VENDOR_SLUGS[1]}`);
    expect(links[0].textContent).toContain('Next');
  });

  it('shows Previous and Next in the middle of a section', () => {
    const { host } = render('vendors', VENDOR_SLUGS[2]);
    const links = Array.from(pager(host)!.querySelectorAll('a'));
    expect(links.map((a) => [a.getAttribute('rel'), a.getAttribute('href')])).toEqual([
      ['prev', `/docs/vendors/${VENDOR_SLUGS[1]}`],
      ['next', `/docs/vendors/${VENDOR_SLUGS[3]}`],
    ]);
    expect(links[0].textContent).toContain(getDocsPage('vendors', VENDOR_SLUGS[1])!.title);
  });

  it('stops at the end of a section rather than crossing into the next one', () => {
    const { host } = render('vendors', VENDOR_SLUGS.at(-1)!);
    const links = pager(host)!.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('rel')).toBe('prev');
  });

  it('renders no pager on a section with one page', () => {
    const { host } = render('reviewers', 'requests-and-corrections');
    expect(pager(host)).toBeNull();
  });

  it('is noindex on the vendor guide until AECI-1253 and sets title + canonical', () => {
    const { title, meta } = render('vendors', 'your-seat');
    expect(meta.getTag('name="robots"')?.content).toBe('noindex');
    expect(title.getTitle()).toBe('Your seat · AEC Integrations');
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toMatch(
      /\/docs\/vendors\/your-seat$/,
    );
  });

  it('is indexable outside the noindex prefixes (the reviewer guide)', () => {
    const { meta, host } = render('reviewers', 'requests-and-corrections');
    expect(meta.getTag('name="robots"')).toBeNull();
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toMatch(
      /\/docs\/reviewers\/requests-and-corrections$/,
    );
    expect(host.querySelector('h1')?.textContent?.trim()).toBe('Requests and corrections');
  });
});
