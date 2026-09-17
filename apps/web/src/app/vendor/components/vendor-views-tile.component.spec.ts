/**
 * `VendorViewsTile` (AECI-983) — the placeholder Views tile. What is pinned is
 * the contract AECI-941 builds on: the toggle's state and names, the default
 * window, the `periodChange` output, and that no figure is shown yet.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { VendorViewsTile, type VendorViewsPeriod } from './vendor-views-tile';

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
});

function create(): ComponentFixture<VendorViewsTile> {
  const fixture = TestBed.createComponent(VendorViewsTile);
  fixture.detectChanges();
  return fixture;
}

const el = (f: ComponentFixture<VendorViewsTile>) => f.nativeElement as HTMLElement;
const buttons = (f: ComponentFixture<VendorViewsTile>) => [
  ...el(f).querySelectorAll<HTMLButtonElement>('fieldset button'),
];
const pressed = (f: ComponentFixture<VendorViewsTile>) =>
  buttons(f).map((b) => b.getAttribute('aria-pressed'));
const sentence = (f: ComponentFixture<VendorViewsTile>) =>
  el(f).querySelector('[data-views-sentence]')?.textContent?.trim() ?? '';

describe('VendorViewsTile', () => {
  it('defaults to the 7-day window', () => {
    const fixture = create();
    expect(pressed(fixture)).toEqual(['false', 'true', 'false']);
    expect(sentence(fixture)).toBe('View counts for the last 7 days are on their way.');
  });

  it('names each option with its visible label first (WCAG 2.5.3)', () => {
    const fixture = create();
    expect(buttons(fixture).map((b) => b.textContent?.trim())).toEqual(['1d', '1w', '1m']);
    expect(buttons(fixture).map((b) => b.getAttribute('aria-label'))).toEqual([
      '1d, last day',
      '1w, last 7 days',
      '1m, last 30 days',
    ]);
    expect(el(fixture).querySelector('fieldset legend')?.textContent?.trim()).toBe('Views period');
  });

  it('moves aria-pressed and the sentence with a click, and emits periodChange', () => {
    const fixture = create();
    const emitted: VendorViewsPeriod[] = [];
    fixture.componentInstance.periodChange.subscribe((p) => emitted.push(p));

    buttons(fixture)[0]!.click();
    fixture.detectChanges();
    expect(pressed(fixture)).toEqual(['true', 'false', 'false']);
    expect(sentence(fixture)).toBe('View counts for the last day are on their way.');

    buttons(fixture)[2]!.click();
    fixture.detectChanges();
    expect(pressed(fixture)).toEqual(['false', 'false', 'true']);
    expect(sentence(fixture)).toBe('View counts for the last 30 days are on their way.');

    // Re-pressing the current window is not a change.
    buttons(fixture)[2]!.click();
    expect(emitted).toEqual(['day', 'month']);
  });

  it('shows no figure and no link while it is a placeholder', () => {
    const fixture = create();
    expect(el(fixture).querySelector('.text-5xl')).toBeNull();
    expect(el(fixture).querySelector('a')).toBeNull();
    // The only numbers in the body are the window lengths inside the sentence.
    expect(sentence(fixture).replace(/last \d+ days/, '')).not.toMatch(/\d/);
  });
});
