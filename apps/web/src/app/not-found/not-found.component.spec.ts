/**
 * Component test for the global `NotFound` surface (AECI-62 / Phase 2.16).
 * Verifies the rendered template carries the recovery links and the page-level
 * a11y handles (single h1 + aria-labelledby).
 *
 * AECI-165 removed the `/vendors` and `/integrations` index pages, so the
 * recovery cards point at the taxonomy-first entry points (/products,
 * /categories, /audiences, /phases) — the same set the footer Directory
 * surfaces — rather than the removed vendor/integration listings.
 */
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { NotFound } from './not-found';

function render() {
  TestBed.configureTestingModule({
    imports: [NotFound],
    providers: [provideRouter([])],
  });
  const fixture = TestBed.createComponent(NotFound);
  fixture.detectChanges();
  return fixture;
}

describe('NotFound component', () => {
  it('renders an h1 labelled by the section heading', () => {
    const el = render().nativeElement as HTMLElement;
    const section = el.querySelector('section[aria-labelledby="not-found-title"]');
    expect(section).not.toBeNull();
    const h1 = section!.querySelector('h1#not-found-title');
    expect(h1).not.toBeNull();
    // Only one h1 on the surface so screen readers don't compete with the
    // shell's site header.
    expect(el.querySelectorAll('h1')).toHaveLength(1);
  });

  it('exposes the four taxonomy-first recovery links plus the home CTA', () => {
    const el = render().nativeElement as HTMLElement;
    const hrefs = Array.from(el.querySelectorAll('a[href]')).map((a) => a.getAttribute('href'));
    // AECI-165 — vendor/integration index cards replaced by audiences/phases.
    expect(hrefs).toEqual(
      expect.arrayContaining(['/products', '/categories', '/audiences', '/trades', '/phases', '/']),
    );
    // The removed indexes must not reappear as recovery links.
    expect(hrefs).not.toContain('/vendors');
    expect(hrefs).not.toContain('/integrations');
  });

  it('groups recovery links inside a labelled nav landmark', () => {
    const el = render().nativeElement as HTMLElement;
    const nav = el.querySelector('nav[aria-labelledby="not-found-recovery"]');
    expect(nav).not.toBeNull();
    // Each of the five directory links is in the list (products + the four
    // taxonomy facets), plus the home CTA which sits outside the directory nav.
    expect(nav!.querySelectorAll('li a')).toHaveLength(5);
  });
});
