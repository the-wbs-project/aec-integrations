import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { HomeWhy } from './home-why';

function setup(): HTMLElement {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
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
    expect(prose?.getAttribute('class')).toContain('max-w-2xl');
    const paras = Array.from(prose?.querySelectorAll('p') ?? []);
    expect(paras).toHaveLength(2);
    for (const p of paras) {
      expect(text(p).split(' ').length).toBeLessThanOrEqual(45);
    }
  });

  it('renders the three cited figures as a hairline row in Forest at --t-24 (mock-up 9 question 4)', () => {
    const row = setup().querySelector('[data-testid="home-why-figures"]');
    expect(row?.getAttribute('class')).toContain('md:divide-x');
    const items = Array.from(row?.querySelectorAll(':scope > li') ?? []);
    expect(items.map((li) => text(li.querySelector('p')))).toEqual(['≈19%', '$27K', '900+']);
    for (const li of items) {
      const figure = li.querySelector('[data-testid="home-why-figure"]')!;
      expect(figure.getAttribute('class')).toContain('--accent-primary');
      // Sub-heading size, not the large figure size: clash 8 allows one per band.
      expect(figure.getAttribute('class')).toContain('text-t-24');
      expect(figure.getAttribute('class')).not.toContain('text-t-fig');
      // Spec-sheet row, not cards: no per-figure box.
      expect(li.getAttribute('class') ?? '').not.toContain('rounded');
    }
  });

  it('prints each citation under its figure, ending in its Source link', () => {
    const h = setup();
    expect(h.querySelector('[role="tooltip"]')).toBeNull();
    const items = Array.from(h.querySelectorAll('[data-testid="home-why-figures"] > li'));
    const expected = ['Originality.AI, 2025.', 'Vendr, 2026.', 'Capterra, 2026.'];
    items.forEach((li, i) => {
      const cite = li.querySelector('[data-testid="home-why-citation"]')!;
      expect(text(cite).startsWith(expected[i]!)).toBe(true);
      // Printed, not revealed: nothing hides it.
      expect(cite.getAttribute('class') ?? '').not.toMatch(/opacity-0|sr-only|hidden/);
      const link = cite.querySelector('a')!;
      expect(link.getAttribute('href')).toMatch(/^https:\/\//);
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toContain('noopener');
    });
  });

  it('gives each Source link a distinct accessible name that starts with "Source" (AECI-830)', () => {
    const links = Array.from(setup().querySelectorAll('[data-testid="home-why-figures"] a'));
    expect(links).toHaveLength(3);
    const names = links.map((a) => text(a));
    for (const name of names) expect(name.startsWith('Source')).toBe(true);
    expect(new Set(names).size).toBe(3);
  });

  it('states what AECi does instead as the one Forest feature card (mock-up 9 question 1)', () => {
    const h = setup();
    const card = h.querySelector<HTMLElement>('[data-testid="home-why-instead"]')!;
    const cls = card.getAttribute('class') ?? '';
    // A card, never a band: card radius, card shadow, Forest fill, Bone ink, and the
    // transparent .aec-card edge that forced-colours mode paints.
    expect(cls).toContain('aec-card');
    expect(cls).toContain('rounded-card');
    expect(cls).toContain('shadow-card');
    expect(cls).toContain('bg-(--accent-primary)');
    expect(cls).toContain('text-(--text-on-brand)');
    expect(text(card.querySelector('h3'))).toBe('What we do instead');
    const points = Array.from(card.querySelectorAll('[data-testid="home-why-ideas"] > li'));
    expect(points.map((c) => text(c.querySelector('h4')))).toEqual([
      'Every connection is documented',
      'No pay-for-placement',
      'Organized the way AEC works',
    ]);
    // Secondary ink on Forest is the measured on-brand secondary, never text-secondary.
    for (const point of points) {
      expect(point.querySelector('p')?.getAttribute('class')).toContain(
        'text-(--text-on-brand-secondary)',
      );
    }
    // The Bone main button, last in reading order, to the ranking page.
    const button = card.querySelector('a[data-variant="on-brand"]')!;
    expect(text(button)).toBe('How we rank');
    expect(button.getAttribute('href')).toBe('/docs/trust/how-ranking-works');
    expect(card.lastElementChild).toBe(button);
  });

  it('says no pay-for-placement exactly once in the band', () => {
    const matches = text(setup()).match(/pay-for-placement/gi) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('ties the ranking promise to order, not to position or spend (AECI-2233, ruling 68)', () => {
    const t = text(setup());
    expect(t).toContain(
      'Payment never changes the order in which products are listed or returned in search.',
    );
    expect(t).not.toMatch(/boosted by spend|position is earned|never bought/i);
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

  it('carries no em dash, and no Bone or raised surface outside the Bone button', () => {
    const h = setup();
    expect(h.textContent ?? '').not.toContain('—');
    h.querySelector('a[data-variant="on-brand"]')?.remove();
    expect(h.innerHTML).not.toContain('--accent-warm');
    expect(h.innerHTML).not.toContain('--accent-primary-soft');
    expect(h.innerHTML).not.toContain('--surface-raised');
  });

  it('is a static, cache-neutral band with no buttons (the one action is a link)', () => {
    expect(setup().querySelectorAll('button')).toHaveLength(0);
  });
});
