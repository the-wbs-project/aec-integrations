import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { HomeWhy } from './home-why';

function setup(): HTMLElement {
  TestBed.configureTestingModule({});
  const fixture = TestBed.createComponent(HomeWhy);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('HomeWhy', () => {
  it('states the argument as the one section heading, under its eyebrow', () => {
    const h = setup();
    expect(h.querySelectorAll('h2')).toHaveLength(1);
    expect(text(h.querySelector('h2'))).toBe('The way AEC firms find software is broken');
    expect(text(h.querySelector('.aec-overline'))).toBe('Why this exists');
    expect(h.querySelector('section')?.getAttribute('aria-labelledby')).toBe('home-why-heading');
  });

  it('sets two short paragraphs in a reading-width column', () => {
    const prose = setup().querySelector('[data-testid="home-why-prose"]');
    expect(prose?.getAttribute('class')).toContain('max-w-3xl');
    const paras = Array.from(prose?.querySelectorAll('p') ?? []);
    expect(paras).toHaveLength(2);
    for (const p of paras) {
      expect(text(p).split(' ').length).toBeLessThanOrEqual(45);
    }
  });

  it('renders the three cited figures as a hairline spec-sheet row in Forest', () => {
    const row = setup().querySelector('[data-testid="home-why-figures"]');
    expect(row?.getAttribute('class')).toContain('divide-x');
    const items = Array.from(row?.querySelectorAll(':scope > li') ?? []);
    expect(items.map((li) => text(li.querySelector('p')))).toEqual(['≈19%', '$27K', '900+']);
    for (const li of items) {
      expect(li.querySelector('p')?.getAttribute('class')).toContain('--accent-primary');
      // Spec-sheet row, not cards: no per-figure box.
      expect(li.getAttribute('class') ?? '').not.toContain('rounded');
    }
  });

  it('wires every Source link to its citation tooltip', () => {
    const items = Array.from(setup().querySelectorAll('[data-testid="home-why-figures"] > li'));
    for (const li of items) {
      const link = li.querySelector('a[aria-describedby]');
      expect(link?.getAttribute('href')).toMatch(/^https:\/\//);
      expect(link?.getAttribute('target')).toBe('_blank');
      expect(link?.getAttribute('rel')).toContain('noopener');
      const tooltip = li.querySelector(`#${link?.getAttribute('aria-describedby') ?? 'x'}`);
      expect(tooltip?.getAttribute('role')).toBe('tooltip');
      expect(text(tooltip).length).toBeGreaterThan(0);
    }
  });

  it('gives each Source link a distinct accessible name that starts with "Source" (AECI-830)', () => {
    const links = Array.from(setup().querySelectorAll('[data-testid="home-why-figures"] a'));
    expect(links).toHaveLength(3);
    const names = links.map((a) => text(a));
    for (const name of names) expect(name.startsWith('Source')).toBe(true);
    expect(new Set(names).size).toBe(3);
  });

  it('states what AECi does instead as three bordered white cards', () => {
    const h = setup();
    expect(text(h.querySelector('h3'))).toBe('What we do instead');
    const cards = Array.from(h.querySelectorAll('[data-testid="home-why-ideas"] > li'));
    expect(cards.map((c) => text(c.querySelector('h4')))).toEqual([
      'Every connection is documented',
      'Position is earned, never bought',
      'Organized the way AEC works',
    ]);
    for (const card of cards) {
      const cls = card.getAttribute('class') ?? '';
      expect(cls).toContain('bg-(--surface-base)');
      expect(cls).toContain('border-(--border-default)');
      expect(cls).not.toContain('--surface-raised');
      expect(cls).not.toContain('shadow');
    }
  });

  it('says no pay-for-placement exactly once in the band', () => {
    const matches = text(setup()).match(/pay-for-placement/gi) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('claims no reviews or ratings anywhere outside the cited market figures (AECI-1557)', () => {
    const h = setup();
    h.querySelector('[data-testid="home-why-figures"]')?.remove();
    expect(text(h)).not.toMatch(/review|rating|onboarding|practitioner|dual/i);
  });

  it('never claims reviews in the figure row either; it only cites other platforms', () => {
    const row = setup().querySelector('[data-testid="home-why-figures"]');
    // The only "review" mentions are about Google reviews and third-party review sites.
    expect(text(row)).not.toMatch(/our reviews|we review|rate the product/i);
  });

  it('carries no em dash and no Bone or raised surface', () => {
    const h = setup();
    expect(h.textContent ?? '').not.toContain('—');
    expect(h.innerHTML).not.toContain('--accent-warm');
    expect(h.innerHTML).not.toContain('--accent-primary-soft');
    expect(h.innerHTML).not.toContain('--surface-raised');
  });

  it('is a static, cache-neutral band with no controls', () => {
    expect(setup().querySelectorAll('button')).toHaveLength(0);
  });
});
