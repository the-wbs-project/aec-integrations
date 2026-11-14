/**
 * `aec-meter` tests (AECI-1767). Named `.component.spec.ts` so they run under `ng test`.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { AecMeter, type MeterTone } from './meter';

@Component({
  imports: [AecMeter],
  template: `
    <aec-meter
      [value]="value()"
      [max]="max()"
      [text]="text()"
      [tone]="tone()"
      label="Product quality"
    />
  `,
})
class Host {
  readonly value = signal(4.3);
  readonly max = signal(5);
  readonly text = signal<string | null>(null);
  readonly tone = signal<MeterTone>('forest');
}

function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  return {
    meter: () => root.querySelector<HTMLElement>('aec-meter')!,
    fill: () => root.querySelector<HTMLElement>('.aec-meter-fill')!,
    async update(fn: (h: Host) => void) {
      fn(fixture.componentInstance);
      fixture.detectChanges();
      await fixture.whenStable();
    },
  };
}

describe('AecMeter', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('is a WAI-ARIA meter with a name, a range and the printed text', () => {
    const el = setup().meter();
    expect(el.getAttribute('role')).toBe('meter');
    expect(el.getAttribute('aria-label')).toBe('Product quality');
    expect(el.getAttribute('aria-valuemin')).toBe('0');
    expect(el.getAttribute('aria-valuemax')).toBe('5');
    expect(el.getAttribute('aria-valuenow')).toBe('4.3');
    expect(el.getAttribute('aria-valuetext')).toBe('4.3');
  });

  it('prints the number as text in the DOM and hides the bar graphic from AT', () => {
    const el = setup().meter();
    expect(el.textContent).toContain('4.3');
    expect(el.querySelector('.aec-meter-track')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('sizes the fill to the share of the range', () => {
    expect(setup().fill().style.width).toBe('86%');
  });

  it('reads zero as an empty bar and a printed 0', async () => {
    const { fill, meter, update } = setup();
    await update((h) => h.value.set(0));
    expect(fill().style.width).toBe('0%');
    expect(meter().getAttribute('aria-valuenow')).toBe('0');
    expect(meter().textContent).toContain('0');
  });

  it('reads the maximum as a full bar', async () => {
    const { fill, update } = setup();
    await update((h) => h.value.set(5));
    expect(fill().style.width).toBe('100%');
  });

  it('clamps a value outside the range but never changes the printed text', async () => {
    const { fill, meter, update } = setup();
    await update((h) => h.value.set(9));
    expect(fill().style.width).toBe('100%');
    expect(meter().getAttribute('aria-valuenow')).toBe('5');
    expect(meter().textContent).toContain('9');
  });

  it('prints the caller text and uses it as the value text', async () => {
    const { meter, update } = setup();
    await update((h) => {
      h.value.set(24);
      h.max.set(58);
      h.text.set('Showing 24 of 58');
    });
    expect(meter().getAttribute('aria-valuetext')).toBe('Showing 24 of 58');
    expect(meter().textContent).toContain('Showing 24 of 58');
  });

  it('keeps the label hidden on forest and shows it on the onboarding tone', async () => {
    const { meter, fill, update } = setup();
    expect(meter().textContent).not.toContain('Product quality');
    await update((h) => h.tone.set('onboarding'));
    expect(meter().textContent).toContain('Product quality');
    expect(fill().getAttribute('data-tone')).toBe('onboarding');
  });
});
