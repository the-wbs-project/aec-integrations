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

  it('puts the three commitments in one Forest feature card (ruling 2026-11-17)', () => {
    const h = setup();
    const forest = h.querySelectorAll('[class*="bg-(--accent-primary)"]');
    expect(forest).toHaveLength(1);
    const card = forest[0];
    expect(card.getAttribute('data-testid')).toBe('about-trust-card');
    // The home "What we do instead" recipe: a card, never a band.
    for (const c of ['aec-card', 'rounded-card', 'shadow-card', 'text-(--text-on-brand)']) {
      expect(card.classList).toContain(c);
    }
    // All three points live inside the card, split by on-brand hairlines.
    const points = Array.from(card.querySelectorAll('li'));
    expect(points).toHaveLength(3);
    for (const li of points) expect(li.classList).toContain('aec-on-brand-rule');
    // No control on the card: the pillars have no link today.
    expect(card.querySelectorAll('a, button')).toHaveLength(0);
    // The head row and the closing line stay on white, outside the card.
    expect(card.querySelector('h2')).toBeNull();
    expect(card.textContent).not.toContain('We will earn revenue');
  });

  it('ties the rankings commitment to order, not to position (AECI-2233, ruling 68)', () => {
    const text = setup().textContent ?? '';
    expect(text).toContain(
      'Payment never changes the order in which products are listed or returned in search.',
    );
    expect(text).not.toMatch(/influences position|not bought/i);
    expect(text).toContain('never from changing the order of results.');
  });

  it('is a static band — no rotation, no controls', () => {
    const h = setup();
    // All content present at once; no single-slide panel and no buttons to drive.
    expect(h.querySelectorAll('button')).toHaveLength(0);
    expect(h.querySelector('[aria-roledescription="carousel"]')).toBeNull();
  });
});
