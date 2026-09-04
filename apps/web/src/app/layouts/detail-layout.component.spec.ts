import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { DetailLayout } from './detail-layout';

@Component({
  imports: [DetailLayout],
  template: `
    <aec-detail-layout>
      <nav slot="breadcrumbs" data-testid="breadcrumbs">Breadcrumbs marker</nav>
      <header slot="hero" data-testid="hero">Hero marker</header>
      <div slot="nav" data-testid="nav">Nav marker</div>
      <section slot="body-lead" data-testid="body-lead">Body lead marker</section>
      <div slot="metadata" data-testid="metadata">Metadata marker</div>
      <section slot="body" data-testid="body">Body marker</section>
    </aec-detail-layout>
  `,
})
class DetailLayoutHost {}

describe('DetailLayout', () => {
  it('projects all six named slots', () => {
    const fixture = TestBed.createComponent(DetailLayoutHost);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid=breadcrumbs]')?.textContent).toContain(
      'Breadcrumbs marker',
    );
    expect(root.querySelector('[data-testid=hero]')?.textContent).toContain('Hero marker');
    expect(root.querySelector('[data-testid=nav]')?.textContent).toContain('Nav marker');
    expect(root.querySelector('[data-testid=metadata]')?.textContent).toContain('Metadata marker');
    expect(root.querySelector('[data-testid=body-lead]')?.textContent).toContain(
      'Body lead marker',
    );
    expect(root.querySelector('[data-testid=body]')?.textContent).toContain('Body marker');
  });

  // The single-column reading order is the whole point of the body-lead slot: the
  // metadata sidebar carries the vendor / taxonomy / action facts, and collapsing
  // it after the full body buried them under the last section of a long page.
  it('places the metadata between the lead and the rest of the body in DOM order', () => {
    const fixture = TestBed.createComponent(DetailLayoutHost);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const order = [...root.querySelectorAll('[data-testid]')].map((el) =>
      el.getAttribute('data-testid'),
    );

    expect(order).toEqual(['breadcrumbs', 'hero', 'nav', 'body-lead', 'metadata', 'body']);
  });

  // The nav slot must stay an unwrapped direct child of the page container:
  // position:sticky is bounded by the parent's box, so any wrapper (or the
  // body-lead column) would unpin the in-page nav partway down the page.
  it('projects the nav slot with no wrapper element between it and the page container', () => {
    const fixture = TestBed.createComponent(DetailLayoutHost);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const nav = root.querySelector('[data-testid=nav]')!;
    const hero = root.querySelector('[data-testid=hero]')!;

    // Same parent as the <header> that wraps the hero: the page container.
    expect(nav.parentElement).toBe(hero.parentElement?.parentElement);
    // And not inside the two-column grid.
    expect(nav.closest('.grid')).toBeNull();
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
