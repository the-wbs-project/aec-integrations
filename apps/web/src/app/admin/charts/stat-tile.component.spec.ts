/**
 * AECI-578 / Phase 8.3 P1.4 — `StatTile`.
 *
 * The `dataviz` contract is label · value · delta · sparkline. Two rules carry
 * most of the weight here and both are about honesty rather than layout:
 *
 *   - **`pct` is null when `prior` is 0**, and the tile must then show the
 *     absolute change only. "+100%" against a prior of zero is not a fact about
 *     the world, and the 05:00 digest omits it in exactly the same case.
 *   - **Direction is never colour-alone.** A glyph carries it visually and a
 *     screen-reader-only word carries it non-visually. Green-for-up would also be
 *     wrong on this page: a rise in *bot* traffic is not good news, and the tile
 *     cannot know which measure it is showing.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminDelta } from '@aeci/shared';

import { StatTile } from './stat-tile';

function render(inputs: Record<string, unknown>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(StatTile);
  fixture.componentRef.setInput('label', 'Human page views');
  fixture.componentRef.setInput('value', 3419);
  for (const [key, value] of Object.entries(inputs)) {
    fixture.componentRef.setInput(key, value);
  }
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const delta = (over: Partial<AdminDelta> = {}): AdminDelta => ({
  current: 120,
  prior: 100,
  diff: 20,
  pct: 20,
  ...over,
});

describe('StatTile', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the label and a thousands-separated value', () => {
    const el = render({});
    expect(el.textContent).toContain('Human page views');
    expect(el.textContent).toContain('3,419');
  });

  it('renders the caveat next to the number (§9.8)', () => {
    const el = render({ caveat: 'A visitor is a distinct browser-and-network pair.' });
    expect(el.textContent).toContain('A visitor is a distinct browser-and-network pair.');
  });

  it('omits the delta block entirely when no delta is supplied', () => {
    // This page passes none on purpose: deltas belong to the Overview, where
    // they come from the API so the screen and the email cannot disagree.
    const el = render({});
    expect(el.textContent).not.toContain('↑');
    expect(el.textContent).not.toContain('↓');
  });

  it('shows magnitude and percentage for a rise', () => {
    const el = render({ delta: delta(), deltaSuffix: 'vs. the previous day' });
    expect(el.textContent).toContain('↑');
    expect(el.textContent).toContain('20 (20%)');
    expect(el.textContent).toContain('vs. the previous day');
  });

  it('shows a fall as a positive magnitude with a down glyph, not a minus sign', () => {
    const el = render({ delta: delta({ diff: -20, pct: -20 }) });
    expect(el.textContent).toContain('↓');
    expect(el.textContent).toContain('20 (20%)');
    expect(el.textContent).not.toContain('-20');
  });

  it('omits the percentage when the prior period was zero', () => {
    const el = render({ delta: delta({ current: 12, prior: 0, diff: 12, pct: null }) });
    expect(el.textContent).toContain('12');
    expect(el.textContent).not.toContain('%');
  });

  it('states direction in words for screen readers, never by colour alone', () => {
    const up = render({ delta: delta() });
    expect(up.querySelector('.sr-only')?.textContent).toContain('up');

    const down = render({ delta: delta({ diff: -5, pct: -5 }) });
    expect(down.querySelector('.sr-only')?.textContent).toContain('down');

    const flat = render({ delta: delta({ diff: 0, pct: 0 }) });
    expect(flat.querySelector('.sr-only')?.textContent).toContain('unchanged');
    expect(flat.textContent).toContain('→');
  });

  it('hides the sparkline from assistive tech and carries its series in a table', () => {
    const el = render({
      series: [1, 2, 3],
      categories: ['1 Aug', '2 Aug', '3 Aug'],
      categoryHeader: 'Day (UTC)',
      tableCaption: 'Human page views',
    });
    const svg = el.querySelector('svg')!;
    // Redundant with the number beside it, so announcing it would be noise —
    // but the series it draws must still be reachable.
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    const table = el.querySelector('table')!;
    expect(table.classList.contains('sr-only')).toBe(true);
    expect([...table.querySelectorAll('tbody th')].map((th) => th.textContent?.trim())).toEqual([
      '1 Aug',
      '2 Aug',
      '3 Aug',
    ]);
  });

  it('renders neither sparkline nor table when there is no series', () => {
    const el = render({ series: [] });
    expect(el.querySelector('svg')).toBeNull();
    expect(el.querySelector('table')).toBeNull();
  });
});
