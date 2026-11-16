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
 * `aria-expanded`/`aria-controls`/`aria-activedescendant`, and the Arrow/Home/End/
 * Escape keyboard model; we supply only the HTML + token CSS (`data-[active=true]:`
 * highlight, `aria-selected`). Aria's `ComboboxPopup` renders the listbox via
 * `DeferredContent`'s `createEmbeddedView` and is NOT itself a floating layer, so
 * an outer `cdkConnectedOverlay` (`usePopover:'inline'` → browser top layer)
 * supplies the positioning: it flips/repositions near the viewport edge and
 * escapes the header row's clipping/stacking context, per ADR 0010 ("Aria supplies
 * behavior, not the floating layer"). The `<ul>` only styles — it no longer
 * self-positions. (Under jsdom there is no Popover API, so CDK auto-downgrades to
 * the body-level overlay container; the component spec therefore queries `document`,
 * not the host — see `search-autocomplete.component.spec.ts`.) A real `<label for>`
 * names the input (never placeholder-as-label).
 *
 * Navigation lives in the PARENT (mirrors `navigateToSearch`): the component is
 * Router-free and emits `suggestionChosen` (an option committed → detail page)
 * and `querySubmitted` (Enter with no option → `/search?q=`). The wrapping
 * `<form action="/search" method="get">` is the no-JS base layer.
 *
 * A third mount, the claim dialog's Find step (`shared/claim-dialog/`, AECI-1293),
 * uses the optional hooks the header leaves at their defaults: a visible `label`
 * and a taller `inputHeightClass`. All of them default to the header's markup and
 * behavior.
 *
 * The home hero's pair finder (AECI-1555) mounts two more instances with three
 * further optional hooks: `kinds` limits the suggestions to products,
 * `ownForm = false` drops the wrapping `<form>` so the finder's own form can hold
 * both fields without nesting forms, and `fillOnSelect` writes the chosen title
 * into the field. All three default to the header's behavior.
 *
 * Landmark name (AECI-830): the owned `<form role="search">` is named by
 * `searchName`, default "Site search". Home renders the header box and the hero
 * box at once, and two unnamed search landmarks read as two identical "search"
 * entries in a screen reader's landmarks list. So every mount that can share a
 * page with the header passes its own name: the hero passes "Search the
 * directory", the claim dialog "Find your listing". The header's three mounts
 * (inline box, compact trigger, mobile menu) keep the default, because only one
 * of them is in the accessibility tree at any breakpoint. With `ownForm = false`
 * there is no form and the parent names its own landmark.
 *
 * Empty results: Aria expands the combobox on every keystroke, so the popup
 * itself opens, but the `ngListbox` is rendered only when there is ≥1 hit — a
 * zero-hit query therefore shows no listbox (kept strictly `role=option`-only,
 * with no empty floating panel). A second effect then collapses the combobox,
 * because `aria-expanded="true"` with no listbox has no `aria-controls`, which
 * axe reports as a critical `aria-required-attr` (AECI-1308; `docs-search.ts`
 * follows the same rule). Enter still routes to `/search`, which owns the
 * "no results" empty state (§4.6).
 */
import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Combobox, ComboboxPopup, ComboboxWidget } from '@angular/aria/combobox';
import { Listbox, Option } from '@angular/aria/listbox';
import {
  type ConnectedPosition,
  createRepositionScrollStrategy,
  OverlayModule,
  type ScrollStrategy,
} from '@angular/cdk/overlay';
import { ScrollDispatcher } from '@angular/cdk/scrolling';
import { NgTemplateOutlet } from '@angular/common';

import { Analytics } from '../analytics/analytics';
import { readAlgoliaConfig } from './algolia-config';
import { AutocompleteController } from './autocomplete-controller';
import type { AutocompleteSuggestion } from './autocomplete-mapping';
import { AUTOCOMPLETE_SEARCH_FACTORY } from './autocomplete-search.factory';
import { isReplayedEvent } from '../core/event-replay';
import { Chip } from '../shared/chip/chip';
import { AecIcon } from '../shared/icon/icon';

const DEFAULT_FIELD_CLASS =
  'rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-4 text-sm text-(--text-primary) placeholder:text-(--text-secondary)';

/**
 * What a pill adds: room for the glyph at the start and the cap at the end, and
 * no native clear button (it would sit under the cap). `peer` lets the cap follow
 * the field's hover.
 */
const PILL_FIELD_CLASS = 'peer pe-20 ps-12 [&::-webkit-search-cancel-button]:appearance-none';

/** `fitToViewport`: the gap to the field, the margin to the screen edge, the cap. */
const LIST_GAP = 4;
const LIST_MARGIN = 8;
const LIST_MAX = 384;
/** With less room than this under the field, the list opens above if there is more room there. */
const LIST_PREFERRED_MIN = 240;

/** The header search landmark's name. Bound, never an interpolated `i18n-*` attribute. */
const DEFAULT_SEARCH_NAME = $localize`:@@app.search.autocomplete.landmark:Site search`;

@Component({
  selector: 'aec-search-autocomplete',
  imports: [
    Combobox,
    ComboboxPopup,
    ComboboxWidget,
    Listbox,
    NgTemplateOutlet,
    Option,
    OverlayModule,
    Chip,
    AecIcon,
  ],
  template: `
    @if (ownForm()) {
      <form
        class="relative block"
        role="search"
        [attr.aria-label]="searchName()"
        action="/search"
        method="get"
        (submit)="onSubmit($event)"
      >
        <ng-container [ngTemplateOutlet]="field" />
      </form>
    } @else {
      <!-- Formless mount: the parent's own form owns submission (no nested forms). -->
      <div class="relative block">
        <ng-container [ngTemplateOutlet]="field" />
      </div>
    }

    <ng-template #field>
      @if (label(); as text) {
        <label [attr.for]="inputId()" [class]="labelVisible() ? labelClass() : 'sr-only'">{{
          text
        }}</label>
      } @else {
        <label [attr.for]="inputId()" class="sr-only" i18n="@@app.search.autocomplete.label"
          >Search</label
        >
      }
      <input
        ngCombobox
        #combobox="ngCombobox"
        #acOrigin
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
          ' ' +
          inputHeightClass() +
          ' ' +
          focusRingClass() +
          ' ' +
          fieldClass() +
          (pill() ? ' ' + pillFieldClass : '')
        "
        [attr.aria-keyshortcuts]="keyShortcuts() ?? null"
      />
      @if (pill()) {
        <!-- The icon host is display: contents, so the wrapper takes the position. -->
        <span
          class="pointer-events-none absolute start-4 top-1/2 flex -translate-y-1/2 text-(--text-on-brand-secondary)"
        >
          <aec-icon name="search" decorative [size]="5" />
        </span>
        @if (shortcutHint(); as hint) {
          <!-- Decorative: the shortcut is announced once, through aria-keyshortcuts
               on the field. The cap has no fill (a second wash fails on contrast),
               only a 1px edge. -->
          <kbd
            aria-hidden="true"
            class="aec-on-brand-keycap pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 rounded-mark border px-2 py-0.5 font-sans text-t-13 text-(--text-on-brand-secondary) transition-colors peer-hover:text-(--text-on-brand)"
            >{{ hint }}</kbd
          >
        }
      }

      <!--
        Aria's ComboboxPopup renders the listbox in-flow (DeferredContent.createEmbeddedView)
        and is NOT a floating layer; an outer cdkConnectedOverlay (usePopover:'inline' →
        browser top layer) supplies positioning, viewport-edge flip, and overflow-escape
        from the header row (ADR 0010). matchWidth is OFF: the dropdown keeps its explicit
        w-[min(22rem,…)] (the header input is only w-52, so matchWidth would truncate titles).
      -->
      <ng-template
        [cdkConnectedOverlay]="
          fitToViewport()
            ? fitOverlayConfig()
            : { origin: acOrigin, usePopover: 'inline', matchWidth: false }
        "
        [cdkConnectedOverlayOpen]="expanded()"
      >
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
              [style.max-height.px]="listMaxHeight()"
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
                    <span class="truncate text-sm font-semibold text-(--text-primary)">{{
                      s.title
                    }}</span>
                    <aec-chip density="dense" tone="quiet" class="shrink-0">{{
                      s.kind === 'product' ? productTag : vendorTag
                    }}</aec-chip>
                  </span>
                  @if (s.subtitle) {
                    <span class="truncate text-xs text-(--text-secondary)">{{ s.subtitle }}</span>
                  }
                </li>
              }
            </ul>
          }
        </ng-template>
      </ng-template>
    </ng-template>
  `,
})
export class SearchAutocomplete {
  /** Unique id so multiple instances (header + future hero) don't collide. */
  readonly inputId = input('aec-search-ac');
  /** Tailwind width utility for the input — header `w-52`, mobile `w-full`. */
  readonly inputClass = input('w-52');
  /**
   * The input's focus ring, as one complete utility set. The default is the 2px
   * Forest ring for a light ground. The header on Forest passes the Bone ring, so
   * the field carries exactly one ring set (AECI-1771).
   */
  readonly focusRingClass = input(
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)',
  );
  /** Optional placeholder override; defaults to the localized house copy. */
  readonly placeholder = input<string | undefined>(undefined);
  /** Optional label text (already localized); defaults to the house "Search". */
  readonly label = input<string | undefined>(undefined);
  /** Show `label` on screen instead of `sr-only`. The header keeps it hidden. */
  readonly labelVisible = input(false);
  /** Classes for a visible label. */
  readonly labelClass = input('mb-2 block text-sm font-semibold text-(--text-primary)');
  /** Tailwind height utility for the input. The header keeps `h-9`. */
  readonly inputHeightClass = input('h-9');
  /**
   * The field's surface: radius, edge, fill, padding, ink. The default is the
   * white field of a light ground. A mount on another ground passes its own set.
   */
  readonly fieldClass = input(DEFAULT_FIELD_CLASS);
  /**
   * The header pill on Forest (clash 29): a leading search glyph and room for a
   * shortcut cap. The caller still passes `fieldClass`, `inputHeightClass` and
   * `focusRingClass` for the ground it sits on.
   */
  readonly pill = input(false);
  /** The visible shortcut cap inside the pill (already localized). Decorative. */
  readonly shortcutHint = input<string | undefined>(undefined);
  /** The `aria-keyshortcuts` value on the field. Unset leaves the attribute off. */
  readonly keyShortcuts = input<string | undefined>(undefined);
  protected readonly pillFieldClass = PILL_FIELD_CLASS;
  /**
   * Which suggestion kinds to show. Unset (the default) shows products and
   * vendors, as the header does. The home pair finder passes `['product']`.
   */
  readonly kinds = input<readonly AutocompleteSuggestion['kind'][] | undefined>(undefined);
  /**
   * Wrap the field in its own `<form action="/search">` (the default). Set
   * `false` when a parent form owns submission, so the HTML never nests forms.
   * Formless, Enter still emits `querySubmitted`; the native submit belongs to
   * the parent.
   */
  readonly ownForm = input(true);
  /**
   * Accessible name of the owned `<form role="search">` (already localized).
   * Defaults to "Site search", the header's name. A mount that shares a page with
   * the header must pass a distinct one (AECI-830). Unused when `ownForm` is false.
   */
  readonly searchName = input<string>(DEFAULT_SEARCH_NAME);
  /**
   * Write the chosen suggestion's title into the field on commit. Off by default:
   * the header navigates away on a choice. The pair finder stays on the page, so
   * the field must show which product was picked.
   */
  readonly fillOnSelect = input(false);
  /**
   * Fit the suggestion list to the visible screen (AECI-1775). Off by default, so
   * the header pill, the home hero and the claim dialog keep the shipped
   * placement. The mobile menu sets it: there the field sits low in a panel that
   * scrolls while the page is locked, so a list that only opens downward runs off
   * the screen. With it set, the list opens below the field when there is room
   * and above it when there is more room there, its height is capped to the space
   * on that side (it scrolls inside), and it follows the field when a
   * `cdkScrollable` ancestor scrolls.
   */
  readonly fitToViewport = input(false);

  /** Emitted when Enter is pressed with no suggestion chosen → `/search?q=`. */
  readonly querySubmitted = output<string>();
  /** Emitted when a suggestion is committed → its detail page. */
  readonly suggestionChosen = output<AutocompleteSuggestion>();

  /** Combobox text value (two-way with `ngCombobox`). */
  protected readonly queryModel = signal('');
  /** Popup open state (two-way with `ngCombobox`; Aria closes on Escape/blur). */
  protected readonly expanded = signal(false);
  /** The `ngCombobox` directive, so a zero-hit collapse can write its model. */
  private readonly combobox = viewChild(Combobox);
  /** Listbox selection (two-way with `ngListbox`); reset after each commit. */
  protected readonly selected = signal<AutocompleteSuggestion[]>([]);
  /** Whether the input currently holds focus — gates opening on late responses. */
  protected readonly focused = signal(false);

  protected readonly productTag = $localize`:@@app.search.autocomplete.kind.product:Product`;
  protected readonly vendorTag = $localize`:@@app.search.autocomplete.kind.vendor:Vendor`;

  // "directory", not "integrations": the suggestions are products and vendors (AECI-985).
  private readonly defaultPlaceholder = $localize`:@@app.search.autocomplete.placeholder:Search directory`;
  protected readonly placeholderText = computed(
    () => this.placeholder() ?? this.defaultPlaceholder,
  );

  private readonly injector = inject(Injector);
  private readonly hostRef = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly scrollDispatcher = inject(ScrollDispatcher);
  /** The list's height cap while `fitToViewport` is set; null leaves the class cap. */
  protected readonly listMaxHeight = signal<number | null>(null);
  /** Open above the field: there is more room above than below. */
  private readonly listAbove = signal(false);
  private repositionStrategy: ScrollStrategy | undefined;

  /**
   * The overlay config for a `fitToViewport` mount. The side with more room comes
   * first and the other is the fallback. The reposition strategy moves the list
   * with the field when a registered scroll container scrolls. The default
   * mounts bind the literal config in the template, unchanged.
   */
  protected readonly fitOverlayConfig = computed(() => {
    this.repositionStrategy ??= createRepositionScrollStrategy(this.injector);
    const below: ConnectedPosition = {
      originX: 'start',
      originY: 'bottom',
      overlayX: 'start',
      overlayY: 'top',
      offsetY: LIST_GAP,
    };
    const above: ConnectedPosition = {
      originX: 'start',
      originY: 'top',
      overlayX: 'start',
      overlayY: 'bottom',
      offsetY: -LIST_GAP,
    };
    return {
      origin: this.inputEl(),
      usePopover: 'inline' as const,
      matchWidth: false,
      positions: this.listAbove() ? [above, below] : [below, above],
      scrollStrategy: this.repositionStrategy,
    };
  });

  private readonly factory = inject(AUTOCOMPLETE_SEARCH_FACTORY);
  private readonly analytics = inject(Analytics);
  private readonly destroyRef = inject(DestroyRef);
  /** The browser-only controller; a signal so the open-effect tracks it. */
  private readonly controller = signal<AutocompleteController | null>(null);
  private destroyed = false;

  /** Flat suggestion list (products then vendors) for the template. */
  protected readonly suggestions = computed<readonly AutocompleteSuggestion[]>(() => {
    const all = this.controller()?.suggestions() ?? [];
    const kinds = this.kinds();
    return kinds ? all.filter((s) => kinds.includes(s.kind)) : all;
  });

  constructor() {
    // Re-open the popup once a query settles with ≥1 hit AND the input is focused
    // — covers results that arrive after the popup was dismissed (Escape) while
    // still focused. Aria already expands on input, so this is not the only opener;
    // the empty case is handled by gating the listbox's *rendering* on a non-empty
    // result set (see template) and by the collapse effect below. Only ever OPENS
    // here — Escape/blur close via the two-way `expanded` model, and the effect
    // won't re-fire on those (it tracks `suggestions()`/`focused()`, which they
    // don't change), so Escape sticks until the result set next changes.
    effect(() => {
      if (this.suggestions().length > 0 && this.focused()) this.expanded.set(true);
    });

    // Expanded with nothing to show: collapse, so aria-expanded never points at
    // no listbox. Tracks `expanded()` because Aria re-expands on every keystroke.
    // Writes the directive's own model: setting only `this.expanded` back to the
    // value the binding last pushed (false) would never reach the combobox.
    effect(() => {
      if (this.expanded() && this.suggestions().length === 0) {
        this.combobox()?.expanded.set(false);
      }
    });

    // Browser-only: read the injected public config, load the lite SDK, start the
    // controller. Absent/failed config ⇒ the box stays a plain submit field.
    afterNextRender(() => {
      const config = readAlgoliaConfig();
      if (!config) return;
      void this.factory(config)
        .then((searchFn) => {
          if (this.destroyed) return;
          this.controller.set(
            // AECI-717: `autocomplete_searched`, consent-gated inside Analytics.
            new AutocompleteController(searchFn, (event) =>
              this.analytics.autocompleteSearched(event),
            ),
          );
        })
        .catch((error: unknown) => {
          // Autocomplete must never break the header — degrade silently.
          console.warn('Autocomplete failed to initialise', error);
        });
    });

    // fitToViewport: measure the room on each side when the list opens, and again
    // whenever a scroll container around the field scrolls.
    effect(() => {
      if (this.fitToViewport() && this.expanded()) this.fitList();
    });
    afterNextRender(() => {
      if (!this.fitToViewport()) return;
      const sub = this.scrollDispatcher
        .ancestorScrolled(this.hostRef, 0)
        .subscribe(() => this.fitList());
      this.destroyRef.onDestroy(() => sub.unsubscribe());
    });

    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.controller()?.dispose();
    });
  }

  private readonly inputEl = viewChild<ElementRef<HTMLInputElement>>('acOrigin');

  /** Move focus to the field. The header shortcut calls this. */
  focusInput(): void {
    this.inputEl()?.nativeElement.focus();
  }

  /** Whether the field is laid out (false while a breakpoint class hides it). */
  isVisible(): boolean {
    const el = this.inputEl()?.nativeElement;
    return !!el && el.getClientRects().length > 0;
  }

  /** Whether this field is the element holding focus. */
  isFocused(): boolean {
    const el = this.inputEl()?.nativeElement;
    return !!el && el.ownerDocument.activeElement === el;
  }

  /**
   * Pick the side with room and cap the list to it. The visible viewport is
   * used where the browser reports one, so a phone keyboard counts as taken
   * space. The cap is never above the shipped 24rem.
   */
  private fitList(): void {
    const el = this.inputEl()?.nativeElement;
    const view = el?.ownerDocument.defaultView;
    if (!el || !view) return;
    const rect = el.getBoundingClientRect();
    const top = view.visualViewport?.offsetTop ?? 0;
    const bottom = top + (view.visualViewport?.height ?? view.innerHeight);
    const below = bottom - rect.bottom - LIST_GAP - LIST_MARGIN;
    const above = rect.top - top - LIST_GAP - LIST_MARGIN;
    const useAbove = below < LIST_PREFERRED_MIN && above > below;
    this.listAbove.set(useAbove);
    this.listMaxHeight.set(Math.max(0, Math.min(LIST_MAX, Math.floor(useAbove ? above : below))));
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
    if (isReplayedEvent(event)) return; // the native default already ran
    const input = event.target as HTMLInputElement;
    if (input.getAttribute('aria-activedescendant')) return;
    event.preventDefault();
    this.expanded.set(false);
    this.querySubmitted.emit(input.value.trim());
  }

  /** Native form submit (no-JS base layer) → `/search?q=`. Under JS, Enter is
   * owned by `onEnterKey`; this still guards the post-commit suppression. */
  protected onSubmit(event: Event): void {
    if (isReplayedEvent(event)) return; // the native default already ran
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
    if (this.fillOnSelect()) this.queryModel.set(chosen.title);
    this.suggestionChosen.emit(chosen);
  }
}
