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
import { HeroBand } from './hero-band';

@Component({
  selector: 'aec-hero-band-host',
  imports: [HeroBand, AecButton],
  template: `
    <aec-hero-band>
      <nav heroCrumbs aria-label="Breadcrumb" data-testid="crumbs">Products</nav>
      <p heroKicker data-testid="kicker">Maintained</p>
      <span heroTitle data-testid="title">Revu</span>
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
    for (const cls of ['max-w-[1328px]', 'px-6', 'md:px-8', 'lg:px-12']) {
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
    const order = ['crumbs', 'kicker', 'title', 'lede', 'action'].map((id) =>
      q(`[data-testid="${id}"]`),
    );
    for (const node of order) expect(node, 'slot missing').not.toBeNull();
    for (let i = 1; i < order.length; i++) {
      const rel = order[i - 1]!.compareDocumentPosition(order[i]!);
      expect(rel & Node.DOCUMENT_POSITION_FOLLOWING, `slot ${i} out of order`).toBeTruthy();
    }
  });

  it('puts the actions in a stacking row and the panel in its own surface', () => {
    const actions = q('[data-testid="action"]')!.parentElement!;
    expect(actions.className).toContain('flex-col');
    expect(actions.className).toContain('sm:flex-row');
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

  it('renders no visitor-specific content and no animation class', () => {
    const clone = q('.aec-hero-band')!.cloneNode(true) as HTMLElement;
    clone.querySelector('[data-testid="action"]')!.remove();
    expect(clone.innerHTML).not.toMatch(/animate-|transition-|motion-|animation/);
  });
});
