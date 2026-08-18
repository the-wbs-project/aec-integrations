/**
 * AgreementBadge render tests (AECI-300; four states from AECI-605). Named
 * `.component.spec.ts` so it runs under `ng test` (TestBed).
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { AGREEMENT_STATES, type AgreementState } from '@aeci/shared';

import { AgreementBadge } from './agreement-badge';

function render(agreement: AgreementState, attributedTo: string | null = null): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(AgreementBadge);
  fixture.componentRef.setInput('agreement', agreement);
  fixture.componentRef.setInput('attributedTo', attributedTo);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const ariaOf = (el: HTMLElement) =>
  el.querySelector('span[aria-label]')?.getAttribute('aria-label');
const chipOf = (el: HTMLElement) => el.querySelector('span[aria-label]')!;

describe('AgreementBadge', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the neutral "Unverified · AECi" chip for the Stage 1.5 state', () => {
    const el = render('unverified');
    expect(el.textContent).toContain('Unverified · AECi');
    expect(ariaOf(el)).toContain('not yet vendor-confirmed');
  });

  it('attributes single_source to the affirming vendor and names the silence', () => {
    const el = render('single_source', 'Acme Software');
    expect(el.textContent).toContain('Confirmed by Acme Software');
    // The counterparty's silence must be stated, not implied (§4.3).
    expect(ariaOf(el)).toContain('The other vendor has not responded');
  });

  it('falls back to an unattributed phrasing when the vendor has no record', () => {
    const el = render('single_source', null);
    expect(el.textContent).toContain('Confirmed by one vendor');
    expect(el.textContent).not.toContain('null');
    expect(ariaOf(el)).toContain('has not responded');
  });

  it('reserves the bilateral wording for confirmed', () => {
    const el = render('confirmed');
    expect(el.textContent).toContain('Both vendors confirmed');
    expect(ariaOf(el)).toContain('both vendors');
  });

  it('reads conflict as a difference between vendors, not a product defect', () => {
    const el = render('conflict');
    expect(el.textContent).toContain('Vendors disagree');
    expect(ariaOf(el)).toContain('describe this data flow differently');
  });

  // The §4.3 render contract, asserted structurally rather than by eyeballing
  // the classes: only `confirmed` earns the Forest wash, only `conflict` is red.
  it('gives the affirmative treatment to confirmed alone', () => {
    expect(chipOf(render('confirmed')).className).toContain('bg-(--accent-primary-soft)');
    for (const state of ['unverified', 'single_source', 'conflict'] as const) {
      expect(chipOf(render(state)).className).not.toContain('accent-primary-soft');
    }
  });

  it('is red for conflict alone', () => {
    expect(chipOf(render('conflict')).className).toContain('text-(--status-error)');
    for (const state of ['unverified', 'single_source', 'confirmed'] as const) {
      expect(chipOf(render(state)).className).not.toContain('status-error');
    }
  });

  // WCAG 1.4.1: colour is never the sole signal. Every state must be
  // distinguishable from its text alone, and conflict additionally carries a
  // glyph so it survives greyscale.
  it('gives every state a distinct label and accessible name', () => {
    const labels = new Set<string>();
    const arias = new Set<string>();
    for (const state of AGREEMENT_STATES) {
      const el = render(state, 'Acme Software');
      labels.add(el.textContent!.trim());
      arias.add(ariaOf(el)!);
    }
    expect(labels.size).toBe(AGREEMENT_STATES.length);
    expect(arias.size).toBe(AGREEMENT_STATES.length);
  });

  it('marks the conflict glyph decorative so the aria-label carries the meaning', () => {
    const svg = render('conflict').querySelector('svg');
    expect(svg).toBeTruthy();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
  });

  // DESIGN.md reserves the `rounded-full` pill for `VerifiedBadge`, which means
  // something else entirely (a verified vendor *account*). The two must not be
  // confusable at a glance.
  it('stays a rounded.sm chip, never the VerifiedBadge pill', () => {
    for (const state of AGREEMENT_STATES) {
      const className = chipOf(render(state)).className;
      expect(className).toContain('rounded-(--radius-sm)');
      expect(className).not.toContain('rounded-full');
    }
  });
});
