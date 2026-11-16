import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { BAND_WRAP_CLASS } from '../shared/band-wrap';

import { BrowseLayout } from './browse-layout';

@Component({
  imports: [BrowseLayout],
  template: `
    <aec-browse-layout>
      <header slot="header" data-testid="header">Header marker</header>
      <aside slot="filters" data-testid="filters">Filters marker</aside>
      <section slot="grid" data-testid="grid">Grid marker</section>
    </aec-browse-layout>
  `,
})
class BrowseLayoutHost {}

@Component({
  imports: [BrowseLayout],
  template: `
    <aec-browse-layout [filters]="false">
      <div slot="header">Header marker</div>
      <aside slot="filters" data-testid="filters">Filters marker</aside>
      <div slot="grid" data-testid="grid">Grid marker</div>
    </aec-browse-layout>
  `,
})
class NoRailHost {}

describe('BrowseLayout', () => {
  it('projects all three named slots', () => {
    const fixture = TestBed.createComponent(BrowseLayoutHost);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid=header]')?.textContent).toContain('Header marker');
    expect(root.querySelector('[data-testid=filters]')?.textContent).toContain('Filters marker');
    expect(root.querySelector('[data-testid=grid]')?.textContent).toContain('Grid marker');
  });

  it('exposes filters as an aside and grid as a section with i18n aria-labels', () => {
    const fixture = TestBed.createComponent(BrowseLayoutHost);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('aside[aria-label]')).not.toBeNull();
    expect(root.querySelector('section[aria-label]')).not.toBeNull();
  });
});

describe('BrowseLayout, mock-up 10 (AECI-1793)', () => {
  it('puts the header and the body on the 1328px page wrap (ruling 3)', () => {
    const fixture = TestBed.createComponent(BrowseLayoutHost);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const wraps = [
      ...root.querySelectorAll('aec-browse-layout > header > div, aec-browse-layout > div'),
    ];
    expect(wraps).toHaveLength(2);
    for (const wrap of wraps) {
      for (const cls of BAND_WRAP_CLASS.split(' ')) expect(wrap.classList.contains(cls)).toBe(true);
      expect(wrap.classList.contains('max-w-7xl')).toBe(false);
    }
  });

  it('draws the header hairline across the full width, outside the wrap', () => {
    const fixture = TestBed.createComponent(BrowseLayoutHost);
    fixture.detectChanges();
    const header = (fixture.nativeElement as HTMLElement).querySelector(
      'aec-browse-layout > header',
    )!;
    expect(header.classList.contains('border-b')).toBe(true);
    expect(header.classList.contains('mx-auto')).toBe(false);
  });

  it('drops the rail and its landmark when the page has nothing to filter', () => {
    const fixture = TestBed.createComponent(NoRailHost);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('aside[aria-label]')).toBeNull();
    expect(root.querySelector('[data-testid=filters]')).toBeNull();
    expect(root.querySelector('[data-testid=grid]')?.textContent).toContain('Grid marker');
    const body = root.querySelector('aec-browse-layout > div')!;
    expect(body.classList.contains('grid')).toBe(false);
  });
});
