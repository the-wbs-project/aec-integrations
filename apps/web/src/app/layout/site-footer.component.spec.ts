import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { ACCESSIBILITY_STATEMENT_PUBLISHED } from '../accessibility/accessibility-published';
import { SiteFooter } from './site-footer';

/**
 * The footer is **load-bearing for secondary navigation**, which it was not when
 * it last went untested. Retiring the header's "More" overflow menu made this the
 * only place Updates, Roadmap, About, Contact, the Legal pages and the help
 * center are linked from every page (DESIGN.md §Navigation → The Overflow Rule). A link silently
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

  it('sits on the Forest footer ground with Bone ink (AECI-1776)', () => {
    const footer = render().querySelector('footer')!;
    expect(footer.className).toContain('bg-(--surface-footer)');
    expect(footer.className).toContain('text-(--text-on-brand)');
    expect(footer.className).not.toContain('--surface-base');
  });

  it('uses the on-dark wordmark', () => {
    const img = render().querySelector('aec-brand-logo img')!;
    expect(img.getAttribute('src')).toContain('wordmark-on-dark');
  });

  it('keeps column labels as overline paragraphs, not headings', () => {
    const el = render();
    expect(el.querySelectorAll('h1, h2, h3, h4, h5, h6').length).toBe(0);
    const labels = Array.from(el.querySelectorAll('nav > p'));
    expect(labels.length).toBe(4);
    for (const p of labels) {
      expect(p.className).toContain('aec-overline');
      expect(p.className).toContain('text-(--text-on-footer-secondary)');
    }
  });

  it('links the third-party notices as a plain href after the legal links', () => {
    const legal = column(render(), 'Legal');
    expect(legal[legal.length - 1]).toBe('/third-party-notices.txt');
    const link = render().querySelector('a[href="/third-party-notices.txt"]')!;
    expect(link.textContent?.trim()).toBe('Third-party notices');
    expect(link.getAttribute('target')).toBeNull();
  });

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

  it('carries the Help column into /docs (AECI-1252, AECI-1253)', () => {
    // STAGE_2_PRODUCT_DOCS_SPEC.md §7 question 3: the help center is footer-only,
    // as its own column. The vendor guide joined it when AECI-1253 made
    // /docs/vendors indexable.
    expect(column(render(), 'Help')).toEqual([
      '/docs',
      '/docs/getting-started',
      '/docs/trust/how-ranking-works',
      '/docs/vendors/overview',
    ]);
  });

  it('labels the vendor guide link "Vendor guide", not "For vendors" (AECI-1253)', () => {
    // "For vendors" is the Company column's link to /vendor-program (AECI-1283).
    // Two links with one name and two destinations would confuse a screen
    // reader's links list.
    const help = render().querySelector('nav[aria-label="Help"]');
    const link = help?.querySelector('a[href="/docs/vendors/overview"]');
    expect(link?.textContent?.trim()).toBe('Vendor guide');
  });

  it('carries all six Legal pages, then the accessibility statement once published (AECI-1673, AECI-1687)', () => {
    expect(column(render(), 'Legal')).toEqual([
      '/legal/terms',
      '/legal/privacy',
      '/legal/review-guidelines',
      '/legal/listing-accuracy',
      '/legal/vendor-terms',
      '/legal/managed-plan-agreement',
      ...(ACCESSIBILITY_STATEMENT_PUBLISHED ? ['/accessibility'] : []),
      '/third-party-notices.txt',
    ]);
  });

  it('carries Company including Methodology, Updates and Roadmap', () => {
    // Updates and Roadmap were the only two links the footer lacked when it
    // absorbed the header's "More" menu. They must not drift back out: the
    // header no longer links either, so this is their sole site-wide entry.
    // /methodology (AECI-804) sits next to /about because it is the same kind of
    // destination — how the directory works — and the footer is its only
    // site-wide entry too (the header is public-directory-only by the DESIGN.md
    // Overflow Rule, and `site-header.component.spec.ts` asserts its absence).
    // "For vendors" (/vendor-program, AECI-1283) follows Methodology, per
    // VENDOR_PROGRAM_PAGE_SPEC.md §2.4. The footer is its only site-wide entry.
    expect(column(render(), 'Company')).toEqual([
      '/about',
      '/methodology',
      '/vendor-program',
      '/contact',
      '/updates',
      '/roadmap',
    ]);
  });

  it('labels the vendor landing page link "For vendors" (AECI-1283)', () => {
    const company = render().querySelector('nav[aria-label="Company"]');
    const link = company?.querySelector('a[href="/vendor-program"]');
    expect(link?.textContent?.trim()).toBe('For vendors');
  });

  it('names every column for assistive tech and renders no role-gated link', () => {
    const el = render();
    const labels = Array.from(el.querySelectorAll('nav')).map((n) => n.getAttribute('aria-label'));
    expect(labels).toEqual(['Directory', 'Help', 'Legal', 'Company']);

    // The footer is inside cached, URL-keyed HTML — it must be visitor-neutral.
    expect(el.querySelectorAll('a[href^="/admin"]').length).toBe(0);
    // The portal is `/vendor` and `/vendor/*`. The public `/vendor-program` landing
    // page (AECI-1283) shares the prefix but is not role-gated, so match by segment.
    expect(el.querySelectorAll('a[href="/vendor"], a[href^="/vendor/"]').length).toBe(0);
    expect(el.querySelectorAll('a[href^="/account"]').length).toBe(0);
  });
});
