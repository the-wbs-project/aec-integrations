import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ListingSortSelect, type ListingSortOption } from './listing-sort-select';

/**
 * The sort control on every listing (AECI-175, shared since AECI-1486). A
 * non-editable Angular Aria combobox whose listbox is deferred behind a
 * `cdkConnectedOverlay`. Per the repo convention (see
 * `reviews/review-form.component.spec.ts`) we assert the CLOSED combobox wiring +
 * the trigger label + that the listbox is not in the DOM while closed; the
 * open→select interaction is covered by the `/products` and `/search` e2e.
 */

const OPTIONS: readonly ListingSortOption[] = [
  { value: 'created', label: 'Newest' },
  { value: 'name', label: 'Name (A–Z)' },
];

function setup(value = 'created') {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(ListingSortSelect);
  fixture.componentRef.setInput('options', OPTIONS);
  fixture.componentRef.setInput('value', value);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

@Component({
  imports: [ListingSortSelect],
  template: `
    <aec-listing-sort-select [options]="options" [value]="value()" />
    <aec-listing-sort-select [options]="options" [value]="value()" />
  `,
})
class TwoControls {
  readonly options = OPTIONS;
  readonly value = signal('created');
}

describe('ListingSortSelect', () => {
  beforeEach(() => TestBed.resetTestingModule());
  // The deferred listbox renders into a body-level CDK overlay container under
  // jsdom (no Popover API); sweep any leak between tests.
  afterEach(() => document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove()));

  it('renders a labelled, closed Aria combobox trigger', () => {
    const { el } = setup();
    const label = el.querySelector('[id^="aec-listing-sort-label-"]');
    expect(label?.textContent?.trim()).toBe('Sort');

    const trigger = el.querySelector('button') as HTMLButtonElement;
    expect(trigger.getAttribute('role')).toBe('combobox');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // The trigger is named by the "Sort" label + its own contents.
    expect(trigger.getAttribute('aria-labelledby')).toBe(`${label!.id} ${trigger.id}`);
  });

  it('shows the active sort’s label in the trigger', () => {
    const { el } = setup('name');
    const trigger = el.querySelector('button') as HTMLButtonElement;
    expect(trigger.textContent).toContain('Name (A–Z)');
  });

  it('updates the trigger label when the bound value changes (tab switch)', () => {
    const { fixture, el } = setup('created');
    expect((el.querySelector('button') as HTMLButtonElement).textContent).toContain('Newest');
    fixture.componentRef.setInput('value', 'name');
    fixture.detectChanges();
    expect((el.querySelector('button') as HTMLButtonElement).textContent).toContain('Name (A–Z)');
  });

  it('does not render the listbox while the popup is closed', () => {
    const { el } = setup();
    expect(el.querySelector('[role="listbox"]')).toBeNull();
    expect(document.querySelector('ul[aria-label="Sort"]')).toBeNull();
  });

  // The ids come from a root-scoped counter, so a fresh render (a fresh root
  // injector, as SSR makes per request) starts at 0 again, and SSR and hydration
  // agree. A module-level counter would keep climbing across requests.
  it('numbers its ids per render, from 0, unique within the render', () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const first = TestBed.createComponent(TwoControls);
    first.detectChanges();
    const ids = [...(first.nativeElement as HTMLElement).querySelectorAll('button')].map(
      (b) => b.id,
    );
    expect(ids).toEqual(['aec-listing-sort-0', 'aec-listing-sort-1']);

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const second = TestBed.createComponent(TwoControls);
    second.detectChanges();
    expect((second.nativeElement as HTMLElement).querySelector('button')!.id).toBe(
      'aec-listing-sort-0',
    );
  });
});
