/**
 * AECI-1248 — the docs section index (`/docs/<section>`).
 *
 * `*.component.spec.ts` because the manifest imports `.md` files (see
 * `docs-page.component.spec.ts`).
 */
import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { docsSection } from './docs-content';
import { DocsSectionComponent } from './docs-section';

function render(section: string): { host: HTMLElement; title: Title; meta: Meta } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { data: { section } } } },
    ],
  });
  const fixture = TestBed.createComponent(DocsSectionComponent);
  fixture.detectChanges();
  return {
    host: fixture.nativeElement as HTMLElement,
    title: TestBed.inject(Title),
    meta: TestBed.inject(Meta),
  };
}

describe('DocsSectionComponent', () => {
  beforeEach(() => {
    document.head.querySelector('meta[name="robots"]')?.remove();
  });

  it('renders the section title, summary and every page with its description', () => {
    const { host } = render('vendors');
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent?.trim()).toBe('Vendor guide');

    const pages = docsSection('vendors');
    // The breadcrumb is the first `ol`; the page list is the last.
    const list = Array.from(host.querySelectorAll('ol')).at(-1)!;
    const links = Array.from(list.querySelectorAll('a')).map((a) => [
      a.textContent?.trim(),
      a.getAttribute('href'),
    ]);
    expect(links).toEqual(pages.map((page) => [page.title, page.path]));
    for (const page of pages) expect(list.textContent).toContain(page.description);
  });

  it('links the breadcrumb to Home and the docs home', () => {
    const { host } = render('reviewers');
    const crumbs = Array.from(host.querySelectorAll('nav[aria-label="Breadcrumb"] a')).map((a) =>
      a.getAttribute('href'),
    );
    expect(crumbs).toEqual(['/', '/docs']);
  });

  it('keeps the vendor guide index noindex (the bare /docs/vendors path)', () => {
    const { meta } = render('vendors');
    expect(meta.getTag('name="robots"')?.content).toBe('noindex');
  });

  it('leaves the reviewer guide index indexable, with title and canonical', () => {
    const { meta, title } = render('reviewers');
    expect(meta.getTag('name="robots"')).toBeNull();
    expect(title.getTitle()).toBe('Reviewer guide · AEC Integrations');
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toMatch(
      /\/docs\/reviewers$/,
    );
  });
});
