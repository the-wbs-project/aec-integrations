/**
 * `aec-search-autocomplete` — the reusable search-as-you-type autocomplete
 * (AECI-144 / Phase 3.11). Mounted in the site header now; the home hero reuses
 * it in Phase 4 (the home page doesn't exist yet).
 *
 * Search runs BROWSER-SIDE against Algolia with the search-only key (§7.5) — the
 * same `window.__AECI_ALGOLIA__` config the `/search` page reads. The component
 * SSR-renders ONLY the static `<form>` + `<label>` + `<input>` (visitor-state-
 * neutral, so it is safe inside cached headers); after hydration,
 * `afterNextRender` reads the config, dynamically loads `algoliasearch/lite` via
 * the `AUTOCOMPLETE_SEARCH_FACTORY` seam, and starts `AutocompleteController`,
 * whose signals drive the dropdown. When the config is absent (local dev / an
 * unprovisioned env) the controller is never built and the box stays a plain
 * submit-to-`/search` field — no error UI (correct for a header field).
 *
 * A11y: this is the project's FIRST `@angular/aria` combobox adoption (ADR 0010).
 * `ngCombobox` + `ngListbox`/`ngOption` supply role=combobox/listbox/option,
 * `aria-expanded`/`aria-controls`/`aria-activedescendant`, the Arrow/Home/End/
 * Escape keyboard model, and the CDK-Overlay-positioned popup; we supply only the
 * HTML + token CSS (`data-[active=true]:` highlight, `aria-selected`). A real
 * `<label for>` names the input (never placeholder-as-label).
 *
 * Navigation lives in the PARENT (mirrors `navigateToSearch`): the component is
 * Router-free and emits `suggestionChosen` (an option committed → detail page)
 * and `querySubmitted` (Enter with no option → `/search?q=`). The wrapping
 * `<form action="/search" method="get">` is the no-JS base layer.
 *
 * Empty results: Aria expands the combobox on every keystroke, so the popup
 * itself opens, but the `ngListbox` is rendered only when there is ≥1 hit — a
 * zero-hit query therefore shows no listbox (kept strictly `role=option`-only
 * and axe-clean, with no empty floating panel). Enter still routes to `/search`,
 * which owns the "no results" empty state (§4.6).
 */
import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Combobox, ComboboxPopup, ComboboxWidget } from '@angular/aria/combobox';
import { Listbox, Option } from '@angular/aria/listbox';

import { readAlgoliaConfig } from './algolia-config';
import { AutocompleteController } from './autocomplete-controller';
import type { AutocompleteSuggestion } from './autocomplete-mapping';
import { AUTOCOMPLETE_SEARCH_FACTORY } from './autocomplete-search.factory';

@Component({
  selector: 'aec-search-autocomplete',
  imports: [Combobox, ComboboxPopup, ComboboxWidget, Listbox, Option],
  template: `
    <form
      class="relative block"
      role="search"
      action="/search"
      method="get"
      (submit)="onSubmit($event)"
    >
      <label [attr.for]="inputId()" class="sr-only" i18n="@@app.search.autocomplete.label"
        >Search</label
      >
      <input
        ngCombobox
        #combobox="ngCombobox"
        [id]="inputId()"
        name="q"
        type="search"
        autocomplete="off"
        [(value)]="queryModel"
        [(expanded)]="expanded"
        (input)="onInput($event)"
        (keydown.enter)="onEnterKey($event)"
        (focus)="onFocus()"
        (blur)="focused.set(false)"
        [placeholder]="placeholderText()"
        [class]="
          inputClass() +
          ' h-9 rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-4 text-sm text-(--text-primary) placeholder:text-(--text-secondary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)'
        "
      />

      <ng-template ngComboboxPopup [combobox]="combobox" popupType="listbox">
        <!--
          Render the listbox ONLY when there is at least one hit. Aria's combobox
          expands on every input event (its input handler sets expanded), and the
          deferred popup renders whenever expanded, so gating expansion can't keep
          an empty role=listbox out of the DOM. Gating the listbox itself does: a
          zero-hit query mounts no widget, so there's no empty floating panel, no
          dangling aria-controls, and no aria-required-children axe violation.
        -->
        @if (suggestions().length > 0) {
          <ul
            ngComboboxWidget
            ngListbox
            #listbox="ngListbox"
            [(value)]="selected"
            (valueChange)="onSelect($event)"
            [activeDescendant]="listbox.activeDescendant()"
            focusMode="activedescendant"
            selectionMode="explicit"
            i18n-aria-label="@@app.search.autocomplete.listbox.aria"
            aria-label="Search suggestions"
            class="m-0 flex max-h-[min(24rem,60vh)] w-[min(22rem,calc(100vw-2rem))] list-none flex-col gap-0.5 overflow-y-auto rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-1.5 shadow-lg"
          >
            @for (s of suggestions(); track s.objectID) {
              <li
                ngOption
                [value]="s"
                [label]="s.title"
                class="flex cursor-pointer flex-col gap-0.5 rounded-(--radius-sm) px-3 py-2 data-[active=true]:bg-(--surface-sunken)"
              >
                <span class="flex items-center justify-between gap-2">
                  <span class="truncate text-sm font-medium text-(--text-primary)">{{
                    s.title
                  }}</span>
                  <span
                    class="shrink-0 rounded-full border border-(--border-default) px-2 py-0.5 text-[0.65rem] font-medium tracking-wide text-(--text-secondary) uppercase"
                    >{{ s.kind === 'product' ? productTag : vendorTag }}</span
                  >
                </span>
                @if (s.subtitle) {
                  <span class="truncate text-xs text-(--text-secondary)">{{ s.subtitle }}</span>
                }
              </li>
            }
          </ul>
        }
      </ng-template>
    </form>
  `,
})
export class SearchAutocomplete {
  /** Unique id so multiple instances (header + future hero) don't collide. */
  readonly inputId = input('aec-search-ac');
  /** Tailwind width utility for the input — header `w-52`, mobile `w-full`. */
  readonly inputClass = input('w-52');
  /** Optional placeholder override; defaults to the localized house copy. */
  readonly placeholder = input<string | undefined>(undefined);

  /** Emitted when Enter is pressed with no suggestion chosen → `/search?q=`. */
  readonly querySubmitted = output<string>();
  /** Emitted when a suggestion is committed → its detail page. */
  readonly suggestionChosen = output<AutocompleteSuggestion>();

  /** Combobox text value (two-way with `ngCombobox`). */
  protected readonly queryModel = signal('');
  /** Popup open state (two-way with `ngCombobox`; Aria closes on Escape/blur). */
  protected readonly expanded = signal(false);
  /** Listbox selection (two-way with `ngListbox`); reset after each commit. */
  protected readonly selected = signal<AutocompleteSuggestion[]>([]);
  /** Whether the input currently holds focus — gates opening on late responses. */
  protected readonly focused = signal(false);

  protected readonly productTag = $localize`:@@app.search.autocomplete.kind.product:Product`;
  protected readonly vendorTag = $localize`:@@app.search.autocomplete.kind.vendor:Vendor`;

  private readonly defaultPlaceholder = $localize`:@@app.search.autocomplete.placeholder:Search integrations`;
  protected readonly placeholderText = computed(
    () => this.placeholder() ?? this.defaultPlaceholder,
  );

  private readonly factory = inject(AUTOCOMPLETE_SEARCH_FACTORY);
  private readonly destroyRef = inject(DestroyRef);
  /** The browser-only controller; a signal so the open-effect tracks it. */
  private readonly controller = signal<AutocompleteController | null>(null);
  private destroyed = false;

  /** Flat suggestion list (products then vendors) for the template. */
  protected readonly suggestions = computed<readonly AutocompleteSuggestion[]>(
    () => this.controller()?.suggestions() ?? [],
  );

  constructor() {
    // Re-open the popup once a query settles with ≥1 hit AND the input is focused
    // — covers results that arrive after the popup was dismissed (Escape) while
    // still focused. Aria already expands on input, so this is not the only opener;
    // the empty case is handled by gating the listbox's *rendering* on a non-empty
    // result set (see template), not by withholding expansion. Only ever OPENS
    // here — Escape/blur close via the two-way `expanded` model, and the effect
    // won't re-fire on those (it tracks `suggestions()`/`focused()`, which they
    // don't change), so Escape sticks until the result set next changes.
    effect(() => {
      if (this.suggestions().length > 0 && this.focused()) this.expanded.set(true);
    });

    // Browser-only: read the injected public config, load the lite SDK, start the
    // controller. Absent/failed config ⇒ the box stays a plain submit field.
    afterNextRender(() => {
      const config = readAlgoliaConfig();
      if (!config) return;
      void this.factory(config)
        .then((searchFn) => {
          if (this.destroyed) return;
          this.controller.set(new AutocompleteController(searchFn));
        })
        .catch((error: unknown) => {
          // Autocomplete must never break the header — degrade silently.
          console.warn('Autocomplete failed to initialise', error);
        });
    });

    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.controller()?.dispose();
    });
  }

  protected onInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.controller()?.setQuery(value);
    if (!value.trim()) this.expanded.set(false);
  }

  protected onFocus(): void {
    this.focused.set(true);
    if (this.suggestions().length > 0 && this.queryModel().trim()) this.expanded.set(true);
  }

  private suppressSubmit = false;

  /**
   * Enter inside the combobox → `/search?q=` (the JS path).
   *
   * Aria's `ComboboxPattern` `preventDefault`s Enter whenever the popup is
   * expanded — and it expands on every keystroke — so the native `<form>` submit
   * that `onSubmit` relies on never fires under JS (AECI-191). We re-create the
   * submit here, but YIELD to a keyboard-highlighted suggestion: while one is
   * active the combobox sets `aria-activedescendant`, and Aria commits that
   * option on Enter (→ `onSelect` → `suggestionChosen`), so navigating to
   * `/search` too would double-navigate. Reading the attribute is synchronous and
   * avoids the relay/effect timing a microtask-based guard would race against.
   *
   * `preventDefault()` here also suppresses the native form submit, so `onSubmit`
   * never double-fires for the same Enter — it stays purely the no-JS base layer.
   */
  protected onEnterKey(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.getAttribute('aria-activedescendant')) return;
    event.preventDefault();
    this.expanded.set(false);
    this.querySubmitted.emit(input.value.trim());
  }

  /** Native form submit (no-JS base layer) → `/search?q=`. Under JS, Enter is
   * owned by `onEnterKey`; this still guards the post-commit suppression. */
  protected onSubmit(event: Event): void {
    event.preventDefault();
    if (this.suppressSubmit) return; // a suggestion was just committed
    this.expanded.set(false);
    // Read the live input value from the form (name="q") rather than the Aria
    // value model, so the trimmed query is correct regardless of binding timing
    // — the same read the no-JS native GET performs.
    const raw = new FormData(event.target as HTMLFormElement).get('q');
    this.querySubmitted.emit(typeof raw === 'string' ? raw.trim() : '');
  }

  protected onSelect(values: AutocompleteSuggestion[]): void {
    const chosen = values.at(-1);
    if (!chosen) return; // the post-commit reset to [] re-enters here — ignore
    // Suppress the form submit that an Enter-commit would otherwise also fire.
    this.suppressSubmit = true;
    queueMicrotask(() => (this.suppressSubmit = false));
    this.expanded.set(false);
    this.selected.set([]); // allow re-choosing the same item later (mobile reopen)
    this.suggestionChosen.emit(chosen);
  }
}
