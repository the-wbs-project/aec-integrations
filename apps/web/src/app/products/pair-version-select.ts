import { Combobox, ComboboxPopup, ComboboxWidget } from '@angular/aria/combobox';
import { Listbox, Option } from '@angular/aria/listbox';
import { OverlayModule } from '@angular/cdk/overlay';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';

/** One selectable release. `released_at` is display-only — never an ordering input. */
export interface PairVersionOption {
  readonly label: string;
  readonly releasedAt: string | null;
}

/**
 * One of the product-PAIR page's two version selectors (AECI-303 / §9.1).
 *
 * A non-editable Angular Aria combobox + listbox-in-overlay, the project's standard
 * for discrete choice (ADR 0010), ported structurally from `admin/admin-select.ts`:
 * Aria supplies keyboard and ARIA semantics, and a `cdkConnectedOverlay`
 * (`usePopover: 'inline'` → the browser top layer) supplies positioning and
 * overflow-escape, because `ComboboxPopup` renders its listbox in-flow.
 *
 * ── TWO DELIBERATE DIVERGENCES FROM `admin-select` ──────────────────────────────
 *
 * 1. **Static, deterministic element ids.** `admin-select` and
 *    `search/widgets/search-sort-by.ts` both carry a module-level `let nextId = 0`
 *    counter, justified in their own comments by being browser-only. This control is
 *    the **first Aria combobox in the repo that SSRs**, and module state persists
 *    per Worker isolate — so a counter would emit ids that differ between the server
 *    render and the client, breaking the `aria-labelledby` association after
 *    hydration. There are exactly two of these on a page and each knows its own
 *    side, so the ids are derived from `side` and need no counter. (The rest of the
 *    SSR footprint is safe: the listbox lives inside
 *    `[cdkConnectedOverlayOpen]="expanded()"` so it is never created during SSR, and
 *    CDK's internal `_IdGenerator` is per-injector and deterministic.)
 * 2. **No "any" row.** A version is always selected — latest by default — so unlike
 *    the admin filters there is no "no filter" state to represent.
 *
 * Presentational: the parent owns the value, the localized label, and the URL write.
 * It renders nothing when there is nothing to choose (see `ProductsPairPage`, which
 * suppresses a side with fewer than two releases rather than showing a disabled
 * control).
 */
@Component({
  selector: 'aec-pair-version-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Combobox, ComboboxPopup, ComboboxWidget, Listbox, Option, OverlayModule],
  template: `
    <div class="inline-flex items-center gap-2">
      <span [id]="labelId()" class="aec-overline text-(--text-secondary)">{{ label() }}</span>
      <div #origin class="relative">
        <button
          ngCombobox
          #cb="ngCombobox"
          [id]="triggerId()"
          type="button"
          [(expanded)]="expanded"
          [attr.aria-labelledby]="labelId() + ' ' + triggerId()"
          class="flex min-w-[6rem] items-center justify-between gap-2 rounded-(--radius-md)
            border border-(--border-default) bg-(--surface-base) py-1.5 ps-3 pe-2 text-sm
            text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2
            focus-visible:outline-(--accent-primary)"
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
          floating layer + flip/overflow-escape, per ADR 0010. See admin-select.ts.
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
              [attr.aria-label]="label()"
              class="z-50 flex max-h-[18rem] min-w-[10rem] list-none flex-col gap-0.5
                overflow-y-auto rounded-(--radius-md) border border-(--border-default)
                bg-(--surface-raised) p-1.5 shadow-lg"
            >
              @for (opt of newestFirst(); track opt.label) {
                <li
                  ngOption
                  [value]="opt"
                  [label]="opt.label"
                  class="flex cursor-pointer items-center justify-between gap-3
                    rounded-(--radius-sm) px-3 py-2 text-sm text-(--text-primary)
                    data-[active=true]:bg-(--surface-sunken)"
                >
                  <span>{{ opt.label }}</span>
                  @if (opt.label === value()) {
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
export class PairVersionSelect {
  /**
   * Which endpoint this selector drives. Also the id seed — see the class doc for
   * why this is not a counter.
   */
  readonly side = input.required<'context' | 'other'>();
  /** Already-localized control label, e.g. "Revit version". */
  readonly label = input.required<string>();
  /**
   * The product's releases, **ascending** as the API sends them (the canonical
   * order). Reversed for display only; the control never re-sorts.
   */
  readonly options = input.required<readonly PairVersionOption[]>();
  /** The label the server actually resolved — not the raw query param. */
  readonly value = input.required<string | null>();
  readonly changed = output<string>();

  protected readonly labelId = computed(() => `pair-version-label-${this.side()}`);
  protected readonly triggerId = computed(() => `pair-version-trigger-${this.side()}`);

  protected readonly expanded = signal(false);

  /** Newest first, because that is how a reader scans releases. The wire order stays
   *  the source of truth for "latest"; this is presentation only. */
  protected readonly newestFirst = computed(() => [...this.options()].reverse());

  /** Bridged into Aria's array-valued listbox model (always an array, even
   *  single-select), re-derived when the parent replaces `value` or `options`. */
  protected readonly selection = linkedSignal<PairVersionOption[]>(() => {
    const current = this.value();
    const match = this.options().find((o) => o.label === current);
    return match ? [match] : [];
  });

  protected readonly triggerLabel = computed(() => this.value() ?? '');

  protected onChange(): void {
    const chosen = this.selection()[0];
    this.expanded.set(false);
    // The `!==` guard kills the echo when the parent re-feeds the same value.
    if (chosen && chosen.label !== this.value()) this.changed.emit(chosen.label);
  }
}
