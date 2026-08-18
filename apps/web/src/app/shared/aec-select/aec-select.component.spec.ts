/**
 * `AecSelect`: the app's discrete-choice "select" control (AECI-577 as
 * `AdminSelect`; promoted to `shared/` by AECI-606).
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

import { AecSelect, type AecSelectOption } from './aec-select';

const OPTIONS: readonly AecSelectOption[] = [
  { value: null, label: 'Any source' },
  { value: 'Google', label: 'Google' },
  { value: 'Direct', label: 'Direct' },
];

function setup(
  value: string | null = null,
  options = OPTIONS,
  extra: Record<string, unknown> = {},
) {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(AecSelect);
  fixture.componentRef.setInput('label', 'Source');
  fixture.componentRef.setInput('options', options);
  fixture.componentRef.setInput('value', value);
  for (const [key, val] of Object.entries(extra)) fixture.componentRef.setInput(key, val);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

const trigger = (el: HTMLElement) => el.querySelector('button') as HTMLButtonElement;

describe('AecSelect', () => {
  beforeEach(() => TestBed.resetTestingModule());
  // The deferred listbox renders into a body-level CDK overlay container under
  // jsdom (no Popover API); sweep any leak between tests.
  afterEach(() => document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove()));

  it('renders a labelled, closed Aria combobox trigger', () => {
    const { el } = setup();
    const label = el.querySelector('[id$="-label"]');
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

  // ─── AECI-606 additions ────────────────────────────────────────────────────

  it('shows the placeholder instead of a blank trigger when nothing matches', () => {
    // A required field has no "Any …" row to fall back on, so a blank trigger
    // would be an unlabelled control rather than a legible "not chosen yet".
    const { el } = setup(null, [{ value: 'rfis', label: 'RFIs' }], {
      placeholder: 'Choose a data object',
    });
    expect(trigger(el).textContent?.trim()).toBe('Choose a data object');
  });

  it('soft-disables the trigger — aria-disabled, still focusable', () => {
    // Aria's default is `softDisabled`, so the native attribute is never set and
    // the control stays in the tab order. Asserting the real contract here is
    // what stops someone styling it with the `disabled:` variant, which would
    // silently never match.
    const btn = trigger(setup(null, [], { disabled: true }).el);
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.hasAttribute('disabled')).toBe(false);
    expect(btn.getAttribute('tabindex')).toBe('0');
    expect(btn.className).toContain('aria-disabled:opacity-50');
  });

  it('derives stable ids from `idPrefix` rather than the module counter', () => {
    // The vendor tab renders one of these per claim, so ids must survive a
    // re-render and must not collide across instances.
    const { el } = setup(null, OPTIONS, { idPrefix: 'vendor-claim-abc-introduced' });
    const btn = trigger(el);
    expect(btn.id).toBe('vendor-claim-abc-introduced-trigger');
    expect(el.querySelector('[id$="-label"]')?.id).toBe('vendor-claim-abc-introduced-label');
    expect(btn.getAttribute('aria-labelledby')).toBe(
      'vendor-claim-abc-introduced-label vendor-claim-abc-introduced-trigger',
    );
  });

  it('associates a described-by target when given one', () => {
    const { el } = setup(null, OPTIONS, { describedBy: 'field-error' });
    expect(trigger(el).getAttribute('aria-describedby')).toBe('field-error');
  });

  it('omits aria-describedby when there is nothing to point at', () => {
    expect(trigger(setup().el).hasAttribute('aria-describedby')).toBe(false);
  });

  it('renders a full-width stacked field when asked, without changing the ARIA wiring', () => {
    const { el } = setup('Google', OPTIONS, { layout: 'stacked' });
    const btn = trigger(el);
    expect(btn.className).toContain('w-full');
    expect(btn.getAttribute('role')).toBe('combobox');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });
});
