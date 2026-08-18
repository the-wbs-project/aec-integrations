/**
 * AECI-303 (§9.1) — `PairVersionSelect`: one of the pair page's two version selectors.
 *
 * A non-editable Angular Aria combobox whose listbox is deferred behind a
 * `cdkConnectedOverlay` (ADR 0010). Per the repo convention (see
 * `admin/admin-select.component.spec.ts` and
 * `search/widgets/search-sort-by.component.spec.ts`) we assert the CLOSED combobox
 * wiring, the trigger label, and that the listbox is absent while closed; the
 * open→select interaction is jsdom-hostile and is covered live instead. The
 * parent-facing half — a chosen label reaching the URL — is asserted in
 * `products-pair.component.spec.ts`, which drives `setVersion` directly.
 *
 * The id-determinism case is the one that earns its keep here. This is the **first
 * Aria combobox in the repo that SSRs**: the two existing instances use a
 * module-level `let nextId = 0` counter, justified in their own comments by being
 * browser-only. Module state persists per Worker isolate, so copying that counter
 * would emit ids that differ between the server render and the client and break the
 * `aria-labelledby` association after hydration.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PairVersionSelect, type PairVersionOption } from './pair-version-select';

/** Ascending, as the API sends them — `2026.9` before `2026.10`. */
const VERSIONS: readonly PairVersionOption[] = [
  { label: '2026.1', releasedAt: null },
  { label: '2026.9', releasedAt: null },
  { label: '2026.10', releasedAt: '2026-06-01' },
];

function setup(
  value: string | null = '2026.10',
  side: 'context' | 'other' = 'context',
  options = VERSIONS,
) {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(PairVersionSelect);
  fixture.componentRef.setInput('side', side);
  fixture.componentRef.setInput('label', side === 'context' ? 'Procore version' : 'Revit version');
  fixture.componentRef.setInput('options', options);
  fixture.componentRef.setInput('value', value);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

const trigger = (el: HTMLElement) => el.querySelector('button') as HTMLButtonElement;

describe('PairVersionSelect', () => {
  beforeEach(() => TestBed.resetTestingModule());
  // The deferred listbox renders into a body-level CDK overlay container under
  // jsdom (no Popover API); sweep any leak between tests.
  afterEach(() => document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove()));

  it('renders a labelled, closed Aria combobox trigger', () => {
    const { el } = setup();
    const label = el.querySelector('#pair-version-label-context');
    expect(label?.textContent?.trim()).toBe('Procore version');

    const btn = trigger(el);
    expect(btn.getAttribute('role')).toBe('combobox');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-labelledby')).toBe(`${label!.id} ${btn.id}`);
  });

  it('does not render the listbox while closed — so SSR emits only the trigger', () => {
    // `[cdkConnectedOverlayOpen]="expanded()"` is what keeps this control safe to
    // server-render at all.
    setup();
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
  });

  it('derives its ids from the SIDE, deterministically across instances', () => {
    // A module-level counter would make these differ between the SSR render and the
    // client. Rendering the same side twice must produce the same ids.
    expect(trigger(setup('2026.10', 'context').el).id).toBe('pair-version-trigger-context');

    TestBed.resetTestingModule();
    expect(trigger(setup('2026.10', 'other').el).id).toBe('pair-version-trigger-other');

    TestBed.resetTestingModule();
    expect(trigger(setup('2026.10', 'context').el).id).toBe('pair-version-trigger-context');
  });

  it('shows the RESOLVED label on the trigger, not the raw query param', () => {
    // A stale or renamed label degrades to latest server-side, so the control shows
    // what was actually rendered rather than what the URL asked for.
    expect(trigger(setup('2026.9').el).textContent?.trim()).toBe('2026.9');
  });

  it('follows the bound value when the parent changes it', () => {
    const { fixture, el } = setup('2026.9');
    fixture.componentRef.setInput('value', '2026.1');
    fixture.detectChanges();
    expect(trigger(el).textContent?.trim()).toBe('2026.1');
  });

  it('renders an empty trigger rather than throwing when nothing is selected', () => {
    // Reachable for a product with no releases. The parent suppresses the control in
    // that case, but the component must not depend on that.
    expect(trigger(setup(null).el).textContent?.trim()).toBe('');
  });

  it('survives the option list being replaced (a client-side nav to another pair)', () => {
    const { fixture, el } = setup('2026.10');
    fixture.componentRef.setInput('options', [
      { label: 'v4', releasedAt: null },
      { label: 'v5', releasedAt: null },
    ]);
    fixture.componentRef.setInput('value', 'v5');
    fixture.detectChanges();
    expect(trigger(el).textContent?.trim()).toBe('v5');
  });
});
