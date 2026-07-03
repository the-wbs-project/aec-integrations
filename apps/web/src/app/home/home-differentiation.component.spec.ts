import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { HomeDifferentiation } from './home-differentiation';

function setup(): HTMLElement {
  TestBed.configureTestingModule({});
  const fixture = TestBed.createComponent(HomeDifferentiation);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('HomeDifferentiation', () => {
  it('leads with the differentiation headline as the section heading', () => {
    expect(setup().querySelector('h2')?.textContent?.trim()).toBe('Three ideas at the core');
  });

  it('renders the three product ideas as cards, each with a heading', () => {
    const cards = Array.from(setup().querySelectorAll('li'));
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.querySelector('h3')?.textContent?.trim())).toEqual([
      'Reviewable integrations',
      'Separate ratings for product and onboarding',
      'No pay-for-placement, ever',
    ]);
  });

  it('folds the operator promise in as the closing trust line', () => {
    expect(setup().textContent).toContain('never from changing what you see');
  });

  it('each card carries a decorative top-tick that is hidden from assistive tech', () => {
    const ticks = setup().querySelectorAll('li > span[aria-hidden="true"]');
    expect(ticks).toHaveLength(3);
  });

  it('uses borders, not shadows (DESIGN.md borders-not-shadows rule)', () => {
    expect(setup().querySelector('[class*="shadow"]')).toBeNull();
  });

  it('is a static band — no rotation, no controls', () => {
    const h = setup();
    expect(h.querySelectorAll('button')).toHaveLength(0);
    expect(h.querySelector('[aria-roledescription="carousel"]')).toBeNull();
  });
});
