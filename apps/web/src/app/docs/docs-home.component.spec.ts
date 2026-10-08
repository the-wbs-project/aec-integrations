/**
 * AECI-1248 — the docs home (`/docs`).
 *
 * `*.component.spec.ts` because the manifest imports `.md` files (see
 * `docs-page.component.spec.ts`).
 */
import { TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { DOCS_PAGES } from './docs-content';
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

  it('splits by audience, dropping any audience with no pages yet', () => {
    const { host } = render();
    const groups = Array.from(host.querySelectorAll('[data-audience]'));
    expect(groups.map((g) => g.getAttribute('data-audience'))).toEqual([
      'reader',
      'vendor',
      'reviewer',
    ]);
    expect(Array.from(groups[0].querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      '/docs/getting-started',
      '/docs/trust',
    ]);
    expect(Array.from(groups[1].querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      '/docs/vendors',
    ]);
    expect(Array.from(groups[2].querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      '/docs/reviewers',
    ]);
  });

  it('lists every non-empty section with its pages, and no empty section', () => {
    const { host } = render();
    const sections = Array.from(host.querySelectorAll('[data-section]'));
    expect(sections.map((s) => s.getAttribute('data-section'))).toEqual([
      'getting-started',
      'trust',
      'vendors',
      'reviewers',
    ]);
    const hrefs = sections.flatMap((s) =>
      Array.from(s.querySelectorAll('a')).map((a) => a.getAttribute('href')),
    );
    for (const page of DOCS_PAGES) expect(hrefs, page.path).toContain(page.path);
    for (const empty of ['account', 'faq']) {
      expect(host.querySelector(`a[href^="/docs/${empty}"]`), empty).toBeNull();
    }
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
