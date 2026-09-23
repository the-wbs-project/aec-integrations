/**
 * AECI-1104 — the `/docs` vendor guide: the manifest, the generated routes and
 * the article page.
 *
 * `*.component.spec.ts` (the Angular `ng test` tier) because the registry
 * imports `.md` files, and only the Angular build carries the esbuild `text`
 * loader. The `X-Robots-Tag` half of the noindex contract is pinned in
 * `src/server.spec.ts`; the `<meta name="robots">` half is pinned here.
 */
import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { DOCS_PAGES, docsSection, getDocsPage } from './docs-content';
import { DocsPageComponent } from './docs-page';
import { DOCS_ROUTES } from './docs.routes';

const VENDOR_SLUGS = [
  'claiming-your-listing',
  'your-seat',
  'attesting-an-integration',
  'owning-an-integration',
  'contests-and-protests',
  'plans-and-the-account-label',
];

function render(slug: string): { host: HTMLElement; title: Title; meta: Meta } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { data: { section: 'vendors', slug } } },
      },
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

describe('docs manifest', () => {
  it('lists the six vendor-guide pages in task order', () => {
    expect(docsSection('vendors').map((page) => page.slug)).toEqual(VENDOR_SLUGS);
    expect(DOCS_PAGES).toHaveLength(6);
  });

  it('gives every page a title, a description, a date and a unique order', () => {
    for (const page of DOCS_PAGES) {
      expect(page.title, page.slug).not.toBe('');
      expect(page.description, page.slug).not.toBe('');
      expect(page.lastUpdated, page.slug).toMatch(/^\d{1,2} \w+ \d{4}$/);
      expect(Number.isInteger(page.order), page.slug).toBe(true);
    }
    expect(new Set(DOCS_PAGES.map((page) => page.order)).size).toBe(DOCS_PAGES.length);
  });

  it('writes titles in sentence case', () => {
    for (const page of DOCS_PAGES) {
      const words = page.title.split(' ').slice(1);
      const capitalised = words.filter((w) => /^[A-Z][a-z]/.test(w));
      expect(capitalised, page.title).toEqual([]);
    }
  });

  it('ends every page with a Related section linking to its guide neighbours', () => {
    for (const page of DOCS_PAGES) {
      const doc = new DOMParser().parseFromString(page.html, 'text/html');
      const h2s = Array.from(doc.querySelectorAll('h2'));
      const last = h2s.at(-1);
      expect(last?.textContent, page.slug).toBe('Related');
      const links = Array.from(doc.querySelectorAll('h2:last-of-type ~ ul a')).map((a) =>
        a.getAttribute('href'),
      );
      const index = VENDOR_SLUGS.indexOf(page.slug);
      const neighbours = [VENDOR_SLUGS[index - 1], VENDOR_SLUGS[index + 1]].filter(Boolean);
      for (const slug of neighbours) {
        expect(links, `${page.slug} → ${slug}`).toContain(`/docs/vendors/${slug}`);
      }
    }
  });

  it('only links to docs pages that exist', () => {
    for (const page of DOCS_PAGES) {
      const doc = new DOMParser().parseFromString(page.html, 'text/html');
      for (const a of Array.from(doc.querySelectorAll('a[href^="/docs/"]'))) {
        const [, , section, slug] = (a.getAttribute('href') ?? '').split('#')[0].split('/');
        expect(
          getDocsPage(section, slug),
          `${page.slug} → ${a.getAttribute('href')}`,
        ).toBeDefined();
      }
    }
  });

  it('uses no em dashes and never calls the account label a Verified badge', () => {
    for (const page of DOCS_PAGES) {
      expect(page.html, page.slug).not.toContain('\u2014');
      // AECI-965 renamed the public label; "Verified badge" is retired copy.
      expect(page.html, page.slug).not.toMatch(/verified badge|verified vendor/i);
    }
  });

  it('carries no screenshots at v0', () => {
    for (const page of DOCS_PAGES) {
      expect(page.html, page.slug).not.toContain('<img');
    }
  });
});

describe('DOCS_ROUTES', () => {
  it('registers one explicit route per page, no :slug param', () => {
    expect(DOCS_ROUTES.map((route) => route.path)).toEqual(
      VENDOR_SLUGS.map((slug) => `vendors/${slug}`),
    );
    expect(DOCS_ROUTES.some((route) => route.path?.includes(':'))).toBe(false);
  });
});

describe('DocsPageComponent', () => {
  // The Angular vitest builder shares one jsdom <head> across specs.
  beforeEach(() => {
    document.head.querySelector('meta[name="robots"]')?.remove();
  });

  it.each(VENDOR_SLUGS)('renders %s with one h1, its body and the section rail', (slug) => {
    const { host } = render(slug);
    const page = getDocsPage('vendors', slug)!;
    const h1s = host.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent?.trim()).toBe(page.title);
    expect(host.querySelector('.aec-prose h2')).not.toBeNull();

    const rail = host.querySelectorAll('nav[aria-labelledby] a');
    expect(rail).toHaveLength(6);
    const current = host.querySelectorAll('nav[aria-labelledby] a[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].textContent?.trim()).toBe(page.title);
  });

  it('is noindex until the portal opens (AECI-1105) and sets title + canonical', () => {
    const { title, meta } = render('your-seat');
    expect(meta.getTag('name="robots"')?.content).toBe('noindex');
    expect(title.getTitle()).toBe('Your seat · AEC Integrations');
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toMatch(
      /\/docs\/vendors\/your-seat$/,
    );
  });
});
