import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { DetailLayout } from './detail-layout';

@Component({
  imports: [DetailLayout],
  template: `
    <aec-detail-layout>
      <div slot="breadcrumbs" data-testid="breadcrumbs">Breadcrumbs marker</div>
      <header slot="hero" data-testid="hero">Hero marker</header>
      <div slot="nav" data-testid="nav">Nav marker</div>
      <section slot="body-lead" data-testid="body-lead">Body lead marker</section>
      <div slot="metadata" data-testid="metadata">Metadata marker</div>
      <section slot="body" data-testid="body">Body marker</section>
    </aec-detail-layout>
  `,
})
class DetailLayoutHost {}

@Component({
  imports: [DetailLayout],
  template: `
    <aec-detail-layout shell="bands">
      <div slot="breadcrumbs" data-testid="breadcrumbs">Breadcrumbs marker</div>
      <header slot="hero" data-testid="hero">Hero marker</header>
      <div slot="nav" data-testid="nav">Nav marker</div>
      @if (withLead()) {
        <section slot="body-lead" data-testid="body-lead">Body lead marker</section>
      }
      <div slot="metadata" data-testid="metadata">Metadata marker</div>
      <section slot="body" data-testid="body">Body marker</section>
    </aec-detail-layout>
  `,
})
class BandShellHost {
  readonly withLead = signal(true);
}

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

  it('renders the metadata landmark and leaves the breadcrumb landmark to aec-breadcrumb', () => {
    const fixture = TestBed.createComponent(DetailLayoutHost);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    // The slot is a plain wrapper. aec-breadcrumb owns the one nav landmark (AECI-1777).
    expect(root.querySelectorAll('nav')).toHaveLength(0);
    // Metadata aside landmark
    expect(root.querySelector('aside[aria-label]')).not.toBeNull();
    // Body column must NOT be a <main> — the app shell owns the main landmark;
    // a second <main> here would create a duplicate main landmark (axe:
    // landmark-no-duplicate-main).
    expect(root.querySelector('main')).toBeNull();
  });
});

// AECI-1778: the product page's band shell. The column shell above stays the default, for
// the vendor page.
describe('DetailLayout band shell (AECI-1778)', () => {
  function render(withLead = true) {
    const fixture = TestBed.createComponent(BandShellHost);
    fixture.componentInstance.withLead.set(withLead);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('reads hero, facts, nav, lead, body in DOM order, and drops the breadcrumbs slot', () => {
    const root = render();
    const order = [...root.querySelectorAll('[data-testid]')]
      .map((el) => el.getAttribute('data-testid'))
      .filter((id) => !id!.startsWith('detail-'));
    expect(order).toEqual(['hero', 'metadata', 'nav', 'body-lead', 'body']);
    // The hero holds its own breadcrumb on the band shell.
    expect(root.querySelector('[data-testid=breadcrumbs]')).toBeNull();
  });

  it('keeps the nav a direct child of the page container, with no wrapper', () => {
    const root = render();
    const container = root.querySelector('[data-shell=bands]')!;
    expect(root.querySelector('[data-testid=nav]')!.parentElement).toBe(container);
    expect(root.querySelector('[data-testid=hero]')!.parentElement).toBe(container);
  });

  it('pulls the facts up over the hero by no more than the hero padding', () => {
    const root = render();
    const aside = root.querySelector('aside[aria-label=Metadata]')!;
    expect(aside.querySelector('[data-testid=metadata]')).not.toBeNull();
    const classes = [...aside.classList];
    // 64px below md and 96px from md, under the hero's 96px and 128px bottom padding.
    expect(classes).toContain('-mt-16');
    expect(classes).toContain('md:-mt-24');
    expect(classes).toContain('relative');
    // The ground behind it is a block formatting context, so the negative margin cannot
    // collapse through it and drag the Bone ground over the hero.
    expect(aside.closest('.flow-root')).not.toBeNull();
    // No docked sidebar on the band shell.
    expect(classes).not.toContain('lg:sticky');
  });

  it('puts the lead on the Bone band and the body on white, in the 1328px wrap', () => {
    const root = render();
    const lead = root.querySelector('[data-testid=body-lead]')!;
    const leadBand = lead.closest('[data-testid=detail-lead-band]')!;
    expect(leadBand.classList.contains('bg-(--accent-warm)')).toBe(true);
    expect(lead.parentElement!.classList.contains('max-w-[1328px]')).toBe(true);
    const body = root.querySelector('[data-testid=body]')!;
    expect(body.closest('[data-testid=detail-lead-band]')).toBeNull();
    expect(body.parentElement!.classList.contains('max-w-[1328px]')).toBe(true);
  });

  it('leaves the lead wrap empty when the page projects no lead, so the band hides', () => {
    const root = render(false);
    const wrap = root.querySelector('[data-lead]')!;
    expect(wrap.children).toHaveLength(0);
    expect(
      root
        .querySelector('[data-testid=detail-lead-band]')!
        .classList.contains('has-[>[data-lead]:empty]:hidden'),
    ).toBe(true);
  });
});
