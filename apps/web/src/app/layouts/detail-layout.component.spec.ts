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

  // AECI-853 moved the dock from xl to lg, which makes 608px (not 778px) the
  // narrowest the body column ever gets. That figure is what every body-column
  // table's min-width is now sized against, so a silent move back to xl (or on
  // to 2xl) would leave those tables sized for a column that no longer exists.
  // The paired assertions live in product-integrations-table.component.spec.ts
  // and vendor-detail.component.spec.ts; all three have to move together.
  it('docks the metadata sidebar at lg, the width every body-column table is sized against', () => {
    const fixture = TestBed.createComponent(DetailLayoutHost);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    const grid = root.querySelector('[data-testid=body-lead]')!.closest('.grid')!;
    const classes = [...grid.classList];

    expect(classes).toContain('lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]');
    expect(classes).toContain('lg:gap-x-12');
    expect(classes.some((c) => c.startsWith('xl:') || c.startsWith('2xl:'))).toBe(false);

    // The sidebar and the body columns have to switch on the SAME breakpoint,
    // or the sidebar docks into a grid column that is not there yet.
    const aside = root.querySelector('aside[aria-label=Metadata]')!;
    expect([...aside.classList]).toContain('lg:sticky');
    expect([...aside.classList].some((c) => c.startsWith('xl:'))).toBe(false);
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
