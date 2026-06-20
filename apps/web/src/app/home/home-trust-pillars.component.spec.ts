import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { HomeTrustPillars } from './home-trust-pillars';

function setup(): HTMLElement {
  TestBed.configureTestingModule({});
  const fixture = TestBed.createComponent(HomeTrustPillars);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('HomeTrustPillars', () => {
  it('states the trust headline as the section heading', () => {
    expect(setup().querySelector('h2')?.textContent?.trim()).toBe('Trust is the product');
  });

  it('renders the three commitments as cards, each with a heading', () => {
    const cards = Array.from(setup().querySelectorAll('li'));
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.querySelector('h3')?.textContent?.trim())).toEqual([
      'Never sell rankings',
      'Always be transparent',
      'Never review products ourselves',
    ]);
  });

  it('is a static band — no rotation, no controls', () => {
    const h = setup();
    // All content present at once; no single-slide panel and no buttons to drive.
    expect(h.querySelectorAll('button')).toHaveLength(0);
    expect(h.querySelector('[aria-roledescription="carousel"]')).toBeNull();
  });
});
