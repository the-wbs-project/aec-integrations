/**
 * AgreementBadge render tests (AECI-300; four states from AECI-605). Named
 * `.component.spec.ts` so it runs under `ng test` (TestBed).
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { AGREEMENT_STATES, type AgreementState } from '@aeci/shared';

import { AgreementBadge } from './agreement-badge';

function render(
  agreement: AgreementState,
  attributedTo: string | null = null,
  refuted = false,
  syncService = false,
): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(AgreementBadge);
  fixture.componentRef.setInput('agreement', agreement);
  fixture.componentRef.setInput('attributedTo', attributedTo);
  fixture.componentRef.setInput('refuted', refuted);
  fixture.componentRef.setInput('syncService', syncService);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

// The full meaning is visually hidden text (AECI-1720 restore C), not an aria-label.
const ariaOf = (el: HTMLElement) =>
  el.querySelector('[data-testid="agreement-badge-meaning"]')?.textContent?.trim();
const chipOf = (el: HTMLElement) => el.querySelector('.aec-chip')!;
const toneOf = (el: HTMLElement) => chipOf(el).getAttribute('data-tone');

describe('AgreementBadge', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the neutral "Listed by AEC Integrations" chip for the Stage 1.5 state', () => {
    const el = render('unverified');
    expect(el.textContent).toContain('Listed by AEC Integrations');
    // "Listed" must never be heard as an endorsement: the name says what is missing.
    expect(ariaOf(el)).toContain('Neither company has confirmed it yet');
  });

  // AECI-1140: a lone No must not read like a claim nobody has touched.
  it('reads a refuted claim as "A company says no", naming nobody', () => {
    const el = render('unverified', 'Acme Software', true);
    expect(el.textContent).toContain('A company says no');
    expect(el.textContent).not.toContain('Listed by AEC Integrations');
    expect(el.textContent).not.toContain('Acme Software');
    expect(ariaOf(el)).toBe(
      'One of these companies says this does not happen. Neither company has confirmed it.',
    );
  });

  it('keeps a refuted claim neutral, with the stronger spoken-vendor dot', () => {
    const el = render('unverified', null, true);
    expect(toneOf(el)).toBe('quiet');
    expect(el.querySelector('span[aria-hidden="true"]')!.className).toContain(
      'bg-(--text-secondary)',
    );
    expect(render('unverified').querySelector('span[aria-hidden="true"]')!.className).toContain(
      'bg-(--text-tertiary)',
    );
  });

  it('ignores refuted on every state but unverified', () => {
    expect(render('single_source', 'Acme Software', true).textContent).toContain(
      'Confirmed by Acme Software',
    );
    expect(render('conflict', null, true).textContent).toContain('Companies disagree');
  });

  // AECI-1142: no data-model jargon in the reader's words.
  it('uses no model jargon in any state', () => {
    for (const state of AGREEMENT_STATES) {
      const el = render(state, 'Acme Software');
      const text = `${el.textContent} ${ariaOf(el)}`;
      expect(text).not.toMatch(/Unverified|AECi\b|Asserted|vendor|data flow/);
    }
  });

  it('attributes single_source to the affirming vendor and names the silence', () => {
    const el = render('single_source', 'Acme Software');
    expect(el.textContent).toContain('Confirmed by Acme Software');
    // The counterparty's silence must be stated, not implied (§4.3).
    expect(ariaOf(el)).toContain('The other company has not answered yet');
  });

  it('falls back to an unattributed phrasing when the vendor has no record', () => {
    const el = render('single_source', null);
    expect(el.textContent).toContain('Confirmed by one company');
    expect(el.textContent).not.toContain('null');
    expect(ariaOf(el)).toContain('has not answered yet');
  });

  it('reserves the bilateral wording for confirmed', () => {
    const el = render('confirmed');
    expect(el.textContent).toContain('Confirmed by both companies');
    expect(ariaOf(el)).toContain('both companies');
  });

  it('reads conflict as a difference between companies, not a product defect', () => {
    const el = render('conflict');
    expect(el.textContent).toContain('Companies disagree');
    expect(ariaOf(el)).toContain('The two companies disagree about this');
  });

  // The §4.3 render contract, asserted structurally rather than by eyeballing
  // the classes: only `confirmed` earns the Forest wash, only `conflict` is red.
  it('gives the affirmative treatment to confirmed alone', () => {
    expect(toneOf(render('confirmed'))).toBe('wash');
    for (const state of ['unverified', 'single_source', 'conflict'] as const) {
      expect(toneOf(render(state))).not.toBe('wash');
    }
  });

  it('is red for conflict alone', () => {
    expect(toneOf(render('conflict'))).toBe('error');
    for (const state of ['unverified', 'single_source', 'confirmed'] as const) {
      expect(toneOf(render(state))).not.toBe('error');
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

  // Account status and claim agreement remain distinct through wording and tone.
  it('is one aec-chip in the 500-weight label face, never a link or a button', () => {
    for (const state of AGREEMENT_STATES) {
      const chip = chipOf(render(state));
      expect(chip.tagName).toBe('SPAN');
      expect(chip.getAttribute('data-face')).toBe('label');
    }
  });

  // records/10 §2 and records/11 §8: an aria-label on a plain span is not reliably read.
  it('carries its full meaning as visually hidden text, read once, with no aria-label', () => {
    for (const state of AGREEMENT_STATES) {
      const el = render(state, 'Acme Software');
      const chip = chipOf(el);
      expect(chip.hasAttribute('aria-label')).toBe(false);
      const meaning = chip.querySelector('[data-testid="agreement-badge-meaning"]')!;
      expect(meaning.className).toContain('sr-only');
      expect(meaning.textContent!.trim().length).toBeGreaterThan(0);
      // Every other text node in the chip is hidden, so the label is not heard twice.
      const heard = [...chip.querySelectorAll('span')].filter(
        (span) => span !== meaning && !span.closest('[aria-hidden="true"]'),
      );
      expect(heard.every((span) => span.contains(meaning))).toBe(true);
    }
    expect(ariaOf(render('confirmed'))).toBe('Confirmed by both companies.');
  });

  // AECI-2039, ruling 4 on AECI-2035: a Sync Service confirms its own flows.
  it('names the company that offers a Sync Service pair, and never says "both companies"', () => {
    const el = render('owner_confirmed', 'Rivets');
    expect(el.textContent).toContain('Confirmed by Rivets, which offers this integration');
    expect(el.textContent).not.toContain('both companies');
    expect(ariaOf(el)).toBe('Confirmed by Rivets, which offers this integration.');
    // One company's word: the neutral chip, never the bilateral Forest wash.
    expect(toneOf(el)).toBe('quiet');
  });

  it('falls back to an unattributed owner line when no company is on file', () => {
    const el = render('owner_confirmed');
    expect(el.textContent).toContain('Confirmed by the company that offers this integration');
  });

  it('on a Sync Service pair an unanswered flow no longer says "Neither company"', () => {
    const el = render('unverified', 'Rivets', false, true);
    expect(el.textContent).toContain('Listed by AEC Integrations');
    expect(ariaOf(el)).not.toContain('Neither company');
    expect(ariaOf(el)).toBe(
      'Listed by AEC Integrations from public sources. Rivets, which offers this integration, has not confirmed it yet.',
    );
  });
});
