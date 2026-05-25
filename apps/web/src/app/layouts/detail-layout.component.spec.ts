import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { DetailLayout } from './detail-layout';

@Component({
  imports: [DetailLayout],
  template: `
    <aec-detail-layout>
      <nav slot="breadcrumbs" data-testid="breadcrumbs">Breadcrumbs marker</nav>
      <header slot="hero" data-testid="hero">Hero marker</header>
      <aside slot="metadata" data-testid="metadata">Metadata marker</aside>
      <section slot="body" data-testid="body">Body marker</section>
    </aec-detail-layout>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class DetailLayoutHost {}

describe('DetailLayout', () => {
  it('projects all four named slots', () => {
    const fixture = TestBed.createComponent(DetailLayoutHost);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid=breadcrumbs]')?.textContent).toContain(
      'Breadcrumbs marker',
    );
    expect(root.querySelector('[data-testid=hero]')?.textContent).toContain('Hero marker');
    expect(root.querySelector('[data-testid=metadata]')?.textContent).toContain('Metadata marker');
    expect(root.querySelector('[data-testid=body]')?.textContent).toContain('Body marker');
  });

  it('renders landmark regions for breadcrumbs and metadata with i18n aria-labels', () => {
    const fixture = TestBed.createComponent(DetailLayoutHost);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    // Breadcrumb nav landmark
    expect(root.querySelectorAll('nav[aria-label]').length).toBeGreaterThanOrEqual(1);
    // Metadata aside landmark
    expect(root.querySelector('aside[aria-label]')).not.toBeNull();
    // Body column must NOT be a <main> — the app shell owns the main landmark;
    // a second <main> here would create a duplicate main landmark (axe:
    // landmark-no-duplicate-main).
    expect(root.querySelector('main')).toBeNull();
  });
});
