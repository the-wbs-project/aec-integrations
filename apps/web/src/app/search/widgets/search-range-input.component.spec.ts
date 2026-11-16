import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { SearchRangeInput } from './search-range-input';

@Component({
  imports: [SearchRangeInput],
  template: `<aec-search-range-input
    label="Founded"
    name="vendors:founded_year"
    [bounds]="{ min: 1950, max: 2024 }"
    [start]="start()"
    (refine)="emitted.set($event)"
  />`,
})
class Host {
  readonly start = signal<readonly [number | undefined, number | undefined]>([
    undefined,
    undefined,
  ]);
  readonly emitted = signal<[number | undefined, number | undefined] | null>(null);
}

function render() {
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('SearchRangeInput (AECI-1796)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('draws both bounds on the shared field recipe, under the filter legend', () => {
    const { el } = render();
    const inputs = [...el.querySelectorAll<HTMLInputElement>('input[type="number"]')];
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect(input.classList.contains('aec-field-control')).toBe(true);
      // The old 1.25:1 edge and 36px height are gone.
      expect(input.classList.contains('border-(--border-default)')).toBe(false);
      expect(input.classList.contains('h-9')).toBe(false);
    }
    const legend = el.querySelector('legend');
    expect(legend?.textContent?.trim()).toBe('Founded');
    expect(legend?.classList.contains('aec-overline')).toBe(true);
  });

  it('keeps each bound named by its own label', () => {
    const { el } = render();
    expect(el.querySelector('label[for="vendors:founded_year-min"]')?.textContent?.trim()).toBe(
      'Minimum',
    );
    expect(el.querySelector('label[for="vendors:founded_year-max"]')?.textContent?.trim()).toBe(
      'Maximum',
    );
  });

  it('emits the typed bounds on change, a blank side left open', () => {
    const { fixture, el } = render();
    const min = el.querySelector<HTMLInputElement>('#vendors\\:founded_year-min')!;
    min.value = '2000';
    min.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(fixture.componentInstance.emitted()).toEqual([2000, undefined]);
  });
});
