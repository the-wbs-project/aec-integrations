import { Component, computed, input, linkedSignal, output, signal } from '@angular/core';
import { Combobox, ComboboxPopup, ComboboxWidget } from '@angular/aria/combobox';
import { Listbox, Option } from '@angular/aria/listbox';
import { OverlayModule } from '@angular/cdk/overlay';

/** One sort choice the widget renders. `value` is the Algolia index name passed
 *  back through `(sort)`; `label` is the already-localized display string. */
export interface SortUiOption {
  readonly value: string;
  readonly label: string;
}

/** Per-instance id seed so the label↔trigger association is unique if two sort
 *  controls ever co-exist. The control is created browser-side only (its options
 *  come from the loaded controller), so this counter never runs during SSR. */
let nextSortById = 0;

/**
 * Per-tab sort control on `/search` (AECI-175 / §4.6). A non-editable Angular
 * Aria combobox + listbox-in-overlay — the project's standard discrete-choice
 * control (ADR 0010), mirroring the role picker in `reviews/review-form.html`:
 * Aria supplies the keyboard + ARIA semantics, while a `cdkConnectedOverlay`
 * (`usePopover:'inline'` → browser top layer) supplies positioning and
 * overflow-escape, since `ComboboxPopup` renders its listbox in-flow.
 *
 * Presentation-only: the parent owns the source of truth (`value` = the active
 * Algolia index name, from `IndexView.sortBy`) and the localized option labels;
 * the widget emits the chosen index name on `(sort)`. `selection` bridges the
 * parent `value` into Aria's array-valued `[(value)]` model and re-derives when
 * the parent switches tab (new `value`/`options`).
 */
@Component({
  selector: 'aec-search-sort-by',
  imports: [Combobox, ComboboxPopup, ComboboxWidget, Listbox, Option, OverlayModule],
  template: `
    <div class="inline-flex items-center gap-2">
      <span [id]="labelId" class="text-sm text-(--text-secondary)" i18n="@@search.sort.label"
        >Sort</span
      >
      <div #origin class="relative">
        <button
          ngCombobox
          #cb="ngCombobox"
          [id]="triggerId"
          type="button"
          [(expanded)]="expanded"
          [attr.aria-labelledby]="labelId + ' ' + triggerId"
          class="flex items-center justify-between gap-2 rounded-(--radius-md) border border-(--border-default)
            bg-(--surface-base) py-1.5 ps-3 pe-2 text-sm text-(--text-primary)
            focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        >
          <span>{{ triggerLabel() }}</span>
          <svg
            class="h-4 w-4 shrink-0 text-(--text-secondary)"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        <!--
          ComboboxPopup renders the listbox in-flow (DeferredContent.createEmbeddedView),
          so an outer cdkConnectedOverlay (usePopover:'inline' → top layer) supplies the
          floating layer + flip/overflow-escape, per ADR 0010. See review-form.html.
        -->
        <ng-template
          [cdkConnectedOverlay]="{ origin, usePopover: 'inline' }"
          [cdkConnectedOverlayOpen]="expanded()"
        >
          <ng-template ngComboboxPopup [combobox]="cb" popupType="listbox">
            <ul
              ngComboboxWidget
              ngListbox
              #listbox="ngListbox"
              [(value)]="selection"
              (valueChange)="onChange()"
              [activeDescendant]="listbox.activeDescendant()"
              focusMode="activedescendant"
              selectionMode="explicit"
              i18n-aria-label="@@search.sort.listbox.aria"
              aria-label="Sort results"
              class="z-50 flex min-w-[12rem] list-none flex-col gap-0.5 overflow-y-auto rounded-(--radius-md)
                border border-(--border-default) bg-(--surface-raised) p-1.5 shadow-lg"
            >
              @for (opt of options(); track opt.value) {
                <li
                  ngOption
                  [value]="opt"
                  [label]="opt.label"
                  class="flex cursor-pointer items-center justify-between rounded-(--radius-sm) px-3 py-2 text-sm
                    text-(--text-primary) data-[active=true]:bg-(--surface-sunken)"
                >
                  <span>{{ opt.label }}</span>
                  @if (value() === opt.value) {
                    <span aria-hidden="true" class="text-(--accent-primary)">✓</span>
                  }
                </li>
              }
            </ul>
          </ng-template>
        </ng-template>
      </div>
    </div>
  `,
})
export class SearchSortBy {
  /** Available sorts (relevance first), with already-localized labels. */
  readonly options = input.required<readonly SortUiOption[]>();
  /** The active sort = the current Algolia index name (the tab's `sortBy`). */
  readonly value = input.required<string>();
  /** Emits the chosen option's index name. */
  readonly sort = output<string>();

  private readonly uid = nextSortById++;
  protected readonly labelId = `search-sort-label-${this.uid}`;
  protected readonly triggerId = `search-sort-trigger-${this.uid}`;

  /** Popup open state (two-way with `ngCombobox`). */
  protected readonly expanded = signal(false);

  /**
   * The selected option bridged into Aria's array-valued listbox model. Derived
   * from the parent `value` + `options`, so switching tab (new inputs) re-selects
   * the right row; written by the listbox on user selection.
   */
  protected readonly selection = linkedSignal<SortUiOption[]>(() => {
    const current = this.value();
    const match = this.options().find((option) => option.value === current);
    return match ? [match] : [];
  });

  /** Label shown in the trigger — the active sort's label. */
  protected readonly triggerLabel = computed(
    () => this.options().find((option) => option.value === this.value())?.label ?? '',
  );

  /** Commit a selection: close the popup and emit the chosen index name. Guarded
   *  against the echo when the parent re-feeds the same `value` post-refine. */
  protected onChange(): void {
    const chosen = this.selection()[0];
    this.expanded.set(false);
    if (chosen && chosen.value !== this.value()) this.sort.emit(chosen.value);
  }
}
