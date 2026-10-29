/**
 * `FoundViaField`: the optional "How did you find AEC Integrations?" question
 * (AECI-1063, `docs/ANALYTICS.md` §11b).
 *
 * The open listbox is jsdom-hostile (see `aec-select.component.spec.ts`), so the
 * choice is driven through `AecSelect`'s `changed` output, the same seam the
 * host specs use.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FOUND_VIA_FOLLOW_UP, type FoundVia } from '@aeci/shared';

import { AecSelect } from '../aec-select/aec-select';
import { FoundViaField } from './found-via-field';

function setup() {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(FoundViaField);
  fixture.componentRef.setInput('idPrefix', 'test-found-via');
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

function choose(fixture: ComponentFixture<FoundViaField>, value: string | null): void {
  const select = fixture.debugElement.query(By.directive(AecSelect)).componentInstance as AecSelect;
  select.changed.emit(value);
  fixture.detectChanges();
}

const detailInput = (el: HTMLElement) =>
  el.querySelector('[data-testid="found-via-detail"]') as HTMLInputElement | null;
const status = (el: HTMLElement) =>
  el.querySelector('[data-testid="found-via-status"]') as HTMLElement;

describe('FoundViaField', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove()));

  it('renders the optional question, a placeholder, and no follow-up by default', () => {
    const { el } = setup();
    expect(el.querySelector('#test-found-via-label')?.textContent?.trim()).toBe(
      'How did you find AEC Integrations? (optional)',
    );
    expect(el.querySelector('button[role="combobox"]')?.textContent?.trim()).toBe('Choose one');
    expect(detailInput(el)).toBeNull();
    // The live region is in the DOM from the start, empty, so a later message announces.
    expect(status(el).getAttribute('role')).toBe('status');
    expect(status(el).getAttribute('aria-live')).toBe('polite');
    expect(status(el).textContent?.trim()).toBe('');
  });

  const followUps: Array<[FoundVia, string]> = [
    ['ai_tool', 'What did you ask it?'],
    ['search', 'What did you search for?'],
    ['vendor', 'Tell us more (optional)'],
    ['event', 'Tell us more (optional)'],
    ['other', 'Tell us more (optional)'],
  ];

  it('covers exactly the shared follow-up set', () => {
    expect(new Set(followUps.map(([v]) => v))).toEqual(new Set(FOUND_VIA_FOLLOW_UP));
  });

  for (const [value, question] of followUps) {
    it(`shows the follow-up "${question}" for ${value} and announces it`, () => {
      const { fixture, el } = setup();
      choose(fixture, value);
      expect(fixture.componentInstance.value()).toBe(value);
      const input = detailInput(el);
      expect(input).not.toBeNull();
      expect(input!.getAttribute('maxlength')).toBe('200');
      expect(el.querySelector('label[for="test-found-via-detail"]')?.textContent?.trim()).toBe(
        question,
      );
      expect(status(el).textContent?.trim()).toBe(`A follow-up question appeared: ${question}`);
    });
  }

  for (const value of ['linkedin', 'colleague'] as const) {
    it(`shows no follow-up for ${value}`, () => {
      const { fixture, el } = setup();
      choose(fixture, value);
      expect(fixture.componentInstance.value()).toBe(value);
      expect(detailInput(el)).toBeNull();
      expect(status(el).textContent?.trim()).toBe('');
    });
  }

  it('writes the typed follow-up to the detail model', () => {
    const { fixture, el } = setup();
    choose(fixture, 'ai_tool');
    const input = detailInput(el)!;
    input.value = 'best AEC integration directory';
    input.dispatchEvent(new Event('input'));
    expect(fixture.componentInstance.detail()).toBe('best AEC integration directory');
  });

  it('clears the detail and the announcement when the choice moves to one without a follow-up', () => {
    const { fixture, el } = setup();
    choose(fixture, 'search');
    fixture.componentInstance.detail.set('procore revit integration');
    choose(fixture, 'linkedin');
    expect(fixture.componentInstance.detail()).toBe('');
    expect(detailInput(el)).toBeNull();
    expect(status(el).textContent?.trim()).toBe('');
  });

  it('clears everything on "Clear answer", which only appears once answered', () => {
    const { fixture, el } = setup();
    const select = () =>
      fixture.debugElement.query(By.directive(AecSelect)).componentInstance as AecSelect;
    expect(
      select()
        .options()
        .some((o) => o.value === null),
    ).toBe(false);

    choose(fixture, 'event');
    fixture.componentInstance.detail.set('AU 2026');
    expect(select().options()[0]).toEqual({ value: null, label: 'Clear answer' });

    choose(fixture, null);
    expect(fixture.componentInstance.value()).toBe('');
    expect(fixture.componentInstance.detail()).toBe('');
    expect(detailInput(el)).toBeNull();
  });

  it('re-announces when the follow-up question changes', () => {
    const { fixture, el } = setup();
    choose(fixture, 'ai_tool');
    choose(fixture, 'search');
    expect(status(el).textContent?.trim()).toBe(
      'A follow-up question appeared: What did you search for?',
    );
  });
});
