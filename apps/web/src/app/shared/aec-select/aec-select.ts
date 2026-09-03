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
 * One choice. `value` is `null` for an "any"/"none" row — several callers make
 * the control optional, so "no choice" has to be selectable and not merely the
 * initial state.
 */
export interface AecSelectOption {
  readonly value: string | null;
  readonly label: string;
}

/** Per-instance id seed, used only when the caller supplies no `idPrefix`.
 *  Browser-only (the control renders after its options load), so it never runs
 *  during SSR — but a caller rendering N instances from a list should pass
 *  `idPrefix` derived from the entity id rather than rely on this. */
let nextAecSelectId = 0;

/**
 * The app's discrete-choice "select" control.
 *
 * A non-editable Angular Aria combobox + listbox-in-overlay — the project's
 * standard for this pattern (ADR 0010), following `search/widgets/search-sort-by.ts`
 * exactly: Aria supplies keyboard and ARIA semantics, and a `cdkConnectedOverlay`
 * (`usePopover:'inline'` → browser top layer) supplies positioning and
 * overflow-escape, because `ComboboxPopup` renders its listbox in-flow.
 *
 * Presentational: the parent owns the value and the already-localized labels.
 *
 * Shipped for the admin panel as `AdminSelect` (AECI-577) and promoted here by
 * AECI-606, which needs the same control on the vendor dashboard's attestation
 * tab. It moved rather than being copied because the wiring is subtle enough
 * that two divergent copies is a real risk — the same reason
 * `search/mechanism-labels.ts` exists. Three inputs were added in the move, all
 * additive and all defaulting to the admin behaviour:
 *
 *  - `placeholder` — the admin filters always have an "Any …" row, so a blank
 *    trigger was acceptable there. A required field has no such row, and an
 *    unlabelled blank trigger is not.
 *  - `disabled` — a picker over an empty vocabulary must be visibly unusable
 *    rather than silently empty.
 *  - `idPrefix` — the module counter is fine for a filter bar, but the vendor tab
 *    renders one of these per claim, so ids there are derived from the claim id
 *    and are stable across re-renders.
 *  - `layout` — `inline` is the admin filter-bar row ("Source: [▾]"); `stacked`
 *    is the standard form-field block (label above, full-width trigger, popup
 *    width-matched to the field).
 */
@Component({
  selector: 'aec-select',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Combobox, ComboboxPopup, ComboboxWidget, Listbox, Option, OverlayModule],
  template: `
    <div [class]="wrapperClass()">
      <span [id]="labelId()" [class]="labelClass()">{{ label() }}</span>
      <div [class]="layout() === 'stacked' ? 'relative w-full' : 'relative'" #origin>
        <button
          ngCombobox
          #cb="ngCombobox"
          [id]="triggerId()"
          type="button"
          [disabled]="disabled()"
          [(expanded)]="expanded"
          [attr.aria-labelledby]="labelId() + ' ' + triggerId()"
          [attr.aria-describedby]="describedBy() || null"
          [class]="triggerClass()"
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
          [cdkConnectedOverlay]="{
            origin,
            usePopover: 'inline',
            matchWidth: layout() === 'stacked',
          }"
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
                  class="flex cursor-pointer items-start justify-between gap-3 rounded-(--radius-sm)
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
export class AecSelect {
  /** Already-localized control label, e.g. "Source". */
  readonly label = input.required<string>();
  readonly options = input.required<readonly AecSelectOption[]>();
  /** `null` = nothing chosen. */
  readonly value = input.required<string | null>();
  /** Shown in the trigger when `value` matches no option. Defaults to blank,
   *  which is right only where an explicit "Any …" option exists. */
  readonly placeholder = input('');
  /** Aria soft-disables: the trigger stays focusable and carries
   *  `aria-disabled="true"` rather than the native attribute. Style off the
   *  `aria-disabled:` variant, and do not assume a click is impossible. */
  readonly disabled = input(false);
  /** Stable id stem. Falls back to a module counter when omitted. */
  readonly idPrefix = input<string | null>(null);
  readonly layout = input<'inline' | 'stacked'>('inline');
  /** Id of an error/hint element to associate with the trigger. */
  readonly describedBy = input('');
  readonly changed = output<string | null>();

  /** `@for` track key for the null-valued "any" row. */
  protected readonly ANY = ' any';

  private readonly uid = nextAecSelectId++;
  private readonly idBase = computed(() => this.idPrefix() ?? `aec-select-${this.uid}`);
  protected readonly labelId = computed(() => `${this.idBase()}-label`);
  protected readonly triggerId = computed(() => `${this.idBase()}-trigger`);

  protected readonly expanded = signal(false);

  protected readonly wrapperClass = computed(() =>
    this.layout() === 'stacked' ? 'flex w-full flex-col gap-1.5' : 'inline-flex items-center gap-2',
  );

  protected readonly labelClass = computed(() =>
    this.layout() === 'stacked'
      ? 'block text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase'
      : 'text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase',
  );

  protected readonly triggerClass = computed(() => {
    // `aria-disabled:`, NOT `disabled:` — Aria soft-disables by default, so the
    // trigger keeps `tabindex="0"` and announces `aria-disabled="true"` without
    // ever taking the native attribute the `disabled:` variant keys off. That is
    // the better accessible behaviour (a disabled control stays discoverable),
    // but it means the obvious Tailwind variant silently never fires.
    const base =
      'flex items-center justify-between gap-2 rounded-(--radius-md) border' +
      ' border-(--border-default) bg-(--surface-base) text-sm text-(--text-primary)' +
      ' focus-visible:outline-2 focus-visible:outline-offset-2' +
      ' focus-visible:outline-(--accent-primary) aria-disabled:cursor-not-allowed' +
      ' aria-disabled:opacity-50';
    return this.layout() === 'stacked'
      ? `${base} w-full py-2 ps-3 pe-2`
      : `${base} min-w-[8rem] py-1.5 ps-3 pe-2`;
  });

  /** The selection bridged into Aria's array-valued listbox model, re-derived
   *  when the parent replaces `value` or `options` (both change when the window
   *  moves and the option lists are refetched). */
  protected readonly selection = linkedSignal<AecSelectOption[]>(() => {
    const current = this.value();
    const match = this.options().find((o) => o.value === current);
    return match ? [match] : [];
  });

  protected readonly triggerLabel = computed(
    () => this.options().find((o) => o.value === this.value())?.label ?? this.placeholder(),
  );

  protected onChange(): void {
    const chosen = this.selection()[0];
    this.expanded.set(false);
    if (chosen && chosen.value !== this.value()) this.changed.emit(chosen.value);
  }
}
