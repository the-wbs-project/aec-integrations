import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { HomeWhy } from './home-why';

function setup(): HTMLElement {
  TestBed.configureTestingModule({});
  const fixture = TestBed.createComponent(HomeWhy);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('HomeWhy', () => {
  it('states the problem headline as the section heading', () => {
    expect(setup().querySelector('h2')?.textContent?.trim()).toBe(
      'The software review landscape is broken',
    );
  });

  it('labels the band with the "the problem" eyebrow', () => {
    expect(setup().querySelector('.aec-overline')?.textContent?.trim()).toBe('The problem');
  });

  it('renders the eyebrow Clay accent as a decorative, screen-reader-hidden dot', () => {
    const dot = setup().querySelector('.aec-overline span[aria-hidden="true"]');
    expect(dot).not.toBeNull();
    // Clay is decorative-and-fill-only (DESIGN.md ≤5% rule); meaning is carried by the text.
    expect(dot?.getAttribute('class')).toContain('--accent-secondary');
  });

  it('carries the two-paragraph narrative in the Bone callout', () => {
    const callout = setup().querySelector('[class*="--accent-warm"]');
    expect(callout).not.toBeNull();
    expect(callout?.querySelectorAll('p')).toHaveLength(2);
  });

  it('renders the three market figures as bordered stat cards', () => {
    const cards = Array.from(setup().querySelectorAll('ul li'));
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.querySelector('p')?.textContent?.trim())).toEqual([
      '≈34%',
      '$87K',
      '900+',
    ]);
  });

  it('flags the figures as industry estimates (interim sourcing note)', () => {
    const texts = Array.from(setup().querySelectorAll('p')).map((p) => p.textContent?.trim());
    expect(texts).toContain('Figures are industry estimates.');
  });

  it('is a static, cache-neutral band — no controls, no client state', () => {
    const h = setup();
    expect(h.querySelectorAll('button')).toHaveLength(0);
    expect(h.querySelector('[aria-roledescription="carousel"]')).toBeNull();
  });
});
