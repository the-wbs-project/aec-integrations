import {
  Component,
  computed,
  inject,
  Injectable,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { Combobox, ComboboxPopup, ComboboxWidget } from '@angular/aria/combobox';
import { Listbox, Option } from '@angular/aria/listbox';
import { OverlayModule } from '@angular/cdk/overlay';

/** One sort choice the control renders. `value` is handed back through
 *  `(sortChange)`: a `?sort=` key on `/products`, an Algolia index name on
 *  `/search`. `label` is the already-localized display string. */
export interface ListingSortOption {
  readonly value: string;
  readonly label: string;
}

/**
 * Per-render id seed for the label ↔ trigger association. The control SSRs on
 * `/products` and the taxonomy browse pages, so its ids must match between the
 * server render and hydration. A module-level counter does not: module state
 * lives for the whole Worker isolate, so the server's count climbs across
 * requests while the client starts at 0 (`products/pair-version-select.ts` makes
 * the same point). A root service is per render instead: SSR bootstraps a fresh
 * application, and so a fresh root injector, for every request, and SSR and
 * hydration construct the controls in the same order.
 */
@Injectable({ providedIn: 'root' })
export class ListingSortIds {
  private next = 0;
  take(): number {
    return this.next++;
  }
}

/**
 * The sort control on every listing: `/products`, the four taxonomy browse pages
 * (both through `aec-listing-toolbar`) and `/search`. Ruled on 2026-10-26: one
 * control everywhere, the `/search` one (`DESIGN.md` "The Same-Behavior Rule").
 *
 * A non-editable Angular Aria combobox + listbox-in-overlay, the project's
 * standard discrete-choice control (ADR 0010), mirroring the role picker in
 * `reviews/review-form.html`: Aria supplies the keyboard + ARIA semantics, while
 * a `cdkConnectedOverlay` (`usePopover:'inline'` → browser top layer) supplies
 * positioning and overflow-escape, since `ComboboxPopup` renders its listbox
 * in-flow. The listbox only exists while the popup is open, so SSR renders the
 * label and the closed trigger and nothing else.
 *
 * Presentation-only: the host owns the source of truth and the localized option
 * labels, and the control emits the chosen `value` on `(sortChange)`.
 * `selection` bridges the host `value` into Aria's array-valued `[(value)]`
 * model and re-derives when the host switches tab (new `value`/`options`).
 */
@Component({
  selector: 'aec-listing-sort-select',
  imports: [Combobox, ComboboxPopup, ComboboxWidget, Listbox, Option, OverlayModule],
  template: `
    <div class="inline-flex items-center gap-2">
      <span
        [id]="labelId"
        class="text-sm text-(--text-secondary)"
        i18n="@@listing.toolbar.sort.label"
        >Sort</span
      >
      <div #origin class="relative">
        <!-- py-2.5 is not arbitrary: it makes the trigger 42px, matching the view
             toggle beside it (2px border + 8px p-1 + 12px py-1.5 + 20px text-sm
             line box). Change one side and change the other. -->
        <button
          ngCombobox
          #cb="ngCombobox"
          [id]="triggerId"
          type="button"
          [(expanded)]="expanded"
          [attr.aria-labelledby]="labelId + ' ' + triggerId"
          class="flex items-center justify-between gap-2 rounded-(--radius-md) border border-(--border-default)
            bg-(--surface-base) py-2.5 ps-3 pe-3 text-sm text-(--text-primary)
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
              i18n-aria-label="@@listing.sort.listbox.aria"
              aria-label="Sort"
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
export class ListingSortSelect {
  /** Available sorts, in display order, with already-localized labels. */
  readonly options = input.required<readonly ListingSortOption[]>();
  /** The active sort's `value`. */
  readonly value = input.required<string>();
  /** Emits the chosen option's `value`. The host validates it and applies it. */
  readonly sortChange = output<string>();

  private readonly uid = inject(ListingSortIds).take();
  protected readonly labelId = `aec-listing-sort-label-${this.uid}`;
  protected readonly triggerId = `aec-listing-sort-${this.uid}`;

  /** Popup open state (two-way with `ngCombobox`). */
  protected readonly expanded = signal(false);

  /**
   * The selected option bridged into Aria's array-valued listbox model. Derived
   * from the host `value` + `options`, so switching tab (new inputs) re-selects
   * the right row; written by the listbox on user selection.
   */
  protected readonly selection = linkedSignal<ListingSortOption[]>(() => {
    const current = this.value();
    const match = this.options().find((option) => option.value === current);
    return match ? [match] : [];
  });

  /** Label shown in the trigger — the active sort's label. */
  protected readonly triggerLabel = computed(
    () => this.options().find((option) => option.value === this.value())?.label ?? '',
  );

  /** Commit a selection: close the popup and emit the chosen value. Guarded
   *  against the echo when the host re-feeds the same `value` afterwards. */
  protected onChange(): void {
    const chosen = this.selection()[0];
    this.expanded.set(false);
    if (chosen && chosen.value !== this.value()) this.sortChange.emit(chosen.value);
  }
}
