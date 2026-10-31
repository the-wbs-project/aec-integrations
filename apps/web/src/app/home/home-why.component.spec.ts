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

  it('carries no decorative eyebrow dot (the dot carried no meaning)', () => {
    const h = setup();
    expect(h.querySelector('.aec-overline span[aria-hidden="true"]')).toBeNull();
    expect(h.querySelector('[class*="--accent-secondary"]')).toBeNull();
  });

  it('sets the two-paragraph narrative straight on the band ground, not in a Bone callout', () => {
    const h = setup();
    expect(h.querySelector('[class*="--accent-warm"]')).toBeNull();
    expect(h.querySelectorAll('h2 + div > p')).toHaveLength(2);
  });

  it('uses the home card recipe (white fill, no raised surface)', () => {
    const cards = Array.from(setup().querySelectorAll('ul li'));
    for (const card of cards) {
      expect(card.getAttribute('class')).toContain('bg-(--surface-base)');
      expect(card.getAttribute('class')).not.toContain('--surface-raised');
    }
  });

  it('renders the three market figures as bordered stat cards', () => {
    const cards = Array.from(setup().querySelectorAll('ul li'));
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.querySelector('p')?.textContent?.trim())).toEqual([
      '≈19%',
      '$27K',
      '900+',
    ]);
  });

  it('gives every figure a source link wired to an accessible citation tooltip', () => {
    const cards = Array.from(setup().querySelectorAll('ul li'));
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      const link = card.querySelector('a[aria-describedby]');
      expect(link).not.toBeNull();
      // A real, verifiable external citation link.
      expect(link?.getAttribute('href')).toMatch(/^https:\/\//);
      expect(link?.getAttribute('target')).toBe('_blank');
      expect(link?.getAttribute('rel')).toContain('noopener');
      // aria-describedby resolves to the in-card tooltip carrying the citation text.
      const describedById = link?.getAttribute('aria-describedby') ?? '';
      const tooltip = card.querySelector(`#${describedById}`);
      expect(tooltip?.getAttribute('role')).toBe('tooltip');
      expect((tooltip?.textContent?.trim().length ?? 0) > 0).toBe(true);
    }
  });

  it('retires the blanket "industry estimates" note in favour of per-figure sources', () => {
    const texts = Array.from(setup().querySelectorAll('p')).map((p) => p.textContent?.trim());
    expect(texts).not.toContain('Figures are industry estimates.');
  });

  it('is a static, cache-neutral band — no controls, no client state', () => {
    const h = setup();
    expect(h.querySelectorAll('button')).toHaveLength(0);
    expect(h.querySelector('[aria-roledescription="carousel"]')).toBeNull();
  });
});
