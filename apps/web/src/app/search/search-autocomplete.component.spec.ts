import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AutocompleteController } from './autocomplete-controller';
import type { AutocompleteSuggestion } from './autocomplete-mapping';
import { AUTOCOMPLETE_SEARCH_FACTORY } from './autocomplete-search.factory';
import { SearchAutocomplete } from './search-autocomplete';

/**
 * `ng test` coverage for `SearchAutocomplete`.
 *
 * The Algolia SDK is never loaded: the default tests leave `__AECI_ALGOLIA__`
 * absent (degraded path), so `afterNextRender` finds no config and the box stays
 * a plain submit field. The combobox/listbox ARIA wiring comes from
 * `@angular/aria` directives, which apply during change detection. The live
 * suggestion → open → keyboard-select flow runs against a real Algolia index and
 * is verified manually + in e2e; the debounce/stale logic lives in
 * `autocomplete-controller.component.spec.ts`. Here we assert the a11y contract,
 * graceful degradation, and the two output paths.
 */
type GlobalWithConfig = { __AECI_ALGOLIA__?: unknown };

const SUGGESTION: AutocompleteSuggestion = {
  kind: 'product',
  objectID: 'x',
  title: 'Revit',
  subtitle: 'Autodesk',
  routerLink: ['/products', 'revit'],
};

/** Protected handlers exposed for direct-call tests of the wiring logic. */
type Handlers = {
  onSelect(values: AutocompleteSuggestion[]): void;
  onSubmit(event: Event): void;
};

function setup(): void {
  TestBed.configureTestingModule({
    // Never-resolving factory: even if config were present, the real SDK never
    // loads and the controller stays null (mirrors the `/search` shell spec).
    providers: [
      { provide: AUTOCOMPLETE_SEARCH_FACTORY, useValue: () => new Promise<never>(() => {}) },
    ],
  });
}

describe('SearchAutocomplete', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => {
    delete (globalThis as GlobalWithConfig).__AECI_ALGOLIA__;
    // The CDK overlay renders into a body-level container under jsdom (no Popover
    // API → `usePopover` auto-downgrades), so an opened popup persists on
    // `document.body`. Sweep it between tests so it can't bleed into the next
    // test's `document` queries.
    document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
  });

  it('names the input with a real <label for> (not placeholder-as-label)', async () => {
    setup();
    const fixture = TestBed.createComponent(SearchAutocomplete);
    fixture.componentRef.setInput('inputId', 'hdr-search');
    fixture.detectChanges();
    await fixture.whenStable();

    const host = fixture.nativeElement as HTMLElement;
    const label = host.querySelector('label')!;
    const input = host.querySelector('input')!;
    expect(input.id).toBe('hdr-search');
    expect(label.getAttribute('for')).toBe('hdr-search');
    expect(label.textContent?.trim()).not.toBe('');
  });

  it('exposes combobox semantics on the input', async () => {
    setup();
    const fixture = TestBed.createComponent(SearchAutocomplete);
    fixture.detectChanges();
    await fixture.whenStable();

    const input = (fixture.nativeElement as HTMLElement).querySelector('input')!;
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('name')).toBe('q');
    expect(input.getAttribute('type')).toBe('search');
  });

  it('does not render an empty listbox when typing yields no suggestions', async () => {
    // Aria's combobox expands the popup on EVERY input event, so the popup opens
    // before (or without) any results. The listbox must be gated on a non-empty
    // result set, otherwise an empty `role="listbox"` is rendered — an
    // `aria-required-children` axe violation + an empty floating panel.
    setup(); // degraded path → controller null → suggestions() stays empty
    const fixture = TestBed.createComponent(SearchAutocomplete);
    fixture.detectChanges();
    await fixture.whenStable();

    const host = fixture.nativeElement as HTMLElement;
    const input = host.querySelector('input')!;
    // Focus first: Aria closes an unfocused expanded popup, so a real "typing"
    // scenario requires the input to hold focus.
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    input.value = 'rev';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();

    // Aria opened the combobox on input...
    expect(input.getAttribute('aria-expanded')).toBe('true');
    // ...but no listbox is rendered because there are zero suggestions — neither in
    // the host nor in the CDK overlay container (the popup is portaled out now).
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('degrades to a working submit box and emits the trimmed query', async () => {
    setup(); // __AECI_ALGOLIA__ absent → controller never built
    const fixture = TestBed.createComponent(SearchAutocomplete);
    fixture.detectChanges();
    await fixture.whenStable();

    const emitted: string[] = [];
    fixture.componentInstance.querySubmitted.subscribe((q) => emitted.push(q));

    const host = fixture.nativeElement as HTMLElement;
    const input = host.querySelector('input')!;
    input.value = '  revit  ';
    const form = host.querySelector('form')!;
    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true }));

    expect(emitted).toEqual(['revit']);
    // No listbox is ever rendered without a controller (host or overlay container).
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('renders the suggestion listbox through a connected overlay (out of the form flow) so it cannot grow the header row', async () => {
    // Regression guard for the header-search layout bug, re-expressed for the CDK-overlay
    // architecture (AECI-232). Aria renders the combobox popup in-flow
    // (DeferredContent.createEmbeddedView); an outer cdkConnectedOverlay
    // (usePopover:'inline') lifts the listbox out of the form, so it can no longer grow
    // the row and the header's `items-center` can't shove the input out. Under jsdom
    // there is no Popover API, so CDK downgrades to the body-level `.cdk-overlay-container`
    // — the listbox renders in `document`, NOT inside the host's <form>.
    setup(); // config absent → afterNextRender no-ops; we inject our own settled controller
    const fixture = TestBed.createComponent(SearchAutocomplete);
    fixture.detectChanges();
    await fixture.whenStable();

    // A controller settled to one suggestion, without the Algolia SDK or RUM.
    const controller = new AutocompleteController(
      () => Promise.resolve({ products: [SUGGESTION], vendors: [], nbHits: 1 }),
      () => {},
    );
    controller.setQuery('rev');
    await new Promise((resolve) => setTimeout(resolve, 220)); // past the 180ms debounce
    expect(controller.suggestions().length, 'controller should hold one suggestion').toBe(1);

    // Inject the settled controller (the component normally builds this in afterNextRender).
    (
      fixture.componentInstance as unknown as {
        controller: { set(c: AutocompleteController): void };
      }
    ).controller.set(controller);

    // Drive Aria's expand exactly as the empty-listbox test does (focusin + input),
    // which is what keeps aria-expanded=true in the test environment.
    const host = fixture.nativeElement as HTMLElement;
    const input = host.querySelector('input')!;
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    input.value = 'rev';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // The listbox renders via the overlay — present in `document`, absent from the form.
    const listbox = document.querySelector('[role="listbox"]');
    expect(listbox, 'listbox renders once a query returns ≥1 suggestion').not.toBeNull();
    expect(
      host.querySelector('form [role="listbox"]'),
      'listbox must not live in the form flow — it is portaled into the overlay',
    ).toBeNull();
    // Positioning is the overlay's job now: the element no longer self-positions,
    // but it keeps its visual styling.
    expect(listbox!.classList.contains('absolute'), 'no self-positioning class').toBe(false);
    expect(listbox!.classList.contains('top-full'), 'no self-positioning class').toBe(false);
    expect(listbox!.classList.contains('shadow-lg'), 'visual styling stays on the <ul>').toBe(true);
  });

  it('emits suggestionChosen on commit and suppresses the coincident submit', () => {
    setup();
    const fixture = TestBed.createComponent(SearchAutocomplete);
    fixture.detectChanges();

    const chosen: AutocompleteSuggestion[] = [];
    const submitted: string[] = [];
    fixture.componentInstance.suggestionChosen.subscribe((s) => chosen.push(s));
    fixture.componentInstance.querySubmitted.subscribe((q) => submitted.push(q));

    const api = fixture.componentInstance as unknown as Handlers;
    api.onSelect([SUGGESTION]);
    expect(chosen).toEqual([SUGGESTION]);

    // The Enter that committed the option would also fire the form submit; it
    // must be swallowed so the parent doesn't also navigate to /search.
    const form = (fixture.nativeElement as HTMLElement).querySelector('form')!;
    form.dispatchEvent(new SubmitEvent('submit', { cancelable: true }));
    expect(submitted).toEqual([]);
  });

  it('navigates to /search on a real Enter keydown (Aria preventDefaults the native submit)', async () => {
    // The exact regression AECI-191 fixes: Aria expands the combobox on input and
    // preventDefaults Enter, so the native <form> submit never fires under JS. A
    // real keydown Enter on the input must still emit the trimmed query. The old
    // spec dispatched a synthetic `submit` straight at the <form>, bypassing the
    // key handler entirely, so it never caught this.
    setup(); // degraded path → no suggestions → no active option
    const fixture = TestBed.createComponent(SearchAutocomplete);
    fixture.detectChanges();
    await fixture.whenStable();

    const emitted: string[] = [];
    fixture.componentInstance.querySubmitted.subscribe((q) => emitted.push(q));

    const host = fixture.nativeElement as HTMLElement;
    const input = host.querySelector('input')!;
    input.value = '  revit  ';
    input.dispatchEvent(new Event('input', { bubbles: true })); // Aria expands here
    fixture.detectChanges();

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(enter);

    expect(emitted).toEqual(['revit']);
    expect(enter.defaultPrevented, 'native form submit must be suppressed').toBe(true);
  });

  it('yields Enter to a keyboard-highlighted suggestion (no /search navigation)', async () => {
    // When a suggestion is active the combobox sets aria-activedescendant and Aria
    // commits it on Enter (→ suggestionChosen). onEnterKey must NOT also emit
    // querySubmitted, or the parent would double-navigate.
    setup();
    const fixture = TestBed.createComponent(SearchAutocomplete);
    fixture.detectChanges();
    await fixture.whenStable();

    const emitted: string[] = [];
    fixture.componentInstance.querySubmitted.subscribe((q) => emitted.push(q));

    const host = fixture.nativeElement as HTMLElement;
    const input = host.querySelector('input')!;
    input.value = 'revit';
    // Simulate Aria having highlighted an option (the combobox binds this attr).
    input.setAttribute('aria-activedescendant', 'aec-search-ac-option-0');

    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    expect(emitted).toEqual([]);
  });
});
