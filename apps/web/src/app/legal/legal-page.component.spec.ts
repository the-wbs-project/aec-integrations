import { Title } from '@angular/platform-browser';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { LegalPage } from './legal-page';
import type { LegalSlug } from './legal-content';

function render(slug: LegalSlug): { host: HTMLElement; title: Title } {
  // Reset first so a test can render several slugs in sequence (each needs a
  // fresh, not-yet-instantiated module).
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { data: { slug } } } },
    ],
  });
  const fixture = TestBed.createComponent(LegalPage);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, title: TestBed.inject(Title) };
}

describe('LegalPage', () => {
  it('renders the frontmatter title as the single h1 and the version metadata', () => {
    const { host } = render('terms');
    const h1s = host.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toContain('Terms of Service');
    // Frontmatter version line (§27.1: version shown at the top).
    expect(host.textContent).toContain('Version 1.0');
  });

  it('hides the effective-date chip while the draft frontmatter leaves it blank', () => {
    const { host } = render('terms');
    expect(host.textContent).not.toContain('Effective');
    // Last-updated is always present.
    expect(host.textContent).toContain('Last updated');
  });

  it('renders the Markdown body (sanitized) into .legal-prose with headings, lists, and links', () => {
    const { host } = render('terms');
    const article = host.querySelector('article.legal-prose');
    expect(article).not.toBeNull();
    // marked produced block structure the global .legal-prose styles target.
    expect(article!.querySelector('h2')).not.toBeNull();
    expect(article!.querySelector('ul')).not.toBeNull();
    expect(article!.querySelector('blockquote')?.textContent).toContain('pending legal review');
    // The sanitizer keeps anchor hrefs, so internal cross-links survive.
    expect(article!.querySelector('a[href="/legal/review-guidelines"]')).not.toBeNull();
  });

  it('routes review reports to the reviews@ alias (AECI-307), not the founders@ catch-all', () => {
    const { host } = render('review-guidelines');
    const article = host.querySelector('article.legal-prose');
    expect(article!.querySelector('a[href="mailto:reviews@thewbsproject.com"]')).not.toBeNull();
    // The review-report path must not fall back to the general contact address.
    expect(article!.querySelector('a[href="mailto:founders@thewbsproject.com"]')).toBeNull();
  });

  it('sets the per-slug document title chrome via MetaService', () => {
    expect(render('terms').title.getTitle()).toBe('Terms of Service · AEC Integrations');
    expect(render('privacy').title.getTitle()).toBe('Privacy Policy · AEC Integrations');
    expect(render('review-guidelines').title.getTitle()).toBe(
      'Review Guidelines · AEC Integrations',
    );
    expect(render('listing-accuracy').title.getTitle()).toBe(
      'Listing Accuracy Policy · AEC Integrations',
    );
  });

  it('writes a self-referential canonical link for the slug', () => {
    render('privacy');
    const link = document.head.querySelector('link[rel="canonical"]');
    expect(link?.getAttribute('href')).toMatch(/\/legal\/privacy$/);
  });
});
