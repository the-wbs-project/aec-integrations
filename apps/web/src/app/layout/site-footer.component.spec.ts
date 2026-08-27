import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { SiteFooter } from './site-footer';

/**
 * The footer is **load-bearing for secondary navigation**, which it was not when
 * it last went untested. Retiring the header's "More" overflow menu made this the
 * only place Updates, Roadmap, About, Contact and the four Legal pages are linked
 * from every page (DESIGN.md §Navigation → The Overflow Rule). A link silently
 * dropping out of a column is now a regression, not a tidy-up — so the columns
 * are pinned here.
 *
 * The second guarantee is cache-safety: unlike the header, the footer holds no
 * visitor state at all. It renders identically for everyone, which is what lets
 * it sit inside URL-keyed cached HTML. Nothing role-gated may appear here.
 */
describe('SiteFooter', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
  });

  function render(): HTMLElement {
    const fixture = TestBed.createComponent(SiteFooter);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  /** The hrefs in one labelled `<nav>`, in document order. */
  function column(el: HTMLElement, label: string): string[] {
    const nav = el.querySelector(`nav[aria-label="${label}"]`);
    expect(nav, `no <nav aria-label="${label}">`).not.toBeNull();
    return Array.from(nav!.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
  }

  it('carries the Directory column', () => {
    // Vendors / Integrations are deliberately absent (AECI-160/165) — the index
    // pages were removed and now 301 to /products.
    expect(column(render(), 'Directory')).toEqual([
      '/',
      '/products',
      '/categories',
      '/audiences',
      '/trades',
      '/phases',
    ]);
  });

  it('carries all four Legal pages', () => {
    expect(column(render(), 'Legal')).toEqual([
      '/legal/terms',
      '/legal/privacy',
      '/legal/review-guidelines',
      '/legal/listing-accuracy',
    ]);
  });

  it('carries Company including Updates and Roadmap', () => {
    // Updates and Roadmap were the only two links the footer lacked when it
    // absorbed the header's "More" menu. They must not drift back out: the
    // header no longer links either, so this is their sole site-wide entry.
    expect(column(render(), 'Company')).toEqual(['/about', '/contact', '/updates', '/roadmap']);
  });

  it('names every column for assistive tech and renders no role-gated link', () => {
    const el = render();
    const labels = Array.from(el.querySelectorAll('nav')).map((n) => n.getAttribute('aria-label'));
    expect(labels).toEqual(['Directory', 'Legal', 'Company']);

    // The footer is inside cached, URL-keyed HTML — it must be visitor-neutral.
    expect(el.querySelectorAll('a[href^="/admin"]').length).toBe(0);
    expect(el.querySelectorAll('a[href^="/vendor"]').length).toBe(0);
    expect(el.querySelectorAll('a[href^="/account"]').length).toBe(0);
  });
});
