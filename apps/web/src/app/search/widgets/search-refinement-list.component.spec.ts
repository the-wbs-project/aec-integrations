import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { RefinementItem } from '../../shared/facets/refinement-item';

import { SearchRefinementList } from './search-refinement-list';

function items(n: number, refined: readonly number[] = []): RefinementItem[] {
  return Array.from({ length: n }, (_, i) => ({
    value: `v${i}`,
    label: `Value ${i}`,
    count: n - i,
    isRefined: refined.includes(i),
  }));
}

@Component({
  imports: [SearchRefinementList],
  template: `<aec-search-refinement-list label="Trades" [items]="items()" />`,
})
class Host {
  readonly items = signal<RefinementItem[]>([]);
}

function render(list: RefinementItem[]) {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.items.set(list);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    el,
    rows: () => el.querySelectorAll('li').length,
    toggle: () => el.querySelector<HTMLButtonElement>('fieldset > button'),
  };
}

describe('SearchRefinementList: top 10, then Show more', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows every value and no toggle at 10 or fewer', () => {
    const { rows, toggle } = render(items(10));
    expect(rows()).toBe(10);
    expect(toggle()).toBeNull();
  });

  it('collapses to the first 10 and reveals the rest in place', () => {
    const { fixture, rows, toggle } = render(items(25));
    expect(rows()).toBe(10);
    expect(toggle()?.textContent).toContain('Show more (15)');
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    const controls = toggle()?.getAttribute('aria-controls');
    expect(fixture.nativeElement.querySelector(`#${controls}`)).not.toBeNull();

    toggle()!.click();
    fixture.detectChanges();
    expect(rows()).toBe(25);
    expect(toggle()?.textContent).toContain('Show fewer');
    expect(toggle()?.getAttribute('aria-expanded')).toBe('true');

    toggle()!.click();
    fixture.detectChanges();
    expect(rows()).toBe(10);
  });

  it('keeps a checked value past the first 10 visible while collapsed', () => {
    const { el, rows, toggle } = render(items(25, [18]));
    expect(rows()).toBe(11);
    expect(el.textContent).toContain('Value 18');
    expect(toggle()?.textContent).toContain('Show more (14)');
  });
});
