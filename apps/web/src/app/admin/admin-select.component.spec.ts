/**
 * AECI-577 — `AdminSelect`: the panel's discrete-choice filter control.
 *
 * A non-editable Angular Aria combobox whose listbox is deferred behind a
 * `cdkConnectedOverlay` (ADR 0010). Per the repo convention (see
 * `search/widgets/search-sort-by.component.spec.ts` and
 * `reviews/review-form.component.spec.ts`) we assert the CLOSED combobox wiring,
 * the trigger label, and that the listbox is absent while closed; the
 * open→select interaction is jsdom-hostile and is covered live instead.
 *
 * The parent-facing half — a chosen value reaching the feed and re-running the
 * query — is asserted in `activity/activity-feed.component.spec.ts`, which drives
 * this component's `changed` output directly.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdminSelect, type AdminSelectOption } from './admin-select';

const OPTIONS: readonly AdminSelectOption[] = [
  { value: null, label: 'Any source' },
  { value: 'Google', label: 'Google' },
  { value: 'Direct', label: 'Direct' },
];

function setup(value: string | null = null, options = OPTIONS) {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(AdminSelect);
  fixture.componentRef.setInput('label', 'Source');
  fixture.componentRef.setInput('options', options);
  fixture.componentRef.setInput('value', value);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

const trigger = (el: HTMLElement) => el.querySelector('button') as HTMLButtonElement;

describe('AdminSelect', () => {
  beforeEach(() => TestBed.resetTestingModule());
  // The deferred listbox renders into a body-level CDK overlay container under
  // jsdom (no Popover API); sweep any leak between tests.
  afterEach(() => document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove()));

  it('renders a labelled, closed Aria combobox trigger', () => {
    const { el } = setup();
    const label = el.querySelector('[id^="admin-select-label-"]');
    expect(label?.textContent?.trim()).toBe('Source');

    const btn = trigger(el);
    expect(btn.getAttribute('role')).toBe('combobox');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-labelledby')).toBe(`${label!.id} ${btn.id}`);
  });

  it('shows the "any" label when nothing is filtered', () => {
    // "No filter" has to be a real, visible choice — not an unlabelled blank.
    expect(trigger(setup(null).el).textContent?.trim()).toBe('Any source');
  });

  it('shows the active value in the trigger', () => {
    expect(trigger(setup('Google').el).textContent?.trim()).toBe('Google');
  });

  it('follows the bound value when the parent changes it', () => {
    const { fixture, el } = setup('Google');
    fixture.componentRef.setInput('value', 'Direct');
    fixture.detectChanges();
    expect(trigger(el).textContent?.trim()).toBe('Direct');
  });

  it('re-selects correctly when the option list is replaced (a new window)', () => {
    const { fixture, el } = setup('Google');
    fixture.componentRef.setInput('options', [
      { value: null, label: 'Any source' },
      { value: 'Google', label: 'Google' },
      { value: 'Bing', label: 'Bing' },
    ]);
    fixture.detectChanges();
    expect(trigger(el).textContent?.trim()).toBe('Google');
  });

  it('leaves the trigger blank when the value is not among the options', () => {
    // Happens when the window moves and the previously-chosen source has no rows
    // in it. The feed still holds the filter; the control just cannot name it.
    expect(trigger(setup('Ecosia').el).textContent?.trim()).toBe('');
  });

  it('does not render the listbox while the popup is closed', () => {
    const { el } = setup();
    expect(el.querySelector('[role="listbox"]')).toBeNull();
    expect(document.querySelector('ul[aria-label="Source"]')).toBeNull();
  });
});
