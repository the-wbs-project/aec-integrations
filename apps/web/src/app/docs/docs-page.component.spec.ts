/**
 * AECI-1104, AECI-1248, AECI-1259 — the docs article page: body, heading ids,
 * the prev/next pager, and noindex by path. The sidebar, the breadcrumb and the
 * rail's place on the page live in the shell (`docs-shell.component.spec.ts`).
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

  it.each(VENDOR_SLUGS)('renders %s with one h1 and its body', (slug) => {
    const { host } = render('vendors', slug);
    const page = getDocsPage('vendors', slug)!;
    const h1s = host.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent?.trim()).toBe(page.title);
    expect(host.querySelector('.aec-prose h2')).not.toBeNull();
    // The quiet DeepWiki header: no overline above the title.
    expect(host.querySelector('header .aec-overline')).toBeNull();
  });

  // The sanitizer strips ids from [innerHTML], so the template renders headings.
  it('renders every h2 with its manifest id, in order, Related last', () => {
    const { host } = render('vendors', 'owning-an-integration');
    const page = getDocsPage('vendors', 'owning-an-integration')!;
    const h2s = Array.from(host.querySelectorAll('.aec-prose h2')).map((h) => [
      h.id,
      h.textContent?.trim(),
    ]);
    expect(h2s).toEqual([...page.headings.map((h) => [h.id, h.text]), ['related', 'Related']]);
    // The in-content deep link from contests-and-protests lands here.
    expect(host.querySelector('#if-aec-integrations-changes-something-you-hold')?.tagName).toBe(
      'H2',
    );
  });

  // The body between headings still renders, links and lists included.
  it('keeps the body HTML between the headings', () => {
    const { host } = render('trust', 'how-ranking-works');
    const prose = host.querySelector('.aec-prose')!;
    expect(prose.querySelector('a[href="/search"]')).not.toBeNull();
    expect(prose.querySelectorAll('ul').length).toBeGreaterThan(2);
    expect(prose.textContent).toContain('No plan, at any price, changes');
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

  // No section has a single page since AECI-1250, so the no-pager case is covered
  // by the synthetic-manifest `docsNeighbours` spec in docs-content.component.spec.ts.
  it('does not page from the reviewer guide into the account section', () => {
    const { host } = render('reviewers', 'requests-and-corrections');
    const links = Array.from(pager(host)!.querySelectorAll('a'));
    expect(links.map((a) => [a.getAttribute('rel'), a.getAttribute('href')])).toEqual([
      ['prev', '/docs/reviewers/writing-a-review'],
    ]);
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
