import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

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
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class BrowseLayoutHost {}

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
