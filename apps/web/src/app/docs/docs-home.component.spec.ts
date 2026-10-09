/**
 * AECI-1248, AECI-1259 — the docs home (`/docs`), restyled as plain lists.
 *
 * `*.component.spec.ts` because the manifest imports `.md` files (see
 * `docs-page.component.spec.ts`).
 */
import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { DOCS_PAGES, docsSectionsInGuide } from './docs-content';
import { DocsHomeComponent } from './docs-home';

function render(): { host: HTMLElement; title: Title; meta: Meta } {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(DocsHomeComponent);
  fixture.detectChanges();
  return {
    host: fixture.nativeElement as HTMLElement,
    title: TestBed.inject(Title),
    meta: TestBed.inject(Meta),
  };
}

describe('DocsHomeComponent', () => {
  beforeEach(() => {
    document.head.querySelector('meta[name="robots"]')?.remove();
  });

  it('renders one h1 and an intro', () => {
    const { host } = render();
    const h1s = host.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent?.trim()).toBe('Help center');
  });

  // AECI-1259: DeepWiki restraint. Divided lists, no bordered cards.
  it('renders the audience split as a divided list, not cards', () => {
    const { host } = render();
    const groups = Array.from(host.querySelectorAll('[data-audience]'));
    expect(groups[0].parentElement?.classList).toContain('divide-y');
    for (const group of groups) {
      expect(group.classList, group.getAttribute('data-audience') ?? '').not.toContain(
        'rounded-lg',
      );
      expect(group.classList).not.toContain('bg-(--surface-raised)');
    }
  });

  it('splits by audience, dropping any audience with no pages yet', () => {
    const { host } = render();
    const groups = Array.from(host.querySelectorAll('[data-audience]'));
    // AECI-1265: the "Listing your products" role card gave way to "For vendors".
    expect(groups.map((g) => g.getAttribute('data-audience'))).toEqual(['reader', 'reviewer']);
    expect(host.textContent).not.toContain('Listing your products');
    expect(Array.from(groups[0].querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      '/docs/getting-started',
      '/docs/trust',
    ]);
    expect(Array.from(groups[1].querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      '/docs/reviewers',
      '/docs/account',
    ]);
  });

  it('lists every help-center section with its pages, and no empty section', () => {
    const { host } = render();
    const sections = Array.from(host.querySelectorAll('[data-section]'));
    expect(sections.map((s) => s.getAttribute('data-section'))).toEqual([
      'getting-started',
      'trust',
      'reviewers',
      'account',
      'for-vendors',
    ]);
    const hrefs = sections.flatMap((s) =>
      Array.from(s.querySelectorAll('a')).map((a) => a.getAttribute('href')),
    );
    for (const section of docsSectionsInGuide('help')) {
      for (const page of section.pages) expect(hrefs, page.path).toContain(page.path);
    }
    for (const empty of ['faq']) {
      expect(host.querySelector(`a[href^="/docs/${empty}"]`), empty).toBeNull();
    }
  });

  // AECI-1265: the vendor guide is listed on neither the home nor its sidebar.
  it('never links the vendor guide, and lists "For vendors" with its two pages', () => {
    const { host } = render();
    expect(host.querySelector('[data-section="vendors"]')).toBeNull();
    expect(host.querySelector('a[href="/docs/vendors"]')).toBeNull();
    for (const page of DOCS_PAGES.filter((entry) => entry.section === 'vendors')) {
      expect(host.querySelector(`a[href="${page.path}"]`), page.slug).toBeNull();
    }
    const forVendors = host.querySelector('[data-section="for-vendors"]')!;
    expect(Array.from(forVendors.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual(
      ['/docs/vendors/overview', '/docs/vendors/claiming-your-listing'],
    );
  });

  it('is indexable, with title and canonical', () => {
    const { meta, title } = render();
    expect(meta.getTag('name="robots"')).toBeNull();
    expect(title.getTitle()).toBe('Help center · AEC Integrations');
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toMatch(
      /\/docs$/,
    );
  });
});
