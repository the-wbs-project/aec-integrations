/**
 * AECI-1765 - `aecCard`, the one shared card surface. These specs pin the recipe
 * each look renders. jsdom does not run Tailwind, so computed sizes, the lift and
 * the forced-colours edge are measured in the browser by `e2e/card.spec.ts`.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AecCard, cardClass, type AecCardStripe, type AecCardTone } from './card';

@Component({
  imports: [AecCard],
  template: `
    <section aecCard class="p-6" data-testid="plain">Plain</section>
    <a
      aecCard
      href="/x"
      [interactive]="interactive()"
      [tone]="tone()"
      [stripe]="stripe()"
      data-testid="link"
      class="group"
      >Link</a
    >
    <div aecCard nested data-testid="nested">Nested</div>
  `,
})
class Host {
  readonly interactive = signal(true);
  readonly tone = signal<AecCardTone>('base');
  readonly stripe = signal<AecCardStripe | null>(null);
}

describe('aecCard (AECI-1765)', () => {
  let fixture: ComponentFixture<Host>;
  const el = (id: string) =>
    fixture.nativeElement.querySelector(`[data-testid="${id}"]`) as HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
  });
  afterEach(() => TestBed.resetTestingModule());

  it('a standing card is 24px, white, shadowed, with the unlayered transparent edge', () => {
    const c = el('plain').classList;
    for (const name of ['aec-card', 'border', 'rounded-card', 'shadow-card', 'bg-(--surface-base)'])
      expect(c.contains(name), name).toBe(true);
    // The edge comes from `.aec-card`, never from a border-colour utility (it would not apply).
    expect(el('plain').className).not.toMatch(/(^|\s)border-\(--/);
    expect(c.contains('p-6')).toBe(true);
  });

  it('a card that is not interactive never lifts', () => {
    expect(el('plain').className).not.toContain('translate');
    expect(el('plain').className).not.toContain('transition');
  });

  it('an interactive card lifts from its wrapper, 4px on hover and 1px on press, only under motion-safe', () => {
    const c = el('link').classList;
    for (const name of [
      'motion-safe:group-hover/card:-translate-y-1',
      'motion-safe:group-active/card:-translate-y-px',
      'relative',
      'has-focus-visible:outline-3',
      'has-focus-visible:outline-offset-3',
      'duration-base',
      'ease-standard',
      'focus-visible:outline-3',
      'focus-visible:outline-offset-3',
    ])
      expect(c.contains(name), name).toBe(true);
    // No unconditioned translate, so reduced motion removes the move entirely.
    // The card never lifts on its own :hover: that flickers at its bottom edge.
    expect(el('link').className).not.toMatch(/(^|\s)(motion-safe:)?(hover|active):/);
    // The shadow does not change on hover (clash 37).
    expect(el('link').className).not.toContain('hover:shadow');
  });

  it('an interactive card turned off stops lifting', () => {
    fixture.componentInstance.interactive.set(false);
    fixture.detectChanges();
    expect(el('link').className).not.toContain('translate');
  });

  it('keeps the caller classes next to the recipe', () => {
    expect(el('link').classList.contains('group')).toBe(true);
  });

  it('a nested card is a 16px tint with no shadow', () => {
    const c = el('nested').classList;
    expect(c.contains('rounded-panel')).toBe(true);
    expect(c.contains('bg-(--accent-primary-soft)')).toBe(true);
    expect(c.contains('aec-card')).toBe(true);
    expect(c.contains('shadow-card')).toBe(false);
    expect(c.contains('rounded-card')).toBe(false);
  });

  it('tone warm swaps only the fill', () => {
    fixture.componentInstance.tone.set('warm');
    fixture.detectChanges();
    const c = el('link').classList;
    expect(c.contains('bg-(--accent-warm)')).toBe(true);
    expect(c.contains('bg-(--surface-base)')).toBe(false);
    expect(c.contains('shadow-card')).toBe(true);
  });

  it('a stripe adds the unlayered stripe class, clay on request', () => {
    fixture.componentInstance.stripe.set('forest');
    fixture.detectChanges();
    expect(el('link').classList.contains('aec-card-stripe')).toBe(true);
    expect(el('link').classList.contains('aec-card-stripe-clay')).toBe(false);
    fixture.componentInstance.stripe.set('clay');
    fixture.detectChanges();
    expect(el('link').classList.contains('aec-card-stripe-clay')).toBe(true);
  });

  it('cardClass is what the directive renders', () => {
    for (const name of cardClass().split(' ')) {
      expect(el('plain').classList.contains(name), name).toBe(true);
    }
  });
});
