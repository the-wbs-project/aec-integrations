/**
 * AECI-1766 - `aec-hero-band`. These specs pin the slots, the h1 with Display on
 * an inner span, and the panel that disappears when nothing is projected.
 * jsdom runs no Tailwind and no cascade, so the glow, the focus ring and the
 * forced-colours rules are pinned by `hero-band-styles.guard.spec.ts` and
 * measured in the browser by `e2e/hero-band.spec.ts`.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { AecButton } from '../button/button';
import { BAND_WRAP_CLASS } from '../band-wrap';
import { HeroBand } from './hero-band';

@Component({
  selector: 'aec-hero-band-host',
  imports: [HeroBand, AecButton],
  template: `
    <aec-hero-band>
      <nav heroCrumbs aria-label="Breadcrumb" data-testid="crumbs">Products</nav>
      <p heroKicker data-testid="kicker">Maintained</p>
      @if (withMark()) {
        <div heroMark data-testid="mark">Logo</div>
      }
      <span heroTitle data-testid="title">Revu</span>
      <p heroByline data-testid="byline">By a vendor</p>
      <p data-testid="lede">Lede</p>
      <a heroActions aecButton variant="on-brand" href="/x" data-testid="action">Go</a>
      @if (withPanel()) {
        <div heroPanel data-testid="panel-content">Panel</div>
      }
    </aec-hero-band>
  `,
})
class Host {
  readonly withPanel = signal(true);
  readonly withMark = signal(true);
}

describe('aec-hero-band (AECI-1766)', () => {
  let fixture: ComponentFixture<Host>;
  const q = (sel: string) => fixture.nativeElement.querySelector(sel) as HTMLElement | null;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
  });

  it('paints the ground from the same token the header uses', () => {
    const band = q('.aec-hero-band')!;
    expect(band.classList.contains('bg-(--accent-primary)')).toBe(true);
    expect(band.classList.contains('text-(--text-on-brand)')).toBe(true);
  });

  it('keeps the page wrap at 1328px with 24, 32 and 48px gutters', () => {
    const wrap = q('.aec-hero-band > div')!;
    for (const cls of BAND_WRAP_CLASS.split(' ')) {
      expect(wrap.classList.contains(cls), cls).toBe(true);
    }
    expect(BAND_WRAP_CLASS).toBe('mx-auto w-full max-w-[1328px] px-6 md:px-8 lg:px-12');
    for (const cls of ['pt-4', 'md:pt-6', 'pb-24', 'md:pb-32']) {
      expect(wrap.classList.contains(cls), cls).toBe(true);
    }
  });

  it('renders one h1 with the title and Display on an inner span, not on the h1', () => {
    const h1s = fixture.nativeElement.querySelectorAll('h1');
    expect(h1s.length).toBe(1);
    const h1 = h1s[0] as HTMLElement;
    expect(h1.className).not.toMatch(/text-t-/);
    const span = h1.querySelector('span.text-t-display')!;
    expect(span).not.toBeNull();
    expect(span.classList.contains('font-normal')).toBe(true);
    expect(span.contains(q('[data-testid="title"]'))).toBe(true);
    expect(h1.textContent?.trim()).toBe('Revu');
  });

  it('projects crumbs, kicker and title in reading order, then the body, then the actions', () => {
    const order = ['crumbs', 'kicker', 'mark', 'title', 'byline', 'lede', 'action'].map((id) =>
      q(`[data-testid="${id}"]`),
    );
    for (const node of order) expect(node, 'slot missing').not.toBeNull();
    for (let i = 1; i < order.length; i++) {
      const rel = order[i - 1]!.compareDocumentPosition(order[i]!);
      expect(rel & Node.DOCUMENT_POSITION_FOLLOWING, `slot ${i} out of order`).toBeTruthy();
    }
  });

  it('puts the actions in a wrapping row and the panel in its own surface', () => {
    const actions = q('[data-testid="action"]')!.parentElement!;
    expect(actions.className).toContain('flex-wrap');
    expect(actions.className).not.toContain('flex-col');
    // From 480px to md: equal columns of one row (AECI-1778). Below 480px the grid keeps
    // its default row flow, so the actions stack full width (the AECI-1778 follow-up).
    const classes = actions.className.split(/\s+/);
    expect(classes).toContain('max-md:grid');
    expect(classes).toContain('min-[480px]:max-md:grid-flow-col');
    expect(classes).toContain('min-[480px]:max-md:auto-cols-fr');
    expect(classes).not.toContain('max-md:grid-flow-col');
    expect(classes).not.toContain('max-md:auto-cols-fr');
    expect(actions.className).toContain('mt-6');
    const panel = q('.aec-hero-panel')!;
    expect(panel.classList.contains('bg-(--surface-hero-panel)')).toBe(true);
    expect(panel.querySelector('[data-testid="panel-content"]')).not.toBeNull();
  });

  it('hides the panel column when nothing is projected into it', async () => {
    fixture.componentInstance.withPanel.set(false);
    await fixture.whenStable();
    const panel = q('.aec-hero-panel')!;
    expect(panel.querySelector('*')).toBeNull();
    expect(panel.classList.contains('empty:hidden')).toBe(true);
    expect(q('[data-testid="hero-band-grid"]')!.className).toContain(
      'has-[.aec-hero-panel>*]:grid-cols-',
    );
  });

  it('puts the mark in a 104px box, 68px below md, beside the name and byline, outside the h1', () => {
    const mark = q('[data-testid="mark"]')!;
    const box = mark.parentElement!;
    expect(box.classList.contains('size-17')).toBe(true);
    expect(box.classList.contains('md:size-26')).toBe(true);
    const h1 = q('h1')!;
    expect(h1.contains(mark)).toBe(false);
    expect(h1.contains(q('[data-testid="byline"]'))).toBe(false);
    const row = q('[data-testid="hero-band-namerow"]')!;
    expect(row.contains(mark)).toBe(true);
    expect(row.contains(q('[data-testid="byline"]'))).toBe(true);
    // The h1 holds only the title.
    expect(h1.textContent?.trim()).toBe('Revu');
  });

  it('follows mock-up 6 spacing: 24px above the name row, 24px above the actions', () => {
    const row = q('[data-testid="hero-band-namerow"]')!;
    expect(row.classList.contains('mt-6')).toBe(true);
    expect(row.classList.contains('mb-3')).toBe(true);
    expect(row.classList.contains('md:mb-4')).toBe(true);
  });

  it('hides the mark box when no mark is projected', async () => {
    fixture.componentInstance.withMark.set(false);
    await fixture.whenStable();
    const box = q('[data-testid="hero-band-namerow"]')!.firstElementChild!;
    expect(box.querySelector('*')).toBeNull();
    expect(box.classList.contains('empty:hidden')).toBe(true);
  });

  it('renders no visitor-specific content and no animation class', () => {
    const clone = q('.aec-hero-band')!.cloneNode(true) as HTMLElement;
    clone.querySelector('[data-testid="action"]')!.remove();
    expect(clone.innerHTML).not.toMatch(/animate-|transition-|motion-|animation/);
  });

  it('defaults to the Display title and the panel surface, so existing callers are unchanged', () => {
    const title = q('h1 > span')!;
    expect(title.className).toContain('text-t-display');
    // Below md the display title steps to the statement size, and below 360px to the
    // figure size, so a long word fits beside the mark (AECI-1720 restore).
    expect(title.classList).toContain('max-md:text-t-statement');
    expect(title.classList).toContain('max-[360px]:text-t-fig!');
    expect([...title.classList].filter((c) => c === 'text-t-statement')).toHaveLength(0);
    const panel = q('.aec-hero-panel')!;
    expect(panel.classList.contains('bg-(--surface-hero-panel)')).toBe(true);
    expect(panel.classList.contains('p-6')).toBe(true);
    // Item 82: a caller that never holds the columns gets them centred, as before.
    const grid = q('[data-testid="hero-band-grid"]')!;
    expect(grid.classList).toContain('lg:items-center');
    expect(grid.querySelectorAll('[data-held]')).toHaveLength(0);
    expect(grid.innerHTML).not.toContain('--aec-hero-held:');
  });

  // AECI-1720 restore C (mock-ups 6 and 12, .crumbs before .hero-grid): the breadcrumb
  // sits above the grid, so a tall panel never pushes it down.
  it('renders the breadcrumb above the two-column grid, not inside the text column', () => {
    const crumbs = q('[data-testid="crumbs"]')!;
    const grid = q('[data-testid="hero-band-grid"]')!;
    expect(grid.contains(crumbs)).toBe(false);
    expect(crumbs.parentElement).toBe(grid.parentElement);
    expect(crumbs.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The kicker still opens the text column.
    expect(q('[data-testid="hero-band-text"]')!.firstElementChild).toBe(
      q('[data-testid="kicker"]'),
    );
  });

  it('centres the text column by default and pins it to the top with align="start"', async () => {
    const text = q('[data-testid="hero-band-text"]')!;
    expect(text.classList).not.toContain('lg:self-start');
    const ref = TestBed.createComponent(HeroBand);
    ref.componentRef.setInput('align', 'start');
    await ref.whenStable();
    const pinned = (ref.nativeElement as HTMLElement).querySelector(
      '[data-testid="hero-band-text"]',
    )!;
    expect(pinned.classList).toContain('lg:self-start');
  });
});

// AECI-1798: the pair page sets the Statement size and a bare panel for its own cards.
@Component({
  selector: 'aec-hero-band-pair-host',
  imports: [HeroBand],
  template: `
    <aec-hero-band titleSize="statement" panel="bare">
      <span heroTitle>How A and B exchange data</span>
      <div heroPanel data-testid="panel-content">Cards</div>
    </aec-hero-band>
  `,
})
class PairHost {}

describe('aec-hero-band, statement title and bare panel (AECI-1798)', () => {
  it('puts the Statement size on the inner span and draws no panel ground', async () => {
    await TestBed.configureTestingModule({
      imports: [PairHost],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    const fixture = TestBed.createComponent(PairHost);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const span = el.querySelector('h1 > span')!;
    expect(span.className).toContain('text-t-statement');
    expect(span.className).not.toContain('text-t-display');
    expect(el.querySelectorAll('h1')).toHaveLength(1);
    const panel = el.querySelector('.aec-hero-panel')!;
    expect(panel.classList.contains('bg-(--surface-hero-panel)')).toBe(false);
    expect(panel.classList.contains('p-6')).toBe(false);
    // Still the same column: it hides when empty and keeps the forced-colours hook.
    expect(panel.classList.contains('empty:hidden')).toBe(true);
    expect(panel.querySelector('[data-testid="panel-content"]')).not.toBeNull();
  });
});

// AECI-1835: the empty pair page's fixed 540px diagram keeps the panel stacked until xl.
@Component({
  selector: 'aec-hero-band-empty-pair-host',
  imports: [HeroBand],
  template: `
    <aec-hero-band titleSize="statement" panel="bare" panelFrom="wide">
      <span heroTitle>We have no integration between A and B on record.</span>
      <div heroPanel>Diagram</div>
    </aec-hero-band>
  `,
})
class EmptyPairHost {}

describe('aec-hero-band, the wide panel from 1040px (AECI-1835)', () => {
  it('stacks the panel below 1040px, then gives it 540px; the default stays at lg', async () => {
    await TestBed.configureTestingModule({
      imports: [EmptyPairHost, PairHost],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    const empty = TestBed.createComponent(EmptyPairHost);
    await empty.whenStable();
    const grid = (empty.nativeElement as HTMLElement).querySelector(
      '[data-testid="hero-band-grid"]',
    )!;
    expect(grid.classList).toContain(
      'min-[1040px]:has-[.aec-hero-panel>*]:grid-cols-[minmax(0,1fr)_540px]',
    );
    expect([...grid.classList].some((c) => c.startsWith('lg:'))).toBe(false);
    // Top-aligned from 1040px: a centred text column moved whole when a font swap re-wrapped
    // a long name beside the taller diagram (layout shift 0.068 at 1280).
    expect(grid.classList).toContain('min-[1040px]:items-start');
    expect(grid.classList).not.toContain('min-[1040px]:items-center');
    const pair = TestBed.createComponent(PairHost);
    await pair.whenStable();
    const pairGrid = (pair.nativeElement as HTMLElement).querySelector(
      '[data-testid="hero-band-grid"]',
    )!;
    expect(pairGrid.classList).toContain(
      'lg:has-[.aec-hero-panel>*]:grid-cols-[minmax(0,1fr)_400px]',
    );
    expect(pairGrid.classList).toContain('lg:items-center');
  });
});

// AECI-1835: mock-up 5's statement size and a hero that nothing overlaps.
@Component({
  selector: 'aec-hero-band-wide-statement-host',
  imports: [HeroBand],
  template: `
    <aec-hero-band titleSize="statement-wide" bottom="band">
      <span heroTitle>We have no integration between A and B on record.</span>
    </aec-hero-band>
  `,
})
class WideStatementHost {}

describe('aec-hero-band, the wide statement and the band bottom (AECI-1835)', () => {
  it('sizes the title with the wide statement token and ends with plain band padding', async () => {
    await TestBed.configureTestingModule({
      imports: [WideStatementHost],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    const fixture = TestBed.createComponent(WideStatementHost);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const span = el.querySelector('h1 > span')!;
    expect(span.className).toContain('text-t-statement-wide');
    const wrap = el.querySelector('[data-testid="hero-band-grid"]')!.parentElement!;
    expect(wrap.classList).toContain('md:pb-24');
    expect(wrap.classList).not.toContain('md:pb-32');
  });
});
