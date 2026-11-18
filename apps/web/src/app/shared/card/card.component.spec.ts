/**
 * AECI-1765 - `aecCard`, the one shared card surface. These specs pin the recipe
 * each look renders. jsdom does not run Tailwind, so computed sizes, the lift and
 * the forced-colours edge are measured in the browser by `e2e/card.spec.ts`.
 */
import { Component, PLATFORM_ID, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AecCard,
  FORM_CARD_GAP_CLASS,
  cardClass,
  type AecCardStripe,
  type AecCardTone,
} from './card';

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
    <form method="dialog" aecCard phoneFlush class="p-6 sm:p-8" data-testid="form">Form</form>
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

  // AECI-1720 layout pass: a form card spends no input width on a phone. Below sm
  // it loses its frame and pulls out over the 24px gutter its own p-6 replaces.
  it('a form card drops its frame below sm and spans the page gutter', () => {
    const c = el('form').classList;
    for (const name of [
      'max-sm:-mx-6',
      'max-sm:rounded-none',
      'max-sm:border-0',
      'max-sm:shadow-none',
    ])
      expect(c.contains(name), name).toBe(true);
    // From sm it is the normal card.
    for (const name of ['aec-card', 'rounded-card', 'shadow-card', 'p-6', 'sm:p-8'])
      expect(c.contains(name), name).toBe(true);
    // Only a form card pulls out: a plain card keeps its frame on a phone.
    expect(el('plain').className).not.toContain('max-sm:');
    expect(cardClass({ phoneFlush: true })).toContain('max-sm:-mx-6');
    // Its own top padding is blank space on a phone, so the gap above it shrinks.
    expect(FORM_CARD_GAP_CLASS).toBe('mt-6 sm:mt-10');
  });

  it('cardClass is what the directive renders', () => {
    for (const name of cardClass().split(' ')) {
      expect(el('plain').classList.contains(name), name).toBe(true);
    }
  });
});

/** AECI-1937: see the `aecButton` creation-pass specs. The same gap left a card without its frame. */
@Component({
  imports: [AecCard],
  template: `
    <li aecCard class="p-6" data-testid="static">Static</li>
    <div aecCard interactive tone="warm" stripe="clay" class="p-6" data-testid="attrs">Attrs</div>
    <section aecCard class="p-8" [tone]="tone()" data-testid="bound">Bound</section>
  `,
})
class CreationHost {
  readonly tone = signal<AecCardTone>('warm');
}

describe('aecCard at the creation pass (AECI-1937)', () => {
  const tokens = (value: string) => value.split(' ');
  const create = (platform: 'browser' | 'server') => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), { provide: PLATFORM_ID, useValue: platform }],
    });
    const fixture = TestBed.createComponent(CreationHost);
    const el = (id: string) =>
      fixture.nativeElement.querySelector(`[data-testid="${id}"]`) as HTMLElement;
    return { fixture, el };
  };
  afterEach(() => TestBed.resetTestingModule());

  it('has the whole frame beside the static class before the first update', () => {
    const { el } = create('browser');
    for (const cls of ['p-6', ...tokens(cardClass())]) {
      expect(el('static').classList.contains(cls), cls).toBe(true);
    }
  });

  it('reads static tone, interactive and stripe attributes before inputs are set', () => {
    const { el } = create('browser');
    const recipe = cardClass({ tone: 'warm', interactive: true, stripe: 'clay' });
    for (const cls of tokens(recipe)) expect(el('attrs').classList.contains(cls), cls).toBe(true);
  });

  it('drops a wrong guess for a bound tone in the first update, keeping the static class', async () => {
    const { fixture, el } = create('browser');
    expect(el('bound').classList.contains('bg-(--surface-base)')).toBe(true);
    await fixture.whenStable();
    const settled = el('bound').classList;
    expect(settled.contains('p-8')).toBe(true);
    for (const cls of tokens(cardClass({ tone: 'warm' }))) {
      expect(settled.contains(cls), cls).toBe(true);
    }
    expect(settled.contains('bg-(--surface-base)')).toBe(false);
  });

  it('adds nothing in the server render', () => {
    const { el } = create('server');
    expect(el('static').getAttribute('class')).toBe('p-6');
  });
});
