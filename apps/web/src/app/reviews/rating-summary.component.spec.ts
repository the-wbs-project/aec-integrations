import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { RatingSummary, type RatingSummaryVariant } from './rating-summary';

/**
 * The card/table rating display + its §5.5 visibility gate. These pin the three
 * things the surfaces depend on: the gate (≥5 reviews AND a real average), the
 * two empty-state behaviours (inline = render nothing; cell = en-dash), and the
 * accessibility contract (decorative star, value announced via `aria-label`).
 */

function create(
  ratingOverall: number | null,
  reviewCount: number,
  variant: RatingSummaryVariant = 'inline',
) {
  // Reset so a single test can mount more than one instance (e.g. the
  // formatting cases) without "test module already instantiated".
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  });
  const fixture = TestBed.createComponent(RatingSummary);
  fixture.componentRef.setInput('ratingOverall', ratingOverall);
  fixture.componentRef.setInput('reviewCount', reviewCount);
  fixture.componentRef.setInput('variant', variant);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

function img(el: HTMLElement): HTMLElement | null {
  return el.querySelector('[role="img"]');
}

describe('RatingSummary', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows the average + review count when there are ≥5 reviews', () => {
    const { el } = create(4.3, 12);

    const role = img(el);
    expect(role).not.toBeNull();
    expect(el.textContent).toContain('4.3');
    expect(el.textContent).toContain('12 reviews');
    // The value/label is announced once, not as five separate stars.
    expect(role?.getAttribute('aria-label')).toBe('Rated 4.3 out of 5, from 12 reviews');
    // The gold star is decorative — meaning is carried by the numeral + label.
    const star = el.querySelector('span[aria-hidden="true"]');
    expect(star?.textContent).toContain('★');
  });

  it('formats the average to one decimal (4 → 4.0, 4.25 → 4.3)', () => {
    expect(create(4, 8).el.textContent).toContain('4.0');
    expect(create(4.25, 8).el.textContent).toContain('4.3');
  });

  it('renders nothing (inline) below the 5-review gate', () => {
    const { el } = create(4.8, 4);
    expect(img(el)).toBeNull();
    expect(el.textContent?.trim()).toBe('');
  });

  it('renders nothing (inline) when the average is null even with ≥5 reviews', () => {
    // Defensive: a non-gated source could send count≥5 but a null average.
    const { el } = create(null, 9);
    expect(img(el)).toBeNull();
    expect(el.textContent?.trim()).toBe('');
  });

  it('renders an en-dash empty state in the cell variant when gated', () => {
    const { el } = create(null, 2, 'cell');
    expect(img(el)).toBeNull();
    const dash = el.querySelector('span[aria-label]');
    expect(dash?.textContent).toContain('–');
    expect(dash?.getAttribute('aria-label')).toBe('No ratings yet');
  });

  it('shows the rating (not the en-dash) in the cell variant when visible', () => {
    const { el } = create(4.9, 30, 'cell');
    expect(img(el)).not.toBeNull();
    expect(el.textContent).toContain('4.9');
    expect(el.textContent).toContain('30 reviews');
    expect(el.querySelector('span[aria-label="No ratings yet"]')).toBeNull();
  });
});
