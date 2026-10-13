/**
 * `aec-docs-search`, the per-guide docs search box (AECI-1270;
 * `docs/STAGE_2_PRODUCT_DOCS_SPEC.md` §3 "Search"). The shell mounts it under
 * the General / For vendors toggle with `[guide]="location().guide"`, so it
 * searches only the guide the reader is in: `guide:help` or `guide:vendor`.
 *
 * **Client only.** SSR renders a fixed-height empty slot, so the HTML is the
 * same for every visitor and the sidebar tree does not jump when the box
 * appears. After hydration `afterNextRender` reads the inline config
 * (`readDocsSearchConfig`). With no docs index in it (local dev, an
 * unprovisioned tier, HTML from before AECI-1270) the slot is removed and the
 * box never renders, as `/search` degrades. With one, `DOCS_SEARCH_FACTORY`
 * loads the lite client and the input appears in the slot.
 *
 * **A11y** follows `search-autocomplete.ts`: Angular Aria's `ngCombobox`,
 * `ngListbox` and `ngOption` give the roles, `aria-expanded`,
 * `aria-activedescendant` and the Arrow / Home / End / Escape model, and an outer
 * `cdkConnectedOverlay` with `usePopover: 'inline'` is the floating layer
 * (ADR 0010). The listbox renders only when there is a hit. With none, settled
 * or still in flight, the combobox collapses, so `aria-expanded` never points
 * at a listbox that does not exist (AECI-1308). A settled query with no hit shows
 * "No matching sections" as plain text under the input. A polite live region announces the count either way. A real `label` names the input.
 *
 * **Choosing a row** navigates to its page and heading anchor with an absolute
 * path, then clears the box. Enter with no row active takes the first row.
 * Highlights are text runs with matched ones in `mark` (`docs-search-hits.ts`).
 * Nothing is bound to `innerHTML`.
 *
 * Mobbin anchors: the DeepWiki field (screen 470ef8ee), a slim bordered input
 * with a leading magnifier, and Devin's results list (screen e37a4e69), a
 * section trail over each row and a grey active row. Light only, tokens only,
 * borders not shadows.
 */
import {
  Component,
  DestroyRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Combobox, ComboboxPopup, ComboboxWidget } from '@angular/aria/combobox';
import { Listbox, Option } from '@angular/aria/listbox';
import { OverlayModule } from '@angular/cdk/overlay';
import { Router } from '@angular/router';

import { readDocsSearchConfig } from '../search/algolia-config';
import type { DocsGuide } from './docs-content';
import { DOCS_SEARCH_FACTORY } from './docs-search.factory';
import type { DocsSearchFn, DocsSearchHit } from './docs-search-hits';

/** Search-as-you-type debounce, ms. The header autocomplete's value. */
export const DOCS_SEARCH_DEBOUNCE_MS = 180;

/** `pending` until hydration decides; `ready` with a client; `off` without config. */
type State = 'pending' | 'ready' | 'off';

@Component({
  selector: 'aec-docs-search',
  imports: [Combobox, ComboboxPopup, ComboboxWidget, Listbox, Option, OverlayModule],
  template: `
    @switch (state()) {
      @case ('pending') {
        <div class="mb-4 h-9" data-docs-search-slot></div>
      }
      @case ('ready') {
        <div class="mb-4" role="search" [attr.aria-label]="label()">
          <label [attr.for]="inputId" class="sr-only">{{ label() }}</label>
          <div class="relative">
            <svg
              aria-hidden="true"
              class="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-(--text-secondary)"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              ngCombobox
              #combobox="ngCombobox"
              #origin
              [id]="inputId"
              type="search"
              autocomplete="off"
              [(value)]="queryModel"
              [(expanded)]="expanded"
              (input)="onInput($event)"
              (keydown.enter)="onEnterKey($event)"
              (focus)="onFocus()"
              (blur)="focused.set(false)"
              [placeholder]="placeholder"
              class="h-9 w-full rounded-md border border-(--border-default) bg-(--surface-base) ps-8 pe-3 text-sm text-(--text-primary) placeholder:text-(--text-secondary) focus-visible:outline-2 [&::-webkit-search-cancel-button]:hidden focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            />
          </div>

          <!--
            Aria's popup is not a floating layer. The outer cdkConnectedOverlay
            (usePopover inline, the browser top layer) positions it, flips it at
            the viewport edge and lets it escape the sidebar's scroll box.
          -->
          <ng-template
            [cdkConnectedOverlay]="{ origin: origin, usePopover: 'inline', matchWidth: false }"
            [cdkConnectedOverlayOpen]="expanded()"
          >
            <ng-template ngComboboxPopup [combobox]="combobox" popupType="listbox">
              <!-- The panel renders only with a row, never blank. -->
              @if (hits().length > 0) {
                <div
                  class="w-[min(24rem,calc(100vw-2rem))] rounded-md border border-(--border-default) bg-(--surface-raised) p-1.5"
                >
                  <ul
                    ngComboboxWidget
                    ngListbox
                    #listbox="ngListbox"
                    [(value)]="selected"
                    (valueChange)="onSelect($event)"
                    [activeDescendant]="listbox.activeDescendant()"
                    focusMode="activedescendant"
                    selectionMode="explicit"
                    [attr.aria-label]="listLabel()"
                    class="m-0 flex max-h-[min(26rem,60vh)] list-none flex-col gap-0.5 overflow-y-auto p-0"
                  >
                    @for (hit of hits(); track hit.objectID) {
                      <li
                        ngOption
                        [value]="hit"
                        [label]="optionLabel(hit)"
                        class="flex cursor-pointer flex-col gap-0.5 rounded-sm px-3 py-2 data-[active=true]:bg-(--surface-sunken)"
                      >
                        <span class="truncate text-xs text-(--text-secondary)"
                          >{{ hit.section }} / {{ hit.pageTitle }}</span
                        >
                        <!-- Every run is an element, so no collapsed space lands between runs. -->
                        <span class="text-sm font-medium text-(--text-primary)">
                          @for (part of hit.heading; track $index) {
                            @if (part.match) {
                              <mark class="bg-transparent text-inherit underline">{{
                                part.text
                              }}</mark>
                            } @else {
                              <span>{{ part.text }}</span>
                            }
                          }
                        </span>
                        @if (hit.snippet.length > 0) {
                          <span class="line-clamp-2 text-xs text-(--text-secondary)">
                            @for (part of hit.snippet; track $index) {
                              @if (part.match) {
                                <mark class="bg-transparent font-medium text-(--text-primary)">{{
                                  part.text
                                }}</mark>
                              } @else {
                                <span>{{ part.text }}</span>
                              }
                            }
                          </span>
                        }
                      </li>
                    }
                  </ul>
                </div>
              }
            </ng-template>
          </ng-template>

          <!--
            No hit: plain text under the input, not a popup. The combobox stays
            collapsed, so it never claims a listbox that does not exist.
          -->
          @if (showEmpty()) {
            <p
              class="m-0 mt-1.5 px-1 text-xs text-(--text-secondary)"
              aria-hidden="true"
              i18n="@@app.docs.search.empty"
            >
              No matching sections
            </p>
          }

          <p class="sr-only" aria-live="polite" data-docs-search-status>{{ status() }}</p>
        </div>
      }
    }
  `,
})
export class DocsSearchComponent {
  /** The guide the reader is in. Picks the filter and the label. */
  readonly guide = input.required<DocsGuide>();

  protected readonly inputId = 'aec-docs-search';
  protected readonly placeholder = $localize`:@@app.docs.search.placeholder:Search`;

  protected readonly state = signal<State>('pending');
  protected readonly queryModel = signal('');
  protected readonly expanded = signal(false);
  /** The `ngCombobox` directive, so an empty collapse can write its model. */
  private readonly combobox = viewChild(Combobox);
  protected readonly selected = signal<DocsSearchHit[]>([]);
  protected readonly focused = signal(false);

  private readonly results = signal<readonly DocsSearchHit[]>([]);
  private readonly settled = signal(false);
  protected readonly hits = this.results.asReadonly();

  protected readonly label = computed(() =>
    this.guide() === 'vendor'
      ? $localize`:@@app.docs.search.label.vendor:Search For vendors`
      : $localize`:@@app.docs.search.label.general:Search General`,
  );
  protected readonly listLabel = computed(() =>
    this.guide() === 'vendor'
      ? $localize`:@@app.docs.search.list.vendor:Matching sections in For vendors`
      : $localize`:@@app.docs.search.list.general:Matching sections in General`,
  );

  /** The settled, non-blank query found nothing. */
  protected readonly showEmpty = computed(
    () => this.settled() && this.results().length === 0 && this.queryModel().trim() !== '',
  );

  /** What the live region says once a query settles. */
  protected readonly status = computed(() => {
    if (!this.settled() || this.queryModel().trim() === '') return '';
    const count = this.results().length;
    if (count === 0) return $localize`:@@app.docs.search.status.none:No matching sections`;
    if (count === 1) return $localize`:@@app.docs.search.status.one:1 matching section`;
    return $localize`:@@app.docs.search.status.many:${count}:count: matching sections`;
  });

  private readonly factory = inject(DOCS_SEARCH_FACTORY);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private searchFn: DocsSearchFn | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic request id. A response is used only while it is the latest. */
  private seq = 0;
  private destroyed = false;
  /** Set while an option commits, so the Enter that chose it does nothing else. */
  private committing = false;

  constructor() {
    afterNextRender(() => {
      const config = readDocsSearchConfig();
      if (!config) {
        this.state.set('off');
        return;
      }
      void this.factory(config)
        .then((searchFn) => {
          if (this.destroyed) return;
          this.searchFn = searchFn;
          this.state.set('ready');
        })
        .catch((error: unknown) => {
          // Search must never break the docs. Degrade to no box.
          console.warn('Docs search failed to initialise', error);
          if (!this.destroyed) this.state.set('off');
        });
    });

    // A guide switch is a different search space: start over.
    effect(() => {
      this.guide();
      untracked(() => this.reset());
    });

    // Re-open when results land while the input still has focus.
    effect(() => {
      if (this.results().length > 0 && this.focused()) this.expanded.set(true);
    });

    // Expanded with no row, before results land or after none matched: collapse,
    // so aria-expanded never points at no listbox (AECI-1308). Aria re-expands on
    // every keystroke, hence tracking `expanded()`. Writes the directive's own
    // model: the binding would not re-push a value it already sent.
    effect(() => {
      if (this.expanded() && this.results().length === 0) {
        this.combobox()?.expanded.set(false);
      }
    });

    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      this.clearTimer();
      this.seq++;
    });
  }

  protected optionLabel(hit: DocsSearchHit): string {
    return hit.heading.map((part) => part.text).join('');
  }

  protected onInput(event: Event): void {
    this.setQuery((event.target as HTMLInputElement).value);
  }

  protected onFocus(): void {
    this.focused.set(true);
    if (this.queryModel().trim() && this.results().length > 0) {
      this.expanded.set(true);
    }
  }

  /**
   * Enter. Aria commits an active option itself (then `onSelect` runs), so
   * this yields when one is active. With none active it takes the first row.
   */
  protected onEnterKey(event: Event): void {
    const field = event.target as HTMLInputElement;
    event.preventDefault();
    if (this.committing || field.getAttribute('aria-activedescendant')) return;
    const first = this.results()[0];
    if (first) this.go(first);
  }

  protected onSelect(values: DocsSearchHit[]): void {
    const chosen = values.at(-1);
    if (!chosen) return; // the reset to [] below re-enters here
    this.committing = true;
    queueMicrotask(() => (this.committing = false));
    this.go(chosen);
  }

  private go(hit: DocsSearchHit): void {
    void this.router.navigate([hit.path], hit.fragment ? { fragment: hit.fragment } : {});
    this.reset();
  }

  private setQuery(value: string): void {
    this.queryModel.set(value);
    this.clearTimer();
    const query = value.trim();
    this.seq++;
    if (!query || !this.searchFn) {
      this.results.set([]);
      this.settled.set(false);
      this.expanded.set(false);
      return;
    }
    this.timer = setTimeout(() => this.run(query), DOCS_SEARCH_DEBOUNCE_MS);
  }

  private run(query: string): void {
    const mine = this.seq;
    const searchFn = this.searchFn;
    if (!searchFn) return;
    searchFn(query, this.guide())
      .then((hits) => {
        if (mine !== this.seq) return;
        this.results.set(hits);
        this.settled.set(true);
      })
      .catch(() => {
        if (mine !== this.seq) return;
        this.results.set([]);
        this.settled.set(true);
      });
  }

  private reset(): void {
    this.clearTimer();
    this.seq++;
    this.queryModel.set('');
    this.results.set([]);
    this.settled.set(false);
    this.expanded.set(false);
    this.selected.set([]);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
