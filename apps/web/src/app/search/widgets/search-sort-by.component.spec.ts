import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SearchSortBy, type SortUiOption } from './search-sort-by';

/**
 * AECI-175 — the per-tab sort control. A non-editable Angular Aria combobox whose
 * listbox is deferred behind a `cdkConnectedOverlay`. Per the repo convention
 * (see `reviews/review-form.component.spec.ts`) we assert the CLOSED combobox
 * wiring + the trigger label + that the listbox is not in the DOM while closed;
 * the open→select interaction is covered by the live `/search` e2e.
 */

const OPTIONS: readonly SortUiOption[] = [
  { value: 'preview_products', label: 'Relevance' },
  { value: 'preview_products_integration_count_desc', label: 'Most integrations' },
  { value: 'preview_products_name_asc', label: 'Name (A–Z)' },
];

function setup(value = 'preview_products') {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(SearchSortBy);
  fixture.componentRef.setInput('options', OPTIONS);
  fixture.componentRef.setInput('value', value);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('SearchSortBy', () => {
  beforeEach(() => TestBed.resetTestingModule());
  // The deferred listbox renders into a body-level CDK overlay container under
  // jsdom (no Popover API); sweep any leak between tests.
  afterEach(() => document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove()));

  it('renders a labelled, closed Aria combobox trigger', () => {
    const { el } = setup();
    const label = el.querySelector('[id^="search-sort-label-"]');
    expect(label?.textContent?.trim()).toBe('Sort');

    const trigger = el.querySelector('button') as HTMLButtonElement;
    expect(trigger.getAttribute('role')).toBe('combobox');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // The trigger is named by the "Sort" label + its own contents.
    expect(trigger.getAttribute('aria-labelledby')).toBe(`${label!.id} ${trigger.id}`);
  });

  it('shows the active sort’s label in the trigger', () => {
    const { el } = setup('preview_products_name_asc');
    const trigger = el.querySelector('button') as HTMLButtonElement;
    expect(trigger.textContent).toContain('Name (A–Z)');
  });

  it('updates the trigger label when the bound value changes (tab switch)', () => {
    const { fixture, el } = setup('preview_products');
    expect((el.querySelector('button') as HTMLButtonElement).textContent).toContain('Relevance');
    fixture.componentRef.setInput('value', 'preview_products_integration_count_desc');
    fixture.detectChanges();
    expect((el.querySelector('button') as HTMLButtonElement).textContent).toContain(
      'Most integrations',
    );
  });

  it('does not render the listbox while the popup is closed', () => {
    const { el } = setup();
    expect(el.querySelector('[role="listbox"]')).toBeNull();
    expect(document.querySelector('ul[aria-label="Sort results"]')).toBeNull();
  });
});
