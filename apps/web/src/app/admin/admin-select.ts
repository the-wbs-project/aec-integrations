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

/**
 * One choice. `value` is `null` for the "any" row — the admin filters are all
 * optional, so "no filter" has to be selectable and not merely the initial state.
 */
export interface AdminSelectOption {
  readonly value: string | null;
  readonly label: string;
}

/** Per-instance id seed so label↔trigger association stays unique when several
 *  selects share a filter bar. Browser-only (the control renders after the feed
 *  loads its options), so this never runs during SSR. */
let nextAdminSelectId = 0;

/**
 * A discrete-choice filter control for the admin panel (AECI-577).
 *
 * A non-editable Angular Aria combobox + listbox-in-overlay — the project's
 * standard for this pattern (ADR 0010) — following `search/widgets/search-sort-by.ts`
 * exactly: Aria supplies keyboard and ARIA semantics, and a `cdkConnectedOverlay`
 * (`usePopover:'inline'` → browser top layer) supplies positioning and
 * overflow-escape, because `ComboboxPopup` renders its listbox in-flow.
 *
 * Presentational: the parent owns the value and the already-localized labels.
 * It exists as a shared component because the Activity feed needs two of these
 * and §5.3–§5.5 will need more.
 */
@Component({
  selector: 'aec-admin-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Combobox, ComboboxPopup, ComboboxWidget, Listbox, Option, OverlayModule],
  template: `
    <div class="inline-flex items-center gap-2">
      <span
        [id]="labelId"
        class="text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase"
        >{{ label() }}</span
      >
      <div #origin class="relative">
        <button
          ngCombobox
          #cb="ngCombobox"
          [id]="triggerId"
          type="button"
          [(expanded)]="expanded"
          [attr.aria-labelledby]="labelId + ' ' + triggerId"
          class="flex min-w-[8rem] items-center justify-between gap-2 rounded-(--radius-md)
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
          floating layer + flip/overflow-escape, per ADR 0010. See search-sort-by.ts.
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
              class="z-50 flex max-h-[18rem] min-w-[12rem] list-none flex-col gap-0.5
                overflow-y-auto rounded-(--radius-md) border border-(--border-default)
                bg-(--surface-raised) p-1.5 shadow-lg"
            >
              @for (opt of options(); track opt.value ?? ANY) {
                <li
                  ngOption
                  [value]="opt"
                  [label]="opt.label"
                  class="flex cursor-pointer items-center justify-between rounded-(--radius-sm)
                    px-3 py-2 text-sm text-(--text-primary) data-[active=true]:bg-(--surface-sunken)"
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
export class AdminSelect {
  /** Already-localized control label, e.g. "Source". */
  readonly label = input.required<string>();
  readonly options = input.required<readonly AdminSelectOption[]>();
  /** `null` = no filter. */
  readonly value = input.required<string | null>();
  readonly changed = output<string | null>();

  /** `@for` track key for the null-valued "any" row. */
  protected readonly ANY = ' any';

  private readonly uid = nextAdminSelectId++;
  protected readonly labelId = `admin-select-label-${this.uid}`;
  protected readonly triggerId = `admin-select-trigger-${this.uid}`;

  protected readonly expanded = signal(false);

  /** The selection bridged into Aria's array-valued listbox model, re-derived
   *  when the parent replaces `value` or `options` (both change when the window
   *  moves and the option lists are refetched). */
  protected readonly selection = linkedSignal<AdminSelectOption[]>(() => {
    const current = this.value();
    const match = this.options().find((o) => o.value === current);
    return match ? [match] : [];
  });

  protected readonly triggerLabel = computed(
    () => this.options().find((o) => o.value === this.value())?.label ?? '',
  );

  protected onChange(): void {
    const chosen = this.selection()[0];
    this.expanded.set(false);
    if (chosen && chosen.value !== this.value()) this.changed.emit(chosen.value);
  }
}
