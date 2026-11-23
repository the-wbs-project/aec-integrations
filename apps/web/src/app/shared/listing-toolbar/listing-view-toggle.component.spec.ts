import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { AEC_ICONS } from '../icon/icon-registry';

import type { ListingView } from './listing-toolbar';
import { ListingViewToggle } from './listing-view-toggle';

@Component({
  imports: [ListingViewToggle],
  template: `<aec-listing-view-toggle [view]="view()" (viewChange)="chosen.push($event)" />`,
})
class Host {
  view = signal<ListingView>('cards');
  chosen: ListingView[] = [];
}

function setup() {
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const buttons = () => Array.from(el.querySelectorAll('button'));
  return { fixture, el, buttons };
}

describe('ListingViewToggle (AECI-1793)', () => {
  it('draws the group on the 3:1 field edge, so it is 44px like the sort trigger', () => {
    const { el } = setup();
    const group = el.querySelector('[role="group"]')!;
    expect(group.classList.contains('aec-field-control')).toBe(true);
    expect(group.getAttribute('aria-label')).toBe('Choose a view');
  });

  it('marks the pressed view with aria-pressed and a tick in place of its glyph', () => {
    const { fixture, buttons } = setup();
    const [cards, table] = buttons();
    expect(cards!.getAttribute('aria-pressed')).toBe('true');
    expect(table!.getAttribute('aria-pressed')).toBe('false');
    expect(hasTick(cards!)).toBe(true);
    expect(hasTick(table!)).toBe(false);

    fixture.componentInstance.view.set('table');
    fixture.detectChanges();
    expect(cards!.getAttribute('aria-pressed')).toBe('false');
    expect(table!.getAttribute('aria-pressed')).toBe('true');
    expect(hasTick(cards!)).toBe(false);
    expect(hasTick(table!)).toBe(true);
  });

  it('carries the forced-colours hook and the Forest fill only on the pressed button', () => {
    const { buttons } = setup();
    const [cards, table] = buttons();
    for (const b of [cards!, table!])
      expect(b.classList.contains('aec-view-toggle-btn')).toBe(true);
    expect(cards!.classList.contains('bg-(--accent-primary)')).toBe(true);
    expect(table!.classList.contains('bg-(--accent-primary)')).toBe(false);
  });

  it('emits the clicked view and holds no state of its own', () => {
    const { fixture, buttons } = setup();
    buttons()[1]!.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.chosen).toEqual(['table']);
    // The host has not changed `view`, so Cards stays pressed.
    expect(buttons()[0]!.getAttribute('aria-pressed')).toBe('true');
  });
});

/** Whether the button's glyph is the registry's tick (`check`). */
function hasTick(button: HTMLElement): boolean {
  const tick = AEC_ICONS.check[0];
  return button.querySelector('svg path')?.getAttribute('d') === (tick.k === 'p' ? tick.d : '');
}
