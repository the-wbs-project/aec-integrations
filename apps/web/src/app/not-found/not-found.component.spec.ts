/**
 * Component test for the global `NotFound` surface (AECI-62 / Phase 2.16).
 * Verifies the rendered template carries the recovery links the
 * acceptance criteria pin (/products, /vendors, /integrations,
 * /categories) and the page-level a11y handles (single h1 +
 * aria-labelledby).
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

  it('exposes the four AC-pinned recovery links plus the home CTA', () => {
    const el = render().nativeElement as HTMLElement;
    const hrefs = Array.from(el.querySelectorAll('a[href]')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(
      expect.arrayContaining(['/products', '/vendors', '/integrations', '/categories', '/']),
    );
  });

  it('groups recovery links inside a labelled nav landmark', () => {
    const el = render().nativeElement as HTMLElement;
    const nav = el.querySelector('nav[aria-labelledby="not-found-recovery"]');
    expect(nav).not.toBeNull();
    // Each of the four directory links is in the list, plus the home CTA
    // sits outside the directory nav.
    expect(nav!.querySelectorAll('li a')).toHaveLength(4);
  });
});
