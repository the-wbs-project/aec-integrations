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

  it('sits on white: no Forest ground, the commitments are shared cards (AECI-1800)', () => {
    const h = setup();
    expect(h.querySelector('[class*="bg-(--accent-primary)"]')).toBeNull();
    const list = h.querySelector('ul');
    expect(list?.classList).toContain('aec-card-grid');
    for (const li of Array.from(h.querySelectorAll('li'))) {
      expect(li.classList).toContain('aec-card');
      expect(li.classList).toContain('shadow-card');
      // Not a link, so the card does not lift.
      expect(li.className).not.toContain('translate-y');
    }
  });

  it('is a static band — no rotation, no controls', () => {
    const h = setup();
    // All content present at once; no single-slide panel and no buttons to drive.
    expect(h.querySelectorAll('button')).toHaveLength(0);
    expect(h.querySelector('[aria-roledescription="carousel"]')).toBeNull();
  });
});
